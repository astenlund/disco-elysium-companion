$script:StateFileNames = [ordered]@{ Current = 'current.json'; Baseline = 'baseline.json'; DiffCache = 'diff-since-last-read.json'; Bookkeeping = 'last-processed.json' }
$script:StateFileTargets = @($script:StateFileNames.Values)
$script:StateTempReaperPattern = '^(?:' + (@($script:StateFileTargets | ForEach-Object { [IO.Path]::GetFileNameWithoutExtension($_) }) -join '|') + ')\.json\.[0-9a-f]{32}\.tmp$'
$script:StateTempAge = [TimeSpan]::FromHours(1)
$script:StateReaperMaximumEntries = 65536
$script:StateReaperMaximumNameBytes = 16777216

function Get-CompanionStatePath {
    param([Parameter(Mandatory)] [string] $CompanionRoot, [Parameter(Mandatory)] [string] $Name)

    return Join-Path ([IO.Path]::GetFullPath($CompanionRoot)) (Join-Path 'state' $Name)
}

function Initialize-CompanionStateDirectories {
    param([Parameter(Mandatory)] [string] $CompanionRoot)

    foreach ($name in 'state', '.tmp') {
        [void] [IO.Directory]::CreateDirectory((Join-Path ([IO.Path]::GetFullPath($CompanionRoot)) $name))
    }
}

function Test-SharingViolation {
    param([Parameter(Mandatory)] [IO.IOException] $Exception)

    return ($Exception.HResult -band 0xffff) -eq 32
}

function Write-CompanionStateBytes {
    param(
        [Parameter(Mandatory)] [string] $Path,
        [Parameter(Mandatory)] [byte[]] $Bytes,
        [Parameter()] [scriptblock] $CreateStream = { param($Temp) [IO.FileStream]::new($Temp, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None) },
        [Parameter()] [scriptblock] $WriteBytes = { param($Stream, $Value) $Stream.Write($Value, 0, $Value.Length) },
        [Parameter()] [scriptblock] $FlushStream = { param($Stream) $Stream.Flush($true) },
        [Parameter()] [scriptblock] $CloseStream = { param($Stream) $Stream.Dispose() },
        [Parameter()] [scriptblock] $Move = { param($Temp, $Target) [IO.File]::Move($Temp, $Target, $true) },
        [Parameter()] [scriptblock] $Replace = { param($Temp, $Target, $Backup) [IO.File]::Replace($Temp, $Target, $Backup, $true) },
        [Parameter()] [scriptblock] $Delay = { param($Milliseconds) [Threading.Thread]::Sleep($Milliseconds) },
        [Parameter()] [scriptblock] $DeleteTemp = { param($Temp) [IO.File]::Delete($Temp) }
    )

    $target = [IO.Path]::GetFullPath($Path)
    $directory = [IO.Path]::GetDirectoryName($target)
    if ([string]::IsNullOrEmpty($directory)) { throw [ArgumentException]::new('State target requires a directory.') }
    $temp = Join-Path $directory ("$([IO.Path]::GetFileName($target)).$([Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(16)).ToLowerInvariant()).tmp")
    $tempOwned = $false
    $backupOwned = $false
    $backup = $null
    try {
        try {
            $stream = & $CreateStream $temp
            $tempOwned = $true
            try {
                & $WriteBytes $stream $Bytes
                & $FlushStream $stream
            }
            finally {
                & $CloseStream $stream
            }
        }
        catch { throw [CompanionStateWriteException]::new('temp-write', $_.Exception) }

        $targetExists = [IO.File]::Exists($target)
        if ($targetExists) {
            $backup = Join-Path $directory ("$([IO.Path]::GetFileName($target)).$([Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(16)).ToLowerInvariant()).bak")
        }
        try {
            foreach ($attempt in 1..5) {
                try {
                    if ($targetExists) {
                        & $Replace $temp $target $backup
                        $backupOwned = $true
                    }
                    else {
                        & $Move $temp $target
                    }
                    $tempOwned = $false
                    break
                }
                catch [IO.IOException] {
                    if (-not (Test-SharingViolation -Exception $_.Exception) -or $attempt -eq 5) { throw }
                    & $Delay (40 * $attempt)
                }
            }
        }
        catch { throw [CompanionStateWriteException]::new('replace', $_.Exception) }
    }
    finally {
        if ($tempOwned) {
            try { & $DeleteTemp $temp } catch { }
        }
        if ($backupOwned) {
            try { & $DeleteTemp $backup } catch { }
        }
    }
}

function Write-CompanionStateJson {
    param([Parameter(Mandatory)] [string] $Path, [Parameter(Mandatory)] $Document, [Parameter(Mandatory)] [string] $Budget)

    try {
        $json = ConvertTo-CompanionJson -InputObject $Document -Budget $Budget
        $bytes = [Text.UTF8Encoding]::new($false, $true).GetBytes($json)
    }
    catch { throw [CompanionStateWriteException]::new('serialize', $_.Exception) }
    Write-CompanionStateBytes -Path $Path -Bytes $bytes
}

function Enter-CompanionStateLock {
    param([Parameter(Mandatory)] [string] $CompanionRoot, [Parameter(Mandatory)] [ValidateSet('cycle.lock', 'consume.lock')] [string] $Name, [Parameter(Mandatory)] [int] $TimeoutMilliseconds, [Parameter()] [Threading.CancellationToken] $CancellationToken = [Threading.CancellationToken]::None)

    if ($TimeoutMilliseconds -lt 0) { throw [ArgumentOutOfRangeException]::new('TimeoutMilliseconds') }
    $stateDirectory = Join-Path ([IO.Path]::GetFullPath($CompanionRoot)) 'state'
    $path = Join-Path $stateDirectory $Name
    $started = [Diagnostics.Stopwatch]::StartNew()
    while ($true) {
        $CancellationToken.ThrowIfCancellationRequested()
        try {
            return [IO.FileStream]::new($path, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
        }
        catch [IO.IOException] {
            if (-not (Test-SharingViolation -Exception $_.Exception)) { throw }
            if ($started.ElapsedMilliseconds -ge $TimeoutMilliseconds) { throw [TimeoutException]::new('Companion state lock is busy.') }
            [Threading.Thread]::Sleep([Math]::Min(25, [Math]::Max(1, $TimeoutMilliseconds - [int]$started.ElapsedMilliseconds)))
        }
    }
}

function Enter-CompanionCycleLock { param([Parameter(Mandatory)][string]$CompanionRoot, [int]$TimeoutMilliseconds = 300000, [Threading.CancellationToken]$CancellationToken = [Threading.CancellationToken]::None) return Enter-CompanionStateLock -CompanionRoot $CompanionRoot -Name 'cycle.lock' -TimeoutMilliseconds $TimeoutMilliseconds -CancellationToken $CancellationToken }
function Enter-CompanionConsumeLock { param([Parameter(Mandatory)][string]$CompanionRoot, [int]$TimeoutMilliseconds = 10000, [Threading.CancellationToken]$CancellationToken = [Threading.CancellationToken]::None) return Enter-CompanionStateLock -CompanionRoot $CompanionRoot -Name 'consume.lock' -TimeoutMilliseconds $TimeoutMilliseconds -CancellationToken $CancellationToken }

function Read-CompanionStateDigest {
    param([Parameter(Mandatory)] [string] $Path)

    try { return [pscustomobject]@{ outcome = 'valid'; document = (Read-DigestDocument -Path $Path) } }
    catch [IO.FileNotFoundException] { return [pscustomobject]@{ outcome = 'absent'; document = $null } }
    catch [IO.DirectoryNotFoundException] { return [pscustomobject]@{ outcome = 'absent'; document = $null } }
    catch [CompanionContentException] { return [pscustomobject]@{ outcome = 'content-invalid'; document = $null } }
    catch { return [pscustomobject]@{ outcome = 'infrastructure-failure'; document = $null; exception = $_.Exception } }
}

function Read-CompanionBaseline {
    param([Parameter(Mandatory)] [string] $CompanionRoot)

    return (Read-CompanionStateDigest -Path (Get-CompanionStatePath -CompanionRoot $CompanionRoot -Name $script:StateFileNames.Baseline))
}

function Read-CompanionCurrent {
    param([Parameter(Mandatory)] [string] $CompanionRoot, [AllowNull()] [AdapterCompatibilityConfig] $AdapterConfig, [switch] $PrefilterOnly)

    $read = Read-CompanionStateDigest -Path (Get-CompanionStatePath -CompanionRoot $CompanionRoot -Name $script:StateFileNames.Current)
    if ($read.outcome -cne 'valid') { return $read }
    $document = $read.document
    if ($null -eq $AdapterConfig) { return [pscustomobject]@{ outcome = 'valid'; document = $document } }
    $root = $document.RootElement
    $compatible = $root.GetProperty('schemaVersion').GetInt64() -eq (Get-CoreSchemaVersion) -and $root.GetProperty('adapterVersion').GetInt64() -eq $AdapterConfig.AdapterVersion -and [string]::Equals($root.GetProperty('game').GetString(), $AdapterConfig.Game, [StringComparison]::Ordinal) -and [string]::Equals($root.GetProperty('source').GetProperty('domainId').GetString(), $AdapterConfig.SourceDomainId, [StringComparison]::Ordinal)
    if (-not $compatible) { return [pscustomobject]@{ outcome = 'stale'; document = $null } }
    if (-not $PrefilterOnly) {
        try { Assert-AdapterDigestDocument -Document $document -AdapterConfig $AdapterConfig } catch [CompanionContentException] { return [pscustomobject]@{ outcome = 'content-invalid'; document = $null } }
    }

    return [pscustomobject]@{ outcome = 'valid'; document = $document }
}

function ConvertTo-CompanionStateDocument {
    param([Parameter(Mandatory)] $Document)

    if ($Document -is [CompanionJsonValue]) {
        return $Document.RootElement
    }

    return $Document
}

function Write-CompanionCurrent { param([Parameter(Mandatory)][string]$CompanionRoot, [Parameter(Mandatory)]$Document) Write-CompanionStateJson -Path (Get-CompanionStatePath -CompanionRoot $CompanionRoot -Name $script:StateFileNames.Current) -Document (ConvertTo-CompanionStateDocument -Document $Document) -Budget digest }
function Write-CompanionBaseline { param([Parameter(Mandatory)][string]$CompanionRoot, [Parameter(Mandatory)]$Document) Write-CompanionStateJson -Path (Get-CompanionStatePath -CompanionRoot $CompanionRoot -Name $script:StateFileNames.Baseline) -Document (ConvertTo-CompanionStateDocument -Document $Document) -Budget digest }
function Write-CompanionDiffCache { param([Parameter(Mandatory)][string]$CompanionRoot, [Parameter(Mandatory)]$Document) Write-CompanionStateJson -Path (Get-CompanionStatePath -CompanionRoot $CompanionRoot -Name $script:StateFileNames.DiffCache) -Document (ConvertTo-CompanionStateDocument -Document $Document) -Budget diff }
function Write-CompanionBookkeeping { param([Parameter(Mandatory)][string]$CompanionRoot, [Parameter(Mandatory)]$Document) Write-CompanionStateJson -Path (Get-CompanionStatePath -CompanionRoot $CompanionRoot -Name $script:StateFileNames.Bookkeeping) -Document $Document -Budget config }

function Invoke-WorkFileReaper {
    param(
        [Parameter(Mandatory)] [string] $CompanionRoot,
        [Parameter(Mandatory)] [CompanionWarningSink] $WarningSink,
        [switch] $TmpOnly,
        [Parameter()] [scriptblock] $GetMetadata = { param($Entry) [pscustomobject]@{ lastWriteTimeUtc = $Entry.LastWriteTimeUtc } }
    )

    $root = [IO.Path]::GetFullPath($CompanionRoot)
    $roots = if ($TmpOnly) { @([pscustomobject]@{ name = 'tmp'; path = (Join-Path $root '.tmp') }) } else { @([pscustomobject]@{ name = 'tmp'; path = (Join-Path $root '.tmp') }, [pscustomobject]@{ name = 'state'; path = (Join-Path $root 'state') }) }
    $encoder = [Text.UTF8Encoding]::new($false, $true)
    foreach ($candidateRoot in $roots) {
        try {
            if (-not [IO.Directory]::Exists($candidateRoot.path)) { continue }
            $entries = [Collections.Generic.List[IO.FileSystemInfo]]::new(); $nameBytes = 0L
            foreach ($entry in [IO.DirectoryInfo]::new($candidateRoot.path).EnumerateFileSystemInfos()) {
                $entries.Add($entry); $nameBytes += $encoder.GetByteCount($entry.Name)
                if ($entries.Count -gt $script:StateReaperMaximumEntries -or $nameBytes -gt $script:StateReaperMaximumNameBytes) { Add-CompanionWarning -Sink $WarningSink -Code 'pipeline-reaper-discovery-limit-exceeded' -Detail $candidateRoot.name; $entries.Clear(); break }
            }
            if ($entries.Count -eq 0 -and ($nameBytes -gt $script:StateReaperMaximumNameBytes)) { continue }
            $now = [datetime]::UtcNow
            $metadata = [Collections.Generic.Dictionary[string, object]]::new([StringComparer]::Ordinal)
            foreach ($entry in $entries) {
                try { $metadata.Add($entry.Name, (& $GetMetadata $entry)) } catch { Add-CompanionWarning -Sink $WarningSink -Code 'pipeline-cleanup-degraded' -Detail $null }
            }
            if ($candidateRoot.name -ceq 'state') {
                foreach ($entry in $entries) {
                    if ($entry -is [IO.FileInfo] -and $metadata.ContainsKey($entry.Name) -and $metadata[$entry.Name].lastWriteTimeUtc -lt $now.Subtract($script:StateTempAge) -and $entry.Name -cmatch $script:StateTempReaperPattern) { try { [IO.File]::Delete($entry.FullName) } catch { Add-CompanionWarning -Sink $WarningSink -Code 'pipeline-cleanup-degraded' -Detail $null } }
                }
                continue
            }
            $leasedMemberNames = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
            $leases = @($entries | Where-Object { $_ -is [IO.FileInfo] -and $_.Name -cmatch $script:WorkLeaseNamePattern })
            foreach ($lease in $leases) {
                $groupPrefix = $lease.Name.Substring(0, $lease.Name.Length - '.lease'.Length) + '-'
                [void] $leasedMemberNames.Add($lease.Name)
                foreach ($member in $entries | Where-Object { $_ -is [IO.FileInfo] -and $_.Name.StartsWith($groupPrefix, [StringComparison]::Ordinal) }) {
                    [void] $leasedMemberNames.Add($member.Name)
                }
            }
            foreach ($lease in $leases) {
                $groupPrefix = $lease.Name.Substring(0, $lease.Name.Length - '.lease'.Length) + '-'
                $groupEntries = @($entries | Where-Object { $_.Name -ceq $lease.Name -or $_.Name.StartsWith($groupPrefix, [StringComparison]::Ordinal) })
                if (@($groupEntries | Where-Object { -not $metadata.ContainsKey($_.Name) }).Count -ne 0) { continue }
                if ($metadata[$lease.Name].lastWriteTimeUtc -ge $now.Subtract($script:StateTempAge)) { continue }
                try { $probe = [IO.FileStream]::new($lease.FullName, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None) } catch [IO.IOException] { continue } catch { Add-CompanionWarning -Sink $WarningSink -Code 'pipeline-cleanup-degraded' -Detail $null; continue }
                $probe.Dispose()
                foreach ($member in $groupEntries | Where-Object { $_ -is [IO.FileInfo] -and $_.Name -cne $lease.Name }) {
                    try { [IO.File]::Delete($member.FullName) } catch { Add-CompanionWarning -Sink $WarningSink -Code 'pipeline-cleanup-degraded' -Detail $null }
                }
                try { [IO.File]::Delete($lease.FullName) } catch { Add-CompanionWarning -Sink $WarningSink -Code 'pipeline-cleanup-degraded' -Detail $null }
            }
            foreach ($entry in $entries | Where-Object { $_ -is [IO.FileInfo] -and $metadata.ContainsKey($_.Name) -and $_.Name.StartsWith('work-', [StringComparison]::Ordinal) -and -not $leasedMemberNames.Contains($_.Name) -and $metadata[$_.Name].lastWriteTimeUtc -lt $now.Subtract($script:StateTempAge) }) { try { [IO.File]::Delete($entry.FullName) } catch { Add-CompanionWarning -Sink $WarningSink -Code 'pipeline-cleanup-degraded' -Detail $null } }
        }
        catch { Add-CompanionWarning -Sink $WarningSink -Code 'pipeline-cleanup-degraded' -Detail $null }
    }
}
