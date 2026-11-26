[CmdletBinding()]
param([switch]$Fetch)

$ErrorActionPreference = 'Stop'
$repository = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path

function Invoke-RepositoryGit {
    param([string[]]$Arguments)
    $output = & git -C $repository @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Git failed (exit $LASTEXITCODE): $($Arguments -join ' ')"
    }
    return $output
}

if ($Fetch) {
    Invoke-RepositoryGit -Arguments @('fetch', 'upstream', '--tags')
}

$headCommit = Invoke-RepositoryGit -Arguments @('rev-parse', '--verify', 'HEAD^{commit}')
$upstreamCommit = Invoke-RepositoryGit -Arguments @('rev-parse', '--verify', 'upstream/main^{commit}')
$baseCommit = Invoke-RepositoryGit -Arguments @('merge-base', $headCommit, $upstreamCommit)
$branch = Invoke-RepositoryGit -Arguments @('rev-parse', '--abbrev-ref', 'HEAD')
$status = @(Invoke-RepositoryGit -Arguments @('status', '--short', '--untracked-files=all'))
$upstreamFiles = @(Invoke-RepositoryGit -Arguments @('diff', '--name-only', '--no-renames', $baseCommit, $upstreamCommit))
$productFiles = @(
    Invoke-RepositoryGit -Arguments @('diff', '--name-only', '--no-renames', $baseCommit)
    Invoke-RepositoryGit -Arguments @('ls-files', '--others', '--exclude-standard')
) | Sort-Object -Unique
$overlappingFiles = @($productFiles | Where-Object { $upstreamFiles -ccontains $_ })

Write-Output "Branch: $branch"
Write-Output "Product commit: $headCommit"
Write-Output "Official commit: $upstreamCommit"
Write-Output "Common ancestor: $baseCommit"
Write-Output ''
Write-Output 'Official commits not yet in this branch:'
Invoke-RepositoryGit -Arguments @('log', '--oneline', '--no-decorate', "$headCommit..$upstreamCommit")
Write-Output ''
Write-Output 'Official changes since the common ancestor:'
Invoke-RepositoryGit -Arguments @('diff', '--stat', $baseCommit, $upstreamCommit)
Write-Output ''
Write-Output 'Product changes (including tracked working files) since the common ancestor:'
Invoke-RepositoryGit -Arguments @('diff', '--stat', $baseCommit)
Write-Output ''
Write-Output 'Files changed on both sides (review candidates, not confirmed conflicts):'
if ($overlappingFiles.Count -eq 0) {
    Write-Output '(none)'
} else {
    $overlappingFiles
}
Write-Output ''
Write-Output 'Working tree changes:'
if ($status.Count -eq 0) {
    Write-Output '(clean)'
} else {
    $status
    Write-Warning 'Review and commit relevant work before preparing an upgrade. Untracked file contents are not included in the diff statistics.'
}
Write-Output ''
Write-Output 'No checkout, merge, commit or deployment was performed.'
Write-Output 'Use UPSTREAM_SYNC.md to review changes and prepare an isolated upgrade.'
