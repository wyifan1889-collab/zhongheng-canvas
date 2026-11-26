param(
    [string]$RunRoot = (Join-Path $env:TEMP 'infinite-canvas-account-local'),
    [string]$ApiBaseUrl = ''
)

$ErrorActionPreference = 'Stop'
$stateFile = Join-Path $RunRoot 'current.json'
$state = if (Test-Path -LiteralPath $stateFile) { Get-Content -Raw $stateFile | ConvertFrom-Json } else { $null }
if (-not $ApiBaseUrl) {
    $apiPort = if ($state) { [int]$state.apiPort } else { 4011 }
    $ApiBaseUrl = "http://127.0.0.1:$apiPort"
}

function Get-Endpoint([string]$Path) {
    try {
        $response = Invoke-WebRequest -Uri ($ApiBaseUrl.TrimEnd('/') + $Path) -UseBasicParsing -TimeoutSec 10
        $body = if ($response.Content) { $response.Content | ConvertFrom-Json } else { $null }
        return [pscustomobject]@{ path = $Path; status = [int]$response.StatusCode; body = $body; error = $null }
    } catch {
        $statusCode = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode.value__ } else { 0 }
        return [pscustomobject]@{ path = $Path; status = $statusCode; body = $null; error = 'request_failed' }
    }
}

$results = @(
    (Get-Endpoint '/health'),
    (Get-Endpoint '/healthz'),
    (Get-Endpoint '/readyz'),
    (Get-Endpoint '/api/v1/meta'),
    (Get-Endpoint '/api/v1/site'),
    (Get-Endpoint '/api/v1/admin/providers')
)

$failures = [System.Collections.Generic.List[string]]::new()
foreach ($result in $results) {
    $expected = switch ($result.path) {
        '/api/v1/admin/providers' { 403; break }
        default { 200; break }
    }
    $label = if ($result.status -eq $expected) { 'PASS' } else { 'FAIL' }
    Write-Host ("{0} {1} -> {2}" -f $label, $result.path, $result.status)
    if ($result.status -ne $expected) { [void]$failures.Add("$($result.path) expected $expected, got $($result.status)") }
}

$ready = $results | Where-Object path -eq '/readyz' | Select-Object -First 1
$site = $results | Where-Object path -eq '/api/v1/site' | Select-Object -First 1
$meta = $results | Where-Object path -eq '/api/v1/meta' | Select-Object -First 1
$checks = if ($ready.body.checks) { ($ready.body.checks | ConvertTo-Json -Compress) } else { '{}' }
$cloudCanvas = if ($site.body.features) { [bool]$site.body.features.cloudCanvas } else { $null }
$authentication = if ($meta.body) { [string]$meta.body.authentication } else { '' }
Write-Host ("readiness checks: {0}" -f $checks)
Write-Host ("cloudCanvas: {0}; authentication: {1}" -f $cloudCanvas, $authentication)

if ($cloudCanvas -ne $false) { [void]$failures.Add('local cloudCanvas must remain false') }
if ($authentication -ne 'enabled') { [void]$failures.Add('local account authentication must be enabled') }
if ($failures.Count -gt 0) {
    Write-Error ($failures -join '; ')
    exit 1
}
Write-Host '本地账户 smoke 检查通过。'
