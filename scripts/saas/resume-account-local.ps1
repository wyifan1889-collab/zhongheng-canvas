param(
    [Parameter(Mandatory = $true)]
    [string]$RunDirectory,
    [int]$ApiPort = 4011,
    [int]$WebPort = 4181,
    [string]$RunRoot = (Join-Path $env:TEMP 'infinite-canvas-account-local')
)

$ErrorActionPreference = 'Stop'
$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$bunExecutable = Join-Path $projectRoot '.tools\bun-1.4.2\bun-windows-x64\bun.exe'
$apiDirectory = Join-Path $projectRoot 'apps\api'
$webDirectory = Join-Path $projectRoot 'web'
$stateFile = Join-Path $RunRoot 'current.json'
$runDirectory = [System.IO.Path]::GetFullPath($RunDirectory)
$dataDirectory = Join-Path $runDirectory 'data'
$nativeDirectory = Join-Path $runDirectory 'native'
$pgCtl = Join-Path $nativeDirectory 'bin\pg_ctl.exe'
$hbaFile = Join-Path $dataDirectory 'pg_hba.conf'
$runtimeEnv = Join-Path $runDirectory 'api.env'
$bootstrapFile = Join-Path $runDirectory 'resume-role.ts'
$apiLog = Join-Path $runDirectory 'api.resume.log'
$apiErrorLog = Join-Path $runDirectory 'api.resume.error.log'
$webLog = Join-Path $runDirectory 'web.resume.log'
$webErrorLog = Join-Path $runDirectory 'web.resume.error.log'

if (-not (Test-Path -LiteralPath $bunExecutable)) { throw 'Bun 1.4.2 不存在，请先恢复本地运行环境。' }
if (Test-Path -LiteralPath $stateFile) { throw '已有本地账户运行实例，请先运行 scripts/saas/stop-account-local.ps1。' }
foreach ($path in @($dataDirectory, $pgCtl, $hbaFile)) {
    if (-not (Test-Path -LiteralPath $path)) { throw "运行目录缺少必要文件：$path" }
}
if ($ApiPort -eq $WebPort) { throw 'API 端口和 web 端口必须不同。' }

function New-RandomHex([int]$ByteCount = 32) {
    $bytes = New-Object byte[] $ByteCount
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes); return ([BitConverter]::ToString($bytes) -replace '-', '').ToLowerInvariant() }
    finally { $rng.Dispose() }
}

$portProbe = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
$portProbe.Start()
$postgresPort = [int]$portProbe.LocalEndpoint.Port
$portProbe.Stop()
$appPassword = New-RandomHex
$postmasterPidFile = Join-Path $dataDirectory 'postmaster.pid'
if (Test-Path -LiteralPath $postmasterPidFile) {
    $pidValue = 0
    $hasPid = [int]::TryParse([string](Get-Content -LiteralPath $postmasterPidFile | Select-Object -First 1), [ref]$pidValue)
    if ($hasPid -and $pidValue -gt 0 -and (Get-Process -Id $pidValue -ErrorAction SilentlyContinue)) {
        throw "运行目录中的 PostgreSQL 进程仍在运行：$pidValue"
    }
    Remove-Item -LiteralPath $postmasterPidFile -Force
}

$hbaOriginal = [IO.File]::ReadAllText($hbaFile)
try {
    # The old local env intentionally does not retain the random database
    # password after shutdown. Use a temporary loopback-only trust rule to
    # rotate the app role, then restore SCRAM before the API starts.
    [IO.File]::WriteAllText($hbaFile, ($hbaOriginal -replace 'scram-sha-256', 'trust'), [Text.UTF8Encoding]::new($false))
    & $pgCtl start -D $dataDirectory -l (Join-Path $runDirectory 'postgres.log') -w -t 30 -o "-h 127.0.0.1 -p $postgresPort"
    if ($LASTEXITCODE -ne 0) { throw "PostgreSQL 启动失败：$LASTEXITCODE" }

    @'
import { Client } from "pg";

const client = new Client({ host: "127.0.0.1", port: Number(process.env.ACCOUNT_DB_PORT), user: "canvas_local_admin", database: "postgres" });
await client.connect();
// The password is generated as lowercase hex above, so interpolation cannot
// introduce SQL syntax; node-postgres parameters cannot bind role passwords.
try { await client.query(`ALTER ROLE canvas_local_app WITH PASSWORD '${process.env.ACCOUNT_DB_APP_PASSWORD}'`); }
finally { await client.end(); }
'@ | Set-Content -LiteralPath $bootstrapFile -Encoding utf8
    $env:ACCOUNT_DB_PORT = [string]$postgresPort
    $env:ACCOUNT_DB_APP_PASSWORD = $appPassword
    & $bunExecutable --no-env-file $bootstrapFile
    if ($LASTEXITCODE -ne 0) { throw "本地账户应用角色密码恢复失败：$LASTEXITCODE" }
} finally {
    Remove-Item Env:ACCOUNT_DB_PORT,Env:ACCOUNT_DB_APP_PASSWORD -ErrorAction SilentlyContinue
    [IO.File]::WriteAllText($hbaFile, $hbaOriginal, [Text.UTF8Encoding]::new($false))
    Remove-Item -LiteralPath $bootstrapFile -Force -ErrorAction SilentlyContinue
    & $pgCtl reload -D $dataDirectory 2>$null
}

$sourceEnvPath = Join-Path $apiDirectory '.env'
$envLines = [System.Collections.Generic.List[string]]::new()
foreach ($line in [IO.File]::ReadAllLines($sourceEnvPath, [Text.UTF8Encoding]::new($false))) { [void]$envLines.Add($line) }
$databaseUrl = "postgresql://canvas_local_app:$appPassword@127.0.0.1:$postgresPort/canvas_local"
$settings = @{
    HOST = '127.0.0.1'; PORT = [string]$ApiPort; SAAS_ACCOUNTS_ENABLED = 'true'
    SAAS_DATABASE_URL = $databaseUrl; SAAS_ORIGIN = "http://127.0.0.1:$WebPort"
}
foreach ($name in $settings.Keys) {
    $lineIndex = -1
    for ($index = 0; $index -lt $envLines.Count; $index++) { if ($envLines[$index] -match "^$([regex]::Escape($name))=") { $lineIndex = $index; break } }
    $line = "$name=$([string]$settings[$name])"
    if ($lineIndex -ge 0) { $envLines[$lineIndex] = $line } else { [void]$envLines.Add($line) }
}
[IO.File]::WriteAllLines($runtimeEnv, $envLines.ToArray(), [Text.UTF8Encoding]::new($true))

$apiProcess = Start-Process -FilePath $bunExecutable -ArgumentList @("--env-file=$runtimeEnv", 'src/server.ts') -WorkingDirectory $apiDirectory -WindowStyle Hidden -RedirectStandardOutput $apiLog -RedirectStandardError $apiErrorLog -PassThru
$oldApiTarget = $env:VITE_API_TARGET
try {
    $env:VITE_API_TARGET = "http://127.0.0.1:$ApiPort"
    $webProcess = Start-Process -FilePath $bunExecutable -ArgumentList @('run', './node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', [string]$WebPort, '--strictPort') -WorkingDirectory $webDirectory -WindowStyle Hidden -RedirectStandardOutput $webLog -RedirectStandardError $webErrorLog -PassThru
} finally {
    if ($null -eq $oldApiTarget) { Remove-Item Env:VITE_API_TARGET -ErrorAction SilentlyContinue } else { $env:VITE_API_TARGET = $oldApiTarget }
}

$state = [ordered]@{
    runDirectory = $runDirectory; dataDirectory = $dataDirectory; postgresPort = $postgresPort
    apiPort = $ApiPort; webPort = $WebPort; apiPid = $apiProcess.Id; webPid = $webProcess.Id
    runtimeEnv = $runtimeEnv; pgCtl = $pgCtl
}
$state | ConvertTo-Json | Set-Content -LiteralPath $stateFile -Encoding utf8
Write-Host "已恢复本地账户 API：http://127.0.0.1:$ApiPort"
Write-Host "已恢复本地账户网页：http://127.0.0.1:$WebPort/account"
