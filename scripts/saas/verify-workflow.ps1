param(
    [string]$ApiBaseUrl = 'http://127.0.0.1:4011',
    [switch]$RequireRuntime
)

$ErrorActionPreference = 'Stop'
$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$bunExecutable = Join-Path $projectRoot '.tools\bun-1.4.2\bun-windows-x64\bun.exe'
$reportDirectory = Join-Path $projectRoot 'docs\test-results'
$reportFile = Join-Path $reportDirectory 'latest-workflow-check.txt'
$typecheckAllowlistFile = Join-Path $projectRoot 'typecheck-baseline.allowlist.tsv'

if (-not (Test-Path -LiteralPath $bunExecutable)) {
    throw 'Bun 1.4.2 不存在，请先恢复本地运行环境。'
}
New-Item -ItemType Directory -Force -Path $reportDirectory | Out-Null
$utf8NoBom = [System.Text.UTF8Encoding]::new($false)
$utf8Bom = [System.Text.UTF8Encoding]::new($true)

function Write-ReportLines {
    param([object[]]$Lines)
    foreach ($line in $Lines) {
        [System.IO.File]::AppendAllText(
            $reportFile,
            ([string]$line) + [Environment]::NewLine,
            $utf8NoBom
        )
    }
}

function Write-OutputAndReport {
    param([object[]]$Lines)
    foreach ($line in $Lines) {
        Write-Output $line
        Write-ReportLines @($line)
    }
}

function Invoke-BunTest {
    param([string[]]$Arguments)
    # Use ProcessStartInfo so Windows PowerShell does not reinterpret Bun's
    # stderr as an ErrorRecord or drop it from the saved report.
    $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $bunExecutable
    $startInfo.WorkingDirectory = (Get-Location).Path
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $startInfo.StandardOutputEncoding = $utf8NoBom
    $startInfo.StandardErrorEncoding = $utf8NoBom
    $startInfo.Arguments = (($Arguments | ForEach-Object {
        '"' + ($_ -replace '"', '\"') + '"'
    }) -join ' ')
    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    $null = $process.Start()
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    $process.WaitForExit()
    $stdout = $stdoutTask.Result
    $stderr = $stderrTask.Result
    $exitCode = $process.ExitCode
    $process.Dispose()
    $lines = @()
    if ($stdout.Length -gt 0) {
        $lines += $stdout -split "`r?`n" | Where-Object { $_.Length -gt 0 }
    }
    if ($stderr.Length -gt 0) {
        $lines += $stderr -split "`r?`n" | Where-Object { $_.Length -gt 0 }
    }
    # Return the captured output before asserting. The caller writes it to the
    # report first, so a failing test cannot erase the diagnostic evidence.
    return [pscustomobject]@{
        ExitCode = $exitCode
        Lines = @($lines)
        Started = $true
    }
}

function Invoke-BunCommand {
    param(
        [string]$WorkingDirectory,
        [string[]]$Arguments
    )
    $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $bunExecutable
    $startInfo.WorkingDirectory = $WorkingDirectory
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $startInfo.StandardOutputEncoding = $utf8NoBom
    $startInfo.StandardErrorEncoding = $utf8NoBom
    $startInfo.Arguments = (($Arguments | ForEach-Object {
        '"' + ($_ -replace '"', '\"') + '"'
    }) -join ' ')
    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    $null = $process.Start()
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    $process.WaitForExit()
    $stdout = $stdoutTask.Result
    $stderr = $stderrTask.Result
    $exitCode = $process.ExitCode
    $process.Dispose()
    $lines = @()
    if ($stdout.Length -gt 0) { $lines += $stdout -split "`r?`n" | Where-Object { $_.Length -gt 0 } }
    if ($stderr.Length -gt 0) { $lines += $stderr -split "`r?`n" | Where-Object { $_.Length -gt 0 } }
    return [pscustomobject]@{ ExitCode = $exitCode; Lines = @($lines); Started = $true }
}

function Get-TypecheckDiagnostics {
    param([string[]]$Lines)
    $diagnostics = @()
    $unparsed = @()
    foreach ($line in $Lines) {
        $match = [regex]::Match(
            [string]$line,
            '^(?<file>.+)\((?<line>\d+),(?<column>\d+)\): error (?<code>TS\d+): (?<message>.*)$'
        )
        if ($match.Success) {
            # Line and column are intentionally omitted from the identity. A
            # moved diagnostic is still the same baseline diagnostic.
            $diagnostics += [pscustomobject]@{
                File = $match.Groups['file'].Value
                Code = $match.Groups['code'].Value
                Message = $match.Groups['message'].Value
            }
            continue
        }
        if ([regex]::IsMatch([string]$line, 'error TS\d+:')) {
            $unparsed += [string]$line
        }
    }
    return [pscustomobject]@{
        Diagnostics = @($diagnostics)
        Unparsed = @($unparsed)
    }
}

function Read-TypecheckAllowlist {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) {
        throw "找不到版本管理的 typecheck 允许清单：$Path"
    }
    $entries = @{}
    $lineNumber = 0
    foreach ($line in [System.IO.File]::ReadAllLines($Path, $utf8NoBom)) {
        $lineNumber++
        if ([string]::IsNullOrWhiteSpace($line) -or $line.StartsWith('#')) { continue }
        $fields = $line -split "`t", 4
        if ($fields.Count -ne 4) {
            throw "typecheck 允许清单第 $lineNumber 行格式无效，应为 count<TAB>file<TAB>code<TAB>message。"
        }
        $count = 0
        if (-not [int]::TryParse($fields[0], [ref]$count) -or $count -le 0) {
            throw "typecheck 允许清单第 $lineNumber 行 count 无效。"
        }
        if ($fields[1].Length -eq 0 -or $fields[2] -notmatch '^TS\d+$' -or $fields[3].Length -eq 0) {
            throw "typecheck 允许清单第 $lineNumber 行诊断键无效。"
        }
        $key = "$($fields[1])|$($fields[2])|$($fields[3])"
        if ($entries.ContainsKey($key)) {
            throw "typecheck 允许清单存在重复诊断键：$key"
        }
        $entries[$key] = $count
    }
    if ($entries.Count -eq 0) { throw 'typecheck 允许清单为空。' }
    return $entries
}

function Assert-TypecheckBaseline {
    param(
        [pscustomobject]$Result,
        [string]$AllowlistPath
    )
    if ($null -eq $Result -or $Result.Started -ne $true) {
        throw 'Web typecheck 未确认启动，拒绝通过。'
    }
    $allowlist = Read-TypecheckAllowlist $AllowlistPath
    $parsed = Get-TypecheckDiagnostics $Result.Lines
    $actual = @{}
    foreach ($diagnostic in $parsed.Diagnostics) {
        $key = "$($diagnostic.File)|$($diagnostic.Code)|$($diagnostic.Message)"
        if ($actual.ContainsKey($key)) { $actual[$key]++ } else { $actual[$key] = 1 }
    }
    if ($parsed.Unparsed.Count -gt 0) {
        throw "Web typecheck 有无法纳入 file+code+message 允许清单的诊断（$($parsed.Unparsed.Count) 条）。"
    }
    $actualTotal = ($actual.Values | Measure-Object -Sum).Sum
    if ($null -eq $actualTotal) { $actualTotal = 0 }
    $newDiagnostics = @(
        $actual.GetEnumerator() | Where-Object {
            (-not $allowlist.ContainsKey($_.Key)) -or ([int]$_.Value -gt [int]$allowlist[$_.Key])
        }
    )
    if ($newDiagnostics.Count -gt 0) {
        $details = $newDiagnostics | ForEach-Object { "$($_.Key) (actual=$($_.Value), allowed=$($allowlist[$_.Key]))" }
        throw "Web typecheck 出现新增诊断或同一诊断次数增加：$($details -join '; ')"
    }
    # TypeScript currently exits with code 1 in the bundled Bun runtime when
    # diagnostics exist (the native CLI commonly uses 2). The invariant is
    # that diagnostics cannot be reported with a successful process, while a
    # clean run must exit zero; do not couple the gate to one CLI's numeric code.
    if (($actualTotal -gt 0 -and [int]$Result.ExitCode -eq 0) -or ($actualTotal -eq 0 -and [int]$Result.ExitCode -ne 0)) {
        throw "Web typecheck 退出码不符合诊断结果：exit=$($Result.ExitCode), diagnostics=$actualTotal。"
    }
    return [pscustomobject]@{
        ErrorCount = [int]$actualTotal
        BaselineEntryCount = $allowlist.Count
        ExitCode = [int]$Result.ExitCode
    }
}

$initialReport = @(
    "工作流验收时间: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz')"
    "项目: $projectRoot"
    ''
    '== API / database / storage tests =='
)
[System.IO.File]::WriteAllText($reportFile, '', $utf8Bom)
Write-ReportLines $initialReport

Push-Location $projectRoot
try {
    $apiTest = Invoke-BunTest @('--no-env-file', 'test', 'apps/api/test', 'packages/database/src', 'packages/storage/src', 'scripts/saas/staging-container-preflight.test.ts')
    Write-OutputAndReport $apiTest.Lines
    if ($apiTest.ExitCode -ne 0) { throw "测试失败：API/数据库/存储/staging 容器预检回归 (exit=$($apiTest.ExitCode))" }
    Write-ReportLines @('', '== Web tests ==')
    Push-Location (Join-Path $projectRoot 'web')
    try {
        $webTest = Invoke-BunTest @('--no-env-file', 'test', 'src', 'tests')
        Write-OutputAndReport $webTest.Lines
        if ($webTest.ExitCode -ne 0) { throw "测试失败：bun --no-env-file test src tests (exit=$($webTest.ExitCode))" }
    } finally {
        Pop-Location
    }

    Write-ReportLines @('', '== Web typecheck baseline gate ==')
    $typecheck = Invoke-BunCommand (Join-Path $projectRoot 'web') @('--no-env-file', 'node_modules/typescript/bin/tsc', '--noEmit', '--incremental', 'false', '--pretty', 'false')
    Write-OutputAndReport $typecheck.Lines
    $typecheckSummary = Assert-TypecheckBaseline $typecheck $typecheckAllowlistFile
    Write-OutputAndReport @(
        "typecheck_process_started=$($typecheck.Started.ToString().ToLowerInvariant())"
        "typecheck_errors=$($typecheckSummary.ErrorCount)"
        "typecheck_baseline_entries=$($typecheckSummary.BaselineEntryCount)"
        "typecheck_exit_code=$($typecheckSummary.ExitCode)"
    )

    Write-ReportLines @('', '== Web build / artifact check ==')
    $webBuild = Invoke-BunCommand (Join-Path $projectRoot 'web') @('--no-env-file', 'run', 'build')
    Write-OutputAndReport $webBuild.Lines
    if ($webBuild.ExitCode -ne 0) {
        throw "Web 构建失败：bun --no-env-file run build (exit=$($webBuild.ExitCode))"
    }

    $webDistDirectory = [System.IO.Path]::GetFullPath((Join-Path $projectRoot 'web\dist'))
    $webDistIndex = Join-Path $webDistDirectory 'index.html'
    if (-not (Test-Path -LiteralPath $webDistIndex -PathType Leaf)) {
        throw "Web 构建未生成入口产物：$webDistIndex"
    }
    $webDistIndexItem = Get-Item -LiteralPath $webDistIndex
    if ($webDistIndexItem.Length -le 0) {
        throw "Web 入口产物为空：$webDistIndex"
    }

    $webDistPrefix = $webDistDirectory.TrimEnd('\') + '\'
    $indexText = [System.IO.File]::ReadAllText($webDistIndex, $utf8NoBom)
    $localReferences = [regex]::Matches($indexText, '(?is)(?:src|href)\s*=\s*["''](?<path>[^"'']+)["'']')
    $missingReferences = @()
    foreach ($match in $localReferences) {
        $reference = $match.Groups['path'].Value
        if ([string]::IsNullOrWhiteSpace($reference) -or $reference -match '^(?:[a-z][a-z0-9+.-]*:|//|#)') {
            continue
        }
        $relativeReference = $reference.Split('?', 2)[0].Split('#', 2)[0].TrimStart('/')
        if ($relativeReference.Length -eq 0) { continue }
        $candidate = [System.IO.Path]::GetFullPath((Join-Path $webDistDirectory ($relativeReference -replace '/', '\')))
        if (-not $candidate.StartsWith($webDistPrefix, [System.StringComparison]::OrdinalIgnoreCase) -or
            -not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
            $missingReferences += $reference
        }
    }
    if ($missingReferences.Count -gt 0) {
        throw "Web 产物存在悬空脚本或样式引用：$($missingReferences -join ', ')"
    }
    $webDistIndexHash = (Get-FileHash -LiteralPath $webDistIndex -Algorithm SHA256).Hash
    Write-OutputAndReport @(
        "web_build_exit_code=$($webBuild.ExitCode)"
        "web_dist_index_bytes=$($webDistIndexItem.Length)"
        "web_dist_index_sha256=$webDistIndexHash"
        "web_dist_local_references=$($localReferences.Count)"
    )

    Write-ReportLines @('', '== Diff check ==')
    $diffErrorFile = [System.IO.Path]::GetTempFileName()
    $previousErrorAction = $ErrorActionPreference
    $ErrorActionPreference = 'SilentlyContinue'
    try {
        $diffOutput = @(git diff --check 2> $diffErrorFile)
        $diffExitCode = $LASTEXITCODE
        $diffError = [System.IO.File]::ReadAllText($diffErrorFile, $utf8NoBom)
    } finally {
        $ErrorActionPreference = $previousErrorAction
        Remove-Item -LiteralPath $diffErrorFile -Force -ErrorAction SilentlyContinue
    }
    Write-OutputAndReport $diffOutput
    if ($diffError.Length -gt 0) { Write-OutputAndReport @($diffError.TrimEnd()) }
    if ($diffExitCode -ne 0) { throw 'git diff --check 失败。' }
} finally {
    Pop-Location
}

Write-ReportLines @('', '== Runtime evidence ==')
try {
    $health = Invoke-WebRequest -UseBasicParsing -Uri "$ApiBaseUrl/health" -TimeoutSec 5
    $site = Invoke-RestMethod -Uri "$ApiBaseUrl/api/v1/site" -TimeoutSec 5
    Write-OutputAndReport @(
        "health_status=$($health.StatusCode)"
        "site_features=$($site.features | ConvertTo-Json -Compress)"
    )
} catch {
    Write-OutputAndReport @("runtime=unavailable ($($_.Exception.Message))")
    if ($RequireRuntime) { throw '要求本机服务证据，但 API 健康检查失败。' }
}

Write-Host "工作流验收完成，报告：$reportFile"
