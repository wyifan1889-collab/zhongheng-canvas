param(
    [string]$StagingBaseUrl = 'https://chat.zh-api.com',
    [string]$ProductionBaseUrl = 'https://agent.zh-api.com'
)

$ErrorActionPreference = 'Stop'

function Get-JsonEndpoint {
    param([string]$BaseUrl, [string]$Path)

    $uri = ([Uri]::new($BaseUrl.TrimEnd('/') + $Path)).AbsoluteUri
    $response = Invoke-WebRequest -UseBasicParsing -Uri $uri -TimeoutSec 15
    if ($response.StatusCode -ne 200) {
        throw "$uri returned HTTP $($response.StatusCode)"
    }
    return [pscustomobject]@{
        Uri = $uri
        Body = ($response.Content | ConvertFrom-Json)
    }
}

function Get-ValidatedBaseUri {
    param(
        [string]$Name,
        [string]$BaseUrl
    )

    try {
        $uri = [Uri]::new($BaseUrl.TrimEnd('/') + '/')
    } catch {
        throw "$Name base URL is invalid"
    }
    if ($uri.Scheme -ne 'https' -or [string]::IsNullOrWhiteSpace($uri.Host)) {
        throw "$Name base URL must be an absolute HTTPS origin"
    }
    if (-not [string]::IsNullOrEmpty($uri.UserInfo) -or $uri.AbsolutePath -ne '/' -or
        -not [string]::IsNullOrEmpty($uri.Query) -or -not [string]::IsNullOrEmpty($uri.Fragment)) {
        throw "$Name base URL must not contain credentials, a path, query, or fragment"
    }
    return $uri
}

function Get-StatusProbe {
    param([string]$BaseUrl, [string]$Path, [ValidateSet('GET', 'POST')][string]$Method)

    $uri = ([Uri]::new($BaseUrl.TrimEnd('/') + $Path)).AbsoluteUri
    try {
        $headers = @{ Origin = ([Uri]::new($BaseUrl.TrimEnd('/'))).AbsoluteUri.TrimEnd('/') }
        $parameters = @{ UseBasicParsing = $true; Uri = $uri; Method = $Method; Headers = $headers; TimeoutSec = 15 }
        if ($Method -eq 'POST') {
            $parameters.ContentType = 'application/json'
            $parameters.Body = '{}'
        }
        $response = Invoke-WebRequest @parameters
        return [pscustomobject]@{ Uri = $uri; Method = $Method; Status = [int]$response.StatusCode; RequestId = [string]$response.Headers['x-request-id'] }
    } catch {
        $statusCode = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode.value__ } else { 0 }
        $requestId = if ($_.Exception.Response) { [string]$_.Exception.Response.Headers['x-request-id'] } else { '' }
        return [pscustomobject]@{ Uri = $uri; Method = $Method; Status = $statusCode; RequestId = $requestId }
    }
}

function Assert-True {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw $Message }
}

$stagingBaseUri = Get-ValidatedBaseUri 'staging' $StagingBaseUrl
$productionBaseUri = Get-ValidatedBaseUri 'production' $ProductionBaseUrl
Assert-True ($stagingBaseUri.Host.ToLowerInvariant() -ne $productionBaseUri.Host.ToLowerInvariant()) 'staging and production base URLs must use different hosts'
Assert-True ($stagingBaseUri.Host.ToLowerInvariant() -ne 'agent.zh-api.com') 'production host cannot be used as the staging base URL'

$staging = Get-JsonEndpoint $StagingBaseUrl '/readyz'
Assert-True ($staging.Body.status -eq 'ready') 'staging /readyz is not ready'
Assert-True ($staging.Body.checks.database -eq 'ok') 'staging database readiness failed'
Assert-True ($staging.Body.checks.storage -eq 'ok') 'staging storage readiness failed'

$stagingSite = Get-JsonEndpoint $StagingBaseUrl '/api/v1/site'
$stagingFeatures = $stagingSite.Body.features
Assert-True ($stagingFeatures.cloudCanvas -eq $true) 'staging cloudCanvas must be enabled'
Assert-True ($stagingFeatures.cloudMedia -eq $true) 'staging cloudMedia must be enabled'
Assert-True ($stagingFeatures.recharge -eq $false) 'staging recharge must remain closed'
Assert-True ($stagingFeatures.generation.text -eq $false -and
    $stagingFeatures.generation.image -eq $false -and
    $stagingFeatures.generation.video -eq $false -and
    $stagingFeatures.generation.audio -eq $false) 'staging generation must remain closed'

$productionSite = Get-JsonEndpoint $ProductionBaseUrl '/api/v1/site'
$productionFeatures = $productionSite.Body.features
Assert-True ($productionFeatures.cloudCanvas -eq $false) 'production cloudCanvas changed unexpectedly'
Assert-True ($productionFeatures.recharge -eq $false) 'production recharge changed unexpectedly'
Assert-True ($productionFeatures.generation.text -eq $false -and
    $productionFeatures.generation.image -eq $false -and
    $productionFeatures.generation.video -eq $false -and
    $productionFeatures.generation.audio -eq $false) 'production generation changed unexpectedly'

$closedRouteProbes = @(
    (Get-StatusProbe $StagingBaseUrl '/api/v1/generate/text' 'POST'),
    (Get-StatusProbe $StagingBaseUrl '/api/v1/billing/recharge' 'POST'),
    (Get-StatusProbe $StagingBaseUrl '/api/v1/admin/providers' 'GET'),
    (Get-StatusProbe $ProductionBaseUrl '/api/v1/generate/text' 'POST'),
    (Get-StatusProbe $ProductionBaseUrl '/api/v1/billing/recharge' 'POST'),
    (Get-StatusProbe $ProductionBaseUrl '/api/v1/admin/providers' 'GET')
)
$allowedClosedStatuses = @(401, 403, 404, 405, 503)
foreach ($probe in $closedRouteProbes) {
    Assert-True ($allowedClosedStatuses -contains $probe.Status) "$($probe.Method) $($probe.Uri) unexpectedly returned HTTP $($probe.Status)"
}

[pscustomobject]@{
    status = 'ok'
    staging = [pscustomobject]@{
        ready = $true
        cloudCanvas = [bool]$stagingFeatures.cloudCanvas
        cloudMedia = [bool]$stagingFeatures.cloudMedia
        recharge = [bool]$stagingFeatures.recharge
        generation = $stagingFeatures.generation
    }
    production = [pscustomobject]@{
        cloudCanvas = [bool]$productionFeatures.cloudCanvas
        recharge = [bool]$productionFeatures.recharge
        generation = $productionFeatures.generation
    }
    closedRouteProbes = $closedRouteProbes | ForEach-Object {
        [pscustomobject]@{ method = $_.Method; uri = $_.Uri; status = $_.Status; requestId = $_.RequestId }
    }
} | ConvertTo-Json -Depth 6
