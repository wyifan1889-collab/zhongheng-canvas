param(
    [string]$RunRoot = (Join-Path $env:TEMP 'infinite-canvas-account-local')
)

$ErrorActionPreference = 'Stop'
$stateFile = Join-Path $RunRoot 'current.json'
if (-not (Test-Path -LiteralPath $stateFile)) { Write-Host '没有找到本地账户运行实例。'; exit 0 }
$state = Get-Content -Raw $stateFile | ConvertFrom-Json
foreach ($processId in @($state.webPid, $state.apiPid)) {
    if ($processId) {
        try { Stop-Process -Id ([int]$processId) -Force -ErrorAction Stop } catch { }
    }
}
$previousErrorAction = $ErrorActionPreference
$ErrorActionPreference = 'SilentlyContinue'
try {
    # Native pg_ctl writes a stale-PID warning to stderr. PowerShell turns
    # that stream into a terminating ErrorRecord under Stop; capture it so
    # the explicit stale-state handling below can inspect the exit code.
    $pgOutput = @(& $state.pgCtl stop -D $state.dataDirectory -m fast -w -t 30 2>&1)
    $pgExitCode = $LASTEXITCODE
} finally {
    $ErrorActionPreference = $previousErrorAction
}
if ($pgExitCode -ne 0) {
    # A stale state file may point at a PostgreSQL process that already exited.
    # Treat that case as stopped, while still surfacing a live process that
    # refused to stop.
    $postmasterPidFile = Join-Path $state.dataDirectory 'postmaster.pid'
    $postmasterPid = if (Test-Path -LiteralPath $postmasterPidFile) { (Get-Content -LiteralPath $postmasterPidFile -ErrorAction SilentlyContinue | Select-Object -First 1) } else { $null }
    $parsedPid = 0
    $hasPid = [int]::TryParse([string]$postmasterPid, [ref]$parsedPid)
    $livePostmaster = $hasPid -and $parsedPid -gt 0 -and (Get-Process -Id $parsedPid -ErrorAction SilentlyContinue)
    if ($livePostmaster) { throw "PostgreSQL 停止失败：$pgExitCode；请只检查本实例目录 $($state.dataDirectory)。" }
}
Remove-Item -LiteralPath $stateFile -Force
Remove-Item -LiteralPath $state.runtimeEnv -Force -ErrorAction SilentlyContinue
Write-Host "本地账户服务已停止；运行目录保留在 $($state.runDirectory) 供排错。"
