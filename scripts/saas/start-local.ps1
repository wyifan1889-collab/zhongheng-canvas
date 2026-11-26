param(
    [ValidateSet('canvas', 'preview')]
    [string]$Mode = 'canvas'
)

$ErrorActionPreference = 'Stop'
$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$bunDirectory = Join-Path $projectRoot '.tools\bun-1.4.2\bun-windows-x64'
$gitDirectory = Join-Path $projectRoot '.tools\git-2.56.0\cmd'
$bunExecutable = Join-Path $bunDirectory 'bun.exe'
$webDirectory = Join-Path $projectRoot 'web'

if (-not (Test-Path -LiteralPath $bunExecutable)) {
    throw 'Bun 1.4.2 is missing from .tools. Restore the local runtime first.'
}
if ((& $bunExecutable --version).Trim() -ne '1.4.2') {
    throw 'This project requires Bun 1.4.2.'
}
if (-not (Test-Path -LiteralPath (Join-Path $webDirectory 'node_modules\vite\bin\vite.js'))) {
    throw 'Web dependencies are missing. Install them using the existing lockfile.'
}
if ($Mode -eq 'preview' -and -not (Test-Path -LiteralPath (Join-Path $projectRoot 'apps\api\node_modules\zod\package.json'))) {
    throw 'SaaS workspace dependencies are missing. Install the root workspace first.'
}

$env:Path = $bunDirectory + ';' + $gitDirectory + ';' + $env:Path
$env:BUN_INSTALL_CACHE_DIR = Join-Path $projectRoot '.tools\bun-cache'
Push-Location -LiteralPath $webDirectory
try {
    if ($Mode -eq 'canvas') {
        Write-Host 'Open http://127.0.0.1:4174/canvas . Keep this window open; Ctrl+C stops the server.'
        & $bunExecutable --no-env-file run ./node_modules/vite/bin/vite.js --host 127.0.0.1 --port 4174 --strictPort
    } else {
        Write-Host 'Open http://127.0.0.1:4180/canvas . Synthetic accounts and in-memory drafts only.'
        Write-Host 'Keep this window open; Ctrl+C stops the server and discards simulated cloud drafts.'
        & $bunExecutable --no-env-file run scripts/saas-first-save-browser.ts
    }
    if ($LASTEXITCODE -ne 0) {
        throw "Local server exited with code $LASTEXITCODE. Check the output above; do not terminate an unknown process occupying the port."
    }
} finally {
    Pop-Location
}
