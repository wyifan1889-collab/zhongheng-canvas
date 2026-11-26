param(
    [string]$SourceRoot = 'E:\codex-zh-cavanas',
    [Parameter(Mandatory = $true)][string]$Destination
)

# Creates a private local source backup, never deletes or changes the source.
# Runtime dependencies and build outputs are reinstallable, not user-data backups.
$ErrorActionPreference = 'Stop'
$source = (Resolve-Path -LiteralPath $SourceRoot).Path.TrimEnd('\')
$destinationPath = [IO.Path]::GetFullPath($Destination).TrimEnd('\')
if ($source -eq [IO.Path]::GetPathRoot($source).TrimEnd('\')) { throw 'Refusing a drive-root source.' }
if ($destinationPath -eq $source -or $destinationPath.StartsWith($source + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Destination must be outside the source to avoid recursive backup.'
}
if (Test-Path -LiteralPath $destinationPath) { throw 'Destination already exists; use a fresh directory.' }
$repo = Join-Path $source 'infinite-canvas'
if (!(Test-Path -LiteralPath (Join-Path $repo '.git') -PathType Container)) { throw 'Expected main repository .git directory is missing.' }
if (!(Test-Path -LiteralPath (Join-Path $repo 'MIGRATION_HANDOFF.md'))) { throw 'Migration handoff must be prepared first.' }

$excludedNames = @('node_modules', '.tools', 'dist', '.next', 'out')
function Get-Inventory {
    $files = [Collections.Generic.List[object]]::new()
    $directories = [Collections.Generic.List[string]]::new()
    $excluded = [Collections.Generic.List[string]]::new()
    $pending = [Collections.Generic.Stack[string]]::new()
    $pending.Push($source)
    while ($pending.Count -gt 0) {
        $directory = $pending.Pop()
        foreach ($item in Get-ChildItem -LiteralPath $directory -Force) {
            $relative = $item.FullName.Substring($source.Length + 1).Replace('\', '/')
            if ($item.PSIsContainer -and $item.Name -in $excludedNames -and $relative -notmatch '(^|/)\.git(/|$)') {
                $excluded.Add($relative)
                continue
            }
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Unreviewed link: $relative" }
            if ($item.PSIsContainer) { $directories.Add($relative); $pending.Push($item.FullName) }
            else {
                if ($relative -match '(^|/)\.git/.*\.lock$') { throw "Git write lock present: $relative" }
                $files.Add([pscustomobject]@{ Path = $relative; Length = $item.Length; FullName = $item.FullName })
            }
        }
    }
    return @{ Files = @($files | Sort-Object Path); Directories = @($directories | Sort-Object); Excluded = @($excluded | Sort-Object) }
}

$inventory = Get-Inventory
$included = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
foreach ($file in $inventory.Files) { [void]$included.Add($file.Path) }
# Do not accidentally omit any existing tracked file, including files in a build-looking folder.
foreach ($checkout in @('infinite-canvas', 'infinite-canvas-upgrade-dab19ad')) {
    $checkoutPath = Join-Path $source $checkout
    if (!(Test-Path -LiteralPath (Join-Path $checkoutPath '.git'))) { continue }
    $tracked = & git --no-optional-locks -C $checkoutPath -c core.quotePath=false ls-files
    if ($LASTEXITCODE -ne 0) { throw 'Unable to enumerate tracked files.' }
    foreach ($path in $tracked) {
        if ((Test-Path -LiteralPath (Join-Path $checkoutPath $path) -PathType Leaf) -and !$included.Contains("$checkout/$path")) {
            throw "A tracked file would be excluded: $checkout/$path"
        }
    }
}
$head = (& git --no-optional-locks -C $repo rev-parse HEAD)
if ($LASTEXITCODE -ne 0) { throw 'Cannot read HEAD.' }
$branch = (& git --no-optional-locks -C $repo branch --show-current)
$gitStatus = @(& git --no-optional-locks -C $repo status --porcelain=v1 --untracked-files=all)
if ($LASTEXITCODE -ne 0) { throw 'Cannot capture Git status.' }
[void][IO.Directory]::CreateDirectory($destinationPath)
$archivePath = Join-Path $destinationPath 'zh-chuangjing-development.zip'
$partialPath = $archivePath + '.partial'
$manifestPath = Join-Path $destinationPath 'FILE_MANIFEST.json'
$reportPath = Join-Path $destinationPath 'BACKUP_REPORT.json'
$archiveRoot = [IO.Path]::GetFileName($source)
$fileRows = [Collections.Generic.List[object]]::new()
$utf8 = [Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.IO.Compression

try {
    $zipStream = [IO.File]::Open($partialPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    $zip = [IO.Compression.ZipArchive]::new($zipStream, [IO.Compression.ZipArchiveMode]::Create, $false)
    try {
        [void]$zip.CreateEntry("$archiveRoot/")
        foreach ($directory in $inventory.Directories) { [void]$zip.CreateEntry("$archiveRoot/$directory/") }
        foreach ($file in $inventory.Files) {
            $hash = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash
            $entry = $zip.CreateEntry("$archiveRoot/$($file.Path)", [IO.Compression.CompressionLevel]::Optimal)
            $inputStream = [IO.File]::Open($file.FullName, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
            try {
                $entryStream = $entry.Open()
                try { $inputStream.CopyTo($entryStream) } finally { $entryStream.Dispose() }
            } finally { $inputStream.Dispose() }
            $fileRows.Add([pscustomobject]@{ Path = $file.Path; Bytes = $file.Length; SHA256 = $hash })
        }
    } finally { $zip.Dispose(); $zipStream.Dispose() }

    $manifest = [ordered]@{
        Format = 1; CreatedAt = (Get-Date).ToString('o'); Source = $source; ArchiveRoot = $archiveRoot
        Branch = $branch; Head = $head; GitStatus = $gitStatus
        ExcludedDirectories = $inventory.Excluded; IncludedDirectories = $inventory.Directories
        NotIncluded = @('Browser profiles, IndexedDB/localStorage and unsaved editor state', 'Running process memory and simulated cloud drafts', 'External databases, credentials outside workspace, SMTP account authorization', 'E:\codex-zh-api and other external projects', 'User profile .infinite-canvas Agent data', 'External chat attachments and visualization directories', 'Codex conversation history and application settings')
        Files = $fileRows.ToArray()
    }
    [IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json -Depth 8), $utf8)

    # Read/decompress every ZIP member and compare its hash, rather than trusting archive creation.
    $readStream = [IO.File]::OpenRead($partialPath)
    $readZip = [IO.Compression.ZipArchive]::new($readStream, [IO.Compression.ZipArchiveMode]::Read, $false)
    try {
        $zipFiles = @($readZip.Entries | Where-Object { !$_.FullName.EndsWith('/') })
        if ($zipFiles.Count -ne $fileRows.Count) { throw 'Archive file count mismatch.' }
        foreach ($row in $fileRows) {
            $entry = $readZip.GetEntry("$archiveRoot/$($row.Path)")
            if (!$entry -or $entry.Length -ne $row.Bytes) { throw "Archive length mismatch: $($row.Path)" }
            $entryStream = $entry.Open()
            $sha = [Security.Cryptography.SHA256]::Create()
            try { $entryHash = [BitConverter]::ToString($sha.ComputeHash($entryStream)).Replace('-', '') }
            finally { $sha.Dispose(); $entryStream.Dispose() }
            if ($entryHash -ne $row.SHA256) { throw "Archive hash mismatch: $($row.Path)" }
        }
    } finally { $readZip.Dispose(); $readStream.Dispose() }

    # Reject a changing source, including new/deleted files, instead of claiming a consistent snapshot.
    $after = Get-Inventory
    if (@(Compare-Object @($inventory.Files.Path) @($after.Files.Path)).Count -ne 0) { throw 'Source file list changed while archiving.' }
    if (@(Compare-Object $inventory.Directories $after.Directories).Count -ne 0) { throw 'Source directory list changed while archiving.' }
    foreach ($row in $fileRows) {
        $currentHash = (Get-FileHash -LiteralPath (Join-Path $source $row.Path) -Algorithm SHA256).Hash
        if ($currentHash -ne $row.SHA256) { throw "Source changed while archiving: $($row.Path)" }
    }
    # Rename only our newly created archive inside this validated, fresh destination.
    Move-Item -LiteralPath $partialPath -Destination $archivePath
    Copy-Item -LiteralPath (Join-Path $repo 'MIGRATION_HANDOFF.md') -Destination (Join-Path $destinationPath 'MIGRATION_HANDOFF.md')
    $archiveHash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash
    $report = [ordered]@{
        Status = 'verified'; VerifiedAt = (Get-Date).ToString('o'); Archive = $archivePath
        ArchiveSHA256 = $archiveHash; ArchiveBytes = (Get-Item -LiteralPath $archivePath).Length
        FileCount = $fileRows.Count; SourceBytes = ($fileRows | Measure-Object -Property Bytes -Sum).Sum
        EveryArchiveFileDecompressedAndHashed = $true; SourceRehashedAfterArchive = $true; ExistingTrackedFilesCovered = $true
        BrowserDataBackedUp = $false; NewComputerRestoreTested = $false; Encrypted = $false
        ExcludedDirectories = $inventory.Excluded
    }
    [IO.File]::WriteAllText($reportPath, ($report | ConvertTo-Json -Depth 6), $utf8)
    $checksums = @('zh-chuangjing-development.zip', 'FILE_MANIFEST.json', 'BACKUP_REPORT.json', 'MIGRATION_HANDOFF.md') | ForEach-Object {
        "{0}  {1}" -f (Get-FileHash -LiteralPath (Join-Path $destinationPath $_) -Algorithm SHA256).Hash, $_
    }
    [IO.File]::WriteAllText((Join-Path $destinationPath 'SHA256SUMS.txt'), ($checksums -join "`n") + "`n", $utf8)
    $report | ConvertTo-Json -Depth 6
} catch {
    [IO.File]::WriteAllText($reportPath, (@{ Status = 'failed'; Error = $_.Exception.Message; SourceModifiedByBackup = $false } | ConvertTo-Json), $utf8)
    throw
}
