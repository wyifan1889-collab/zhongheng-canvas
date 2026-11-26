param(
    [int]$ApiPort = 4011,
    [int]$WebPort = 4181,
    [string]$RunRoot = (Join-Path $env:TEMP 'infinite-canvas-account-local'),
    [string]$BackendRoot = '',
    [string]$EnvironmentFile = '',
    [switch]$AccountOnly
)

$ErrorActionPreference = 'Stop'
$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$backendRoot = if ($BackendRoot) { [IO.Path]::GetFullPath($BackendRoot) } else { $projectRoot }
$bunExecutable = Join-Path $backendRoot '.tools\bun-1.4.2\bun-windows-x64\bun.exe'
$apiDirectory = Join-Path $backendRoot 'apps\api'
$webDirectory = Join-Path $projectRoot 'web'
$nativeSource = Join-Path $backendRoot 'packages\test-postgres\node_modules\@embedded-postgres\windows-x64\native'
$sourceEnvPath = if ($EnvironmentFile) { [IO.Path]::GetFullPath($EnvironmentFile) } else { Join-Path $apiDirectory '.env' }
$stateFile = Join-Path $RunRoot 'current.json'

if (-not (Test-Path -LiteralPath $bunExecutable)) { throw 'Bun 1.4.2 不存在，请先恢复本地运行环境。' }
if (-not (Test-Path -LiteralPath (Join-Path $nativeSource 'bin\initdb.exe'))) { throw '便携 PostgreSQL 工具不存在，请先安装测试依赖。' }
if (-not (Test-Path -LiteralPath $sourceEnvPath -PathType Leaf)) { throw '本机账户配置文件不存在。' }
if (Test-Path -LiteralPath $stateFile) { throw "已有本地账户运行实例，请先运行 scripts/saas/stop-account-local.ps1。" }
if ($ApiPort -eq $WebPort) { throw 'API 端口和 web 端口必须不同。' }

New-Item -ItemType Directory -Force -Path $RunRoot | Out-Null
$runDirectory = Join-Path $RunRoot ([guid]::NewGuid().ToString('N'))
$nativeDirectory = Join-Path $runDirectory 'native'
$dataDirectory = Join-Path $runDirectory 'data'
$logFile = Join-Path $runDirectory 'postgres.log'
$apiLog = Join-Path $runDirectory 'api.log'
$apiErrorLog = Join-Path $runDirectory 'api.error.log'
$webLog = Join-Path $runDirectory 'web.log'
$webErrorLog = Join-Path $runDirectory 'web.error.log'
$runtimeEnv = Join-Path $runDirectory 'api.env'
$bootstrapFile = Join-Path $runDirectory 'bootstrap-db.ts'
New-Item -ItemType Directory -Force -Path $runDirectory | Out-Null

function New-RandomHex([int]$ByteCount = 32) {
    $bytes = New-Object byte[] $ByteCount
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $rng.GetBytes($bytes)
        return ([BitConverter]::ToString($bytes) -replace '-', '').ToLowerInvariant()
    } finally {
        $rng.Dispose()
    }
}

try {
    # Copy the native tree into an ASCII path. Windows initdb can misread a
    # non-ASCII package path even when the database directory itself is safe.
    Copy-Item -LiteralPath $nativeSource -Destination $nativeDirectory -Recurse -Force
    $initdb = Join-Path $nativeDirectory 'bin\initdb.exe'
    $pgCtl = Join-Path $nativeDirectory 'bin\pg_ctl.exe'

    $probe = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
    $probe.Start()
    $postgresPort = $probe.LocalEndpoint.Port
    $probe.Stop()

    $adminPassword = New-RandomHex
    $appPassword = New-RandomHex
    $passwordFile = Join-Path $runDirectory '.init-password'
    Set-Content -LiteralPath $passwordFile -Value $adminPassword -Encoding ascii
    & $initdb -D $dataDirectory --username=canvas_local_admin --auth=scram-sha-256 --encoding=UTF8 --locale=C --pwfile=$passwordFile --no-instructions
    if ($LASTEXITCODE -ne 0) { throw "initdb 失败：$LASTEXITCODE" }
    Remove-Item -LiteralPath $passwordFile -Force

    & $pgCtl start -D $dataDirectory -l $logFile -w -t 30 -o "-h 127.0.0.1 -p $postgresPort"
    if ($LASTEXITCODE -ne 0) { throw "PostgreSQL 启动失败：$LASTEXITCODE" }

    @'
import { createRequire } from "node:module";

const { Client } = createRequire(process.env.ACCOUNT_DB_MODULE_ROOT!)("pg");

const admin = new Client({
    host: "127.0.0.1",
    port: Number(process.env.ACCOUNT_DB_PORT),
    user: "canvas_local_admin",
    password: process.env.ACCOUNT_DB_ADMIN_PASSWORD,
    database: "postgres",
});
await admin.connect();
try {
    await admin.query(`CREATE ROLE canvas_local_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '${process.env.ACCOUNT_DB_APP_PASSWORD}'`);
    await admin.query("CREATE DATABASE canvas_local OWNER canvas_local_app");
} finally {
    await admin.end();
}
'@ | Set-Content -LiteralPath $bootstrapFile -Encoding utf8
    $env:ACCOUNT_DB_PORT = [string]$postgresPort
    $env:ACCOUNT_DB_ADMIN_PASSWORD = $adminPassword
    $env:ACCOUNT_DB_APP_PASSWORD = $appPassword
    $env:ACCOUNT_DB_MODULE_ROOT = Join-Path $backendRoot 'packages\database\package.json'
    & $bunExecutable --no-env-file $bootstrapFile
    if ($LASTEXITCODE -ne 0) { throw "本地账户数据库初始化失败：$LASTEXITCODE" }
    Remove-Item Env:ACCOUNT_DB_PORT,Env:ACCOUNT_DB_ADMIN_PASSWORD,Env:ACCOUNT_DB_APP_PASSWORD,Env:ACCOUNT_DB_MODULE_ROOT -ErrorAction SilentlyContinue

    $databaseUrl = "postgresql://canvas_local_app:$appPassword@127.0.0.1:$postgresPort/canvas_local"
    $settings = @{
        HOST = '127.0.0.1'; PORT = [string]$ApiPort; SAAS_ACCOUNTS_ENABLED = 'true'
        SAAS_DATABASE_URL = $databaseUrl; SAAS_ORIGIN = "http://127.0.0.1:$WebPort"
    }
    if ($AccountOnly) {
        $settings.SAAS_AUTH_SECRET = New-RandomHex
        $settings.SAAS_TRUSTED_PROXY = 'false'
        $settings.STORAGE_PROVIDER = ''
        foreach ($name in @('SAAS_CLOUD_CANVAS_ENABLED', 'SAAS_MEDIA_ENABLED', 'SAAS_GENERATION_IMAGE_ENABLED',
                'SAAS_GENERATION_TEXT_ENABLED', 'SAAS_GENERATION_AUDIO_ENABLED', 'SAAS_GENERATION_VIDEO_ENABLED',
                'SAAS_PAYMENTS_ENABLED', 'GENERATION_WORKER_ENABLED')) {
            $settings[$name] = 'false'
        }
    }
    # Bun loads the original secrets in place; only this new local database's overrides are written.
    $envLines = @($settings.Keys | Sort-Object | ForEach-Object { "$($_)=$($settings[$_])" })
    [IO.File]::WriteAllLines($runtimeEnv, $envLines, [Text.UTF8Encoding]::new($true))
    & $bunExecutable "--env-file=$sourceEnvPath" "--env-file=$runtimeEnv" --no-install (Join-Path $apiDirectory 'src\migrate.ts')
    if ($LASTEXITCODE -ne 0) { throw "账户数据库迁移失败：$LASTEXITCODE" }

    $apiProcess = Start-Process -FilePath $bunExecutable -ArgumentList @(('"--env-file={0}"' -f $sourceEnvPath), ('"--env-file={0}"' -f $runtimeEnv), 'src/server.ts') -WorkingDirectory $apiDirectory -WindowStyle Hidden -RedirectStandardOutput $apiLog -RedirectStandardError $apiErrorLog -PassThru
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
        backendRoot = $backendRoot; webDirectory = $webDirectory; accountOnly = [bool]$AccountOnly
    }
    $state | ConvertTo-Json | Set-Content -LiteralPath $stateFile -Encoding utf8
    Write-Host "本地账户 API：http://127.0.0.1:$ApiPort"
    Write-Host "本地账户网页：http://127.0.0.1:$WebPort/account"
    Write-Host "停止本实例：scripts/saas/stop-account-local.ps1 -RunRoot '$RunRoot'"
} catch {
    # Preserve the original startup error when initdb failed before creating
    # the data directory; cleanup must never mask the actionable exception.
    if ((Test-Path -LiteralPath $pgCtl) -and (Test-Path -LiteralPath $dataDirectory)) { & $pgCtl stop -D $dataDirectory -m fast -w -t 30 2>$null }
    throw
}
