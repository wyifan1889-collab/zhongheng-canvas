param(
    [string]$ProjectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..')),
    [string]$EvidenceDirectory = 'E:\codex-画布\evidence\quality-gate-r1'
)

$ErrorActionPreference = 'Stop'
$utf8NoBom = [System.Text.UTF8Encoding]::new($false)
$gatePath = Join-Path $ProjectRoot 'scripts\saas\verify-workflow.ps1'
$allowlistPath = Join-Path $ProjectRoot 'typecheck-baseline.allowlist.tsv'
$baselinePath = Join-Path $ProjectRoot 'typecheck-baseline.txt'
$source = [System.IO.File]::ReadAllText($gatePath, $utf8NoBom)
$start = $source.IndexOf('function Get-TypecheckDiagnostics {', [System.StringComparison]::Ordinal)
$end = $source.IndexOf('$initialReport = @(', [System.StringComparison]::Ordinal)
if ($start -lt 0 -or $end -le $start) { throw '无法从 verify-workflow.ps1 提取类型检查门禁函数。' }
Invoke-Expression $source.Substring($start, $end - $start)

function Assert-Throws {
    param([scriptblock]$Action, [string]$Name)
    try {
        & $Action
        throw "$Name 应失败，但门禁通过。"
    } catch {
        if ($_.Exception.Message -like "$Name 应失败*") { throw }
    }
}

function Invoke-Gate {
    param([string[]]$Lines, [int]$ExitCode)
    return Assert-TypecheckBaseline ([pscustomobject]@{
        Started = $true
        ExitCode = $ExitCode
        Lines = @($Lines)
    }) $allowlistPath
}

$baselineLines = [System.IO.File]::ReadAllLines($baselinePath, $utf8NoBom)
$headerLines = @($baselineLines | Where-Object { $_ -match '^.+\(\d+,\d+\): error TS\d+: ' })
$parsed = Get-TypecheckDiagnostics $baselineLines
$exact = Invoke-Gate $baselineLines 2
if ($parsed.Unparsed.Count -ne 0 -or $parsed.Diagnostics.Count -ne 69 -or $exact.ErrorCount -ne 69 -or $exact.BaselineEntryCount -ne 33 -or $exact.ExitCode -ne 2) {
    throw "Round15 精确基线不匹配：diagnostics=$($parsed.Diagnostics.Count), unparsed=$($parsed.Unparsed.Count), entries=$($exact.BaselineEntryCount), exit=$($exact.ExitCode)。"
}

$newKey = @($headerLines + 'src/quality-gate/new.ts(1,1): error TS9999: New diagnostic must fail.')
Assert-Throws { Invoke-Gate $newKey 2 } '新诊断键'

$countIncrease = @($headerLines + $headerLines[0])
Assert-Throws { Invoke-Gate $countIncrease 2 } '诊断次数增加'

$staleKey = @($headerLines + "src/services/saas/canvas-document-mount.ts(77,20): error TS18046: 'value' is of type 'unknown'.")
Assert-Throws { Invoke-Gate $staleKey 2 } '已消除诊断回归'

Assert-Throws { Invoke-Gate $headerLines 0 } '有诊断但 exit0'
$clean = Invoke-Gate @() 0
if ($clean.ErrorCount -ne 0 -or $clean.ExitCode -ne 0) { throw '零诊断且 exit0 未保持通过。' }
Assert-Throws { Invoke-Gate @() 2 } '零诊断但非0'

$summary = [ordered]@{
    baseline = 'Round15 ts-main-after.txt'
    diagnostics = $parsed.Diagnostics.Count
    keys = $exact.BaselineEntryCount
    tscExitCode = $exact.ExitCode
    newKeyRejected = $true
    countIncreaseRejected = $true
    staleDiagnosticRejected = $true
    diagnosticsWithExit0Rejected = $true
    cleanExit0Accepted = $true
    cleanNonZeroRejected = $true
}
New-Item -ItemType Directory -Force -Path $EvidenceDirectory | Out-Null
[System.IO.File]::WriteAllText((Join-Path $EvidenceDirectory 'typecheck-baseline-gate-summary.json'), ($summary | ConvertTo-Json -Depth 4) + "`n", $utf8NoBom)
$summary | ConvertTo-Json -Compress
