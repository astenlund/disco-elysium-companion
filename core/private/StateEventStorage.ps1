# Capacity is checked from a complete lock-scoped inventory before any allocation.
# Failed cleanup remains charged on the next read; no inventory survives an operation.
function Get-StateEventInventory {
    param([Parameter(Mandatory)] [string] $Path, [int] $Limit = $script:StateEventDiscoveryLimit)

    $entries = [Collections.Generic.List[IO.FileSystemInfo]]::new()
    foreach ($entry in [IO.DirectoryInfo]::new($Path).EnumerateFileSystemInfos()) {
        if ($entries.Count -ge $Limit) { throw [IO.IOException]::new('State-event directory discovery limit exceeded.') }
        $entries.Add($entry)
    }

    return [pscustomobject]@{ path = $Path; entries = $entries; count = $entries.Count }
}

function Test-StateEventOrdinaryFile {
    param([Parameter(Mandatory)] [IO.FileSystemInfo] $Entry)

    return $Entry -is [IO.FileInfo] -and ($Entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0
}

function Get-StateEventLedgerWriteSlots {
    param([Parameter(Mandatory)] [string] $OutboxPath)

    try {
        $attributes = [IO.File]::GetAttributes((Join-Path $OutboxPath $script:StateEventLedgerFileName))
        if (($attributes -band ([IO.FileAttributes]::Directory -bor [IO.FileAttributes]::ReparsePoint)) -ne 0) { throw [IO.IOException]::new('The ledger target is not an ordinary file.') }

        return 2
    }
    catch [IO.FileNotFoundException], [IO.DirectoryNotFoundException] {
        return 1
    }
}

function Get-StateEventQuarantineDirectorySlots {
    param([Parameter(Mandatory)] [string] $OutboxPath)

    try {
        $attributes = [IO.File]::GetAttributes((Join-Path $OutboxPath $script:StateEventQuarantineName))
        if (($attributes -band [IO.FileAttributes]::Directory) -eq 0 -or ($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw [IO.IOException]::new('The quarantine target is not an ordinary directory.') }

        return 0
    }
    catch [IO.FileNotFoundException], [IO.DirectoryNotFoundException] {
        return 1
    }
}

function Assert-StateEventAllocation {
    param(
        [Parameter(Mandatory)] [string] $OutboxPath,
        [Parameter(Mandatory)] [int] $AdditionalSlots,
        [int] $ReservedSlots = 0,
        [int] $Ceiling = $script:StateEventDiscoveryLimit
    )

    if ($AdditionalSlots -lt 0 -or $ReservedSlots -lt 0) { throw [ArgumentOutOfRangeException]::new('AdditionalSlots') }
    $inventory = Get-StateEventInventory -Path $OutboxPath
    if ([long] $inventory.count + $AdditionalSlots + $ReservedSlots -gt $Ceiling) { throw [IO.IOException]::new('State-event recovery workspace is unavailable.') }
}

function Remove-StateEventPublicationSiblings {
    param([Parameter(Mandatory)] $Inventory, [Parameter(Mandatory)] [CompanionWarningSink] $WarningSink)

    foreach ($entry in $Inventory.entries) {
        if (-not (Test-StateEventPublicationSiblingName -Name $entry.Name)) { continue }
        try {
            if (-not (Test-StateEventOrdinaryFile -Entry $entry)) { continue }
            [IO.File]::Delete($entry.FullName)
        }
        catch { Add-CompanionWarning -Sink $WarningSink -Code 'pipeline-cleanup-degraded' -Detail $null }
    }
}

function Assert-StateEventRetirementHash {
    param([Parameter(Mandatory)] [string] $Path, [Parameter(Mandatory)] [string] $ExpectedSha256)

    $file = Read-StateEventRecordBytes -Path $Path
    if (-not [string]::Equals($file.sha256, $ExpectedSha256, [StringComparison]::Ordinal)) { throw [IO.IOException]::new('The retired record bytes changed.') }
}

function Prepare-StateEventQuarantine {
    param([Parameter(Mandatory)] [string] $OutboxPath)

    $newDirectory = Get-StateEventQuarantineDirectorySlots -OutboxPath $OutboxPath
    if ($newDirectory -gt 0) {
        Assert-StateEventAllocation -OutboxPath $OutboxPath -AdditionalSlots $newDirectory
        [void] [IO.Directory]::CreateDirectory((Join-Path $OutboxPath $script:StateEventQuarantineName))
    }
    $quarantine = Join-Path $OutboxPath $script:StateEventQuarantineName
    $inventory = Get-StateEventInventory -Path $quarantine
    $candidates = [Collections.Generic.List[IO.FileSystemInfo]]::new()
    foreach ($entry in $inventory.entries) {
        if ((Test-StateEventQuarantineRecordName -Name $entry.Name) -and (Test-StateEventOrdinaryFile -Entry $entry)) {
            # Read metadata before pruning so a failed observation never gives a partial order.
            [void] $entry.LastWriteTimeUtc
            $candidates.Add($entry)
        }
    }
    $candidates.Sort([Comparison[IO.FileSystemInfo]] {
        param($left, $right)
        $order = [DateTime]::Compare($left.LastWriteTimeUtc, $right.LastWriteTimeUtc)
        if ($order -ne 0) { return $order }

        return [string]::CompareOrdinal($left.Name, $right.Name)
    })
    foreach ($entry in $candidates) {
        if ($inventory.count -lt $script:StateEventQuarantineMaximumEntries) { break }
        [IO.File]::Delete($entry.FullName)
        $inventory = Get-StateEventInventory -Path $quarantine
    }
    if ($inventory.count -ge $script:StateEventQuarantineMaximumEntries) { throw [IO.IOException]::new('No quarantine slot is available.') }

    return $quarantine
}

function Move-StateEventRecordToQuarantine {
    param(
        [Parameter(Mandatory)] [string] $OutboxPath,
        [Parameter(Mandatory)] [string] $Name,
        [Parameter(Mandatory)] [CompanionWarningSink] $WarningSink,
        [AllowNull()] [string] $ExpectedSha256 = $null
    )

    try {
        if ([string]::IsNullOrEmpty($ExpectedSha256)) { throw [ArgumentException]::new('Quarantine requires exact retirement evidence.') }
        $source = Join-Path $OutboxPath $Name
        Assert-StateEventRetirementHash -Path $source -ExpectedSha256 $ExpectedSha256
        $quarantine = Prepare-StateEventQuarantine -OutboxPath $OutboxPath
        Assert-StateEventRetirementHash -Path $source -ExpectedSha256 $ExpectedSha256
        $target = Join-Path $quarantine ("$Name.$(New-StateEventIncarnationId).invalid")
        [IO.File]::Move($source, $target, $false)
    }
    catch { Add-CompanionWarning -Sink $WarningSink -Code 'pipeline-cleanup-degraded' -Detail $null }
}
