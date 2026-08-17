#Requires -Version 7.5

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Import-Module (Join-Path (Split-Path $PSScriptRoot -Parent) 'DigestDiff.psm1') -Force -DisableNameChecking

$script:ProjectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$script:ProjectTmpRoot = [IO.Path]::GetFullPath((Join-Path $script:ProjectRoot '.tmp'))

function Get-LiveCanonicalPath {
    param([Parameter(Mandatory)] [string] $Path)

    $fullPath = [IO.Path]::GetFullPath($Path)
    $root = [IO.Path]::GetPathRoot($fullPath)
    while ($fullPath.Length -gt $root.Length -and ($fullPath.EndsWith([IO.Path]::DirectorySeparatorChar) -or $fullPath.EndsWith([IO.Path]::AltDirectorySeparatorChar))) {
        $fullPath = $fullPath.Substring(0, $fullPath.Length - 1)
    }

    return $fullPath
}

function Test-LivePathAtOrBelow {
    param(
        [Parameter(Mandatory)] [string] $Path,
        [Parameter(Mandatory)] [string] $Root
    )

    if ([string]::Equals($Path, $Root, [StringComparison]::OrdinalIgnoreCase)) {
        return $true
    }

    $rootPrefix = $Root + [IO.Path]::DirectorySeparatorChar
    return $Path.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)
}

function Assert-LiveScratchBoundary {
    param(
        [Parameter(Mandatory)] [string] $ScratchRoot,
        [Parameter()] [AllowNull()] [string] $SaveDirectory
    )

    $projectTmpRoot = Get-LiveCanonicalPath -Path $script:ProjectTmpRoot
    $scratch = Get-LiveCanonicalPath -Path $ScratchRoot
    if (-not (Test-Path -LiteralPath $projectTmpRoot -PathType Container)) {
        throw [DirectoryNotFoundException]::new("The project scratch root does not exist: $projectTmpRoot")
    }
    if (-not (Test-Path -LiteralPath $scratch -PathType Container)) {
        throw [DirectoryNotFoundException]::new("The live-probe scratch directory does not exist: $scratch")
    }
    if ([string]::Equals($scratch, $projectTmpRoot, [StringComparison]::OrdinalIgnoreCase) -or -not (Test-LivePathAtOrBelow -Path $scratch -Root $projectTmpRoot)) {
        throw [ArgumentException]::new("The live-probe scratch directory must be a strict descendant of the project .tmp directory.", 'ScratchRoot')
    }

    $current = [IO.DirectoryInfo]::new($scratch)
    while ($null -ne $current) {
        $current.Refresh()
        if (-not $current.Exists) {
            throw [DirectoryNotFoundException]::new("A live-probe scratch ancestor does not exist: $($current.FullName)")
        }
        if (($current.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw [ArgumentException]::new("The live-probe scratch path must not traverse a reparse point: $($current.FullName)", 'ScratchRoot')
        }
        if ([string]::Equals($current.FullName, $projectTmpRoot, [StringComparison]::OrdinalIgnoreCase)) {
            break
        }

        $current = $current.Parent
    }
    if ($null -eq $current) {
        throw [ArgumentException]::new('The live-probe scratch path does not resolve beneath the project .tmp directory.', 'ScratchRoot')
    }

    if ($null -ne $SaveDirectory) {
        $save = Get-LiveCanonicalPath -Path $SaveDirectory
        if ((Test-LivePathAtOrBelow -Path $scratch -Root $save) -or (Test-LivePathAtOrBelow -Path $save -Root $scratch)) {
            throw [ArgumentException]::new('The live-probe scratch directory must not overlap the save source directory.', 'ScratchRoot')
        }
    }
}

function Test-LiveSaveGlobMatch {
    param(
        [Parameter(Mandatory)] [string] $Name,
        [Parameter(Mandatory)] [Management.Automation.WildcardPattern] $Pattern
    )

    return $Pattern.IsMatch($Name)
}

function Get-LiveSaveMode {
    param([Parameter(Mandatory)] [string] $Name)

    if ($Name.StartsWith('AutoSave', [StringComparison]::OrdinalIgnoreCase)) {
        return 'autosave'
    }
    if ($Name.StartsWith('QuickSave', [StringComparison]::OrdinalIgnoreCase)) {
        return 'quicksave'
    }

    return 'manual'
}

function New-LiveFrameMap {
    param([Parameter(Mandatory)] [AllowEmptyCollection()] [object[]] $Files)

    $map = [Collections.Generic.Dictionary[string, object]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($file in $Files) {
        $map.Add([string] $file.Name, $file)
    }

    return $map
}

function Test-LiveFingerprintEqual {
    param(
        [Parameter(Mandatory)] $Left,
        [Parameter(Mandatory)] $Right
    )

    return [long] $Left.Length -eq [long] $Right.Length -and
        [datetime] $Left.LastWriteTimeUtc -eq [datetime] $Right.LastWriteTimeUtc -and
        [string]::Equals([string] $Left.Hash, [string] $Right.Hash, [StringComparison]::Ordinal)
}

function Add-LiveSaveEvent {
    param(
        [Parameter(Mandatory)] [hashtable] $State,
        [Parameter(Mandatory)] $File,
        [Parameter(Mandatory)] [bool] $LiveObserved
    )

    if (-not [bool] $File.Stable) {
        return $false
    }

    $identity = "$($File.Name)|$(([datetime] $File.LastWriteTimeUtc).Ticks)|$($File.Length)|$($File.Hash)"
    if (-not $State.EventIdentities.Add($identity)) {
        return $false
    }

    $State.SaveEventCount++
    $State.StableArchiveCount++
    if (-not [bool] $File.ZipValid) {
        $State.UnzipFailureCount++
    }

    switch (Get-LiveSaveMode -Name $File.Name) {
        'manual' { $State.ManualSaveCount++ }
        'quicksave' { $State.QuicksaveCount++ }
        'autosave' {
            $State.AutosaveCount++
            if ($LiveObserved) {
                $State.LiveAutosaveCount++
            }
        }
    }

    return $true
}

function Measure-Section11LiveSaveFrames {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [object[]] $Frames,
        [Parameter(Mandatory)] [datetime] $SessionStartedAtUtc,
        [Parameter()] [Nullable[datetime]] $MonitorStartedAtUtc,
        [Parameter()] [string] $SaveGlob = '*.ntwtf.zip',
        [Parameter()] [switch] $CloudSyncEnabled
    )

    if ($Frames.Count -eq 0) {
        throw [ArgumentException]::new('At least one observation frame is required.', 'Frames')
    }

    $pattern = [Management.Automation.WildcardPattern]::new($SaveGlob, [Management.Automation.WildcardOptions]::IgnoreCase)
    $liveBoundary = if ($null -ne $MonitorStartedAtUtc) { ([datetime] $MonitorStartedAtUtc).ToUniversalTime() } else { $SessionStartedAtUtc.ToUniversalTime() }
    $state = @{
        EventIdentities = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
        SaveEventCount = 0
        StableArchiveCount = 0
        UnzipFailureCount = 0
        ManualSaveCount = 0
        QuicksaveCount = 0
        AutosaveCount = 0
        LiveAutosaveCount = 0
        OlderCandidateSurvivorComparisonCount = 0
    }
    $mutatedCandidates = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    $rewrittenOutsideGlob = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    $rotationObserved = $false
    $matchingRemovalObserved = $false

    $previous = New-LiveFrameMap -Files @($Frames[0].Files)
    foreach ($file in $previous.Values) {
        if (-not (Test-LiveSaveGlobMatch -Name $file.Name -Pattern $pattern) -or [datetime] $file.LastWriteTimeUtc -lt $SessionStartedAtUtc.ToUniversalTime()) {
            continue
        }

        $liveObserved = [datetime] $file.LastWriteTimeUtc -ge $liveBoundary
        [void] (Add-LiveSaveEvent -State $state -File $file -LiveObserved:$liveObserved)
    }

    for ($frameIndex = 1; $frameIndex -lt $Frames.Count; $frameIndex++) {
        $current = New-LiveFrameMap -Files @($Frames[$frameIndex].Files)
        $removedMatchingCandidate = $false
        foreach ($name in $previous.Keys) {
            if (-not $current.ContainsKey($name) -and (Test-LiveSaveGlobMatch -Name $name -Pattern $pattern)) {
                $removedMatchingCandidate = $true
                $matchingRemovalObserved = $true
            }
        }

        $addedMatchingCandidate = $false
        foreach ($file in $current.Values) {
            $isSave = Test-LiveSaveGlobMatch -Name $file.Name -Pattern $pattern
            if ($previous.ContainsKey($file.Name)) {
                if (Test-LiveFingerprintEqual -Left $previous[$file.Name] -Right $file) {
                    continue
                }

                if ($isSave) {
                    if (-not [bool] $previous[$file.Name].Stable) {
                        $liveObserved = [datetime] $file.LastWriteTimeUtc -ge $liveBoundary
                        $eventAdded = Add-LiveSaveEvent -State $state -File $file -LiveObserved:$liveObserved
                        $addedMatchingCandidate = $addedMatchingCandidate -or $eventAdded
                        continue
                    }

                    [void] $mutatedCandidates.Add($file.Name)
                }
                else {
                    [void] $rewrittenOutsideGlob.Add($file.Name)
                }

                continue
            }

            if (-not $isSave) {
                continue
            }

            $liveObserved = [datetime] $file.LastWriteTimeUtc -ge $liveBoundary
            $eventAdded = Add-LiveSaveEvent -State $state -File $file -LiveObserved:$liveObserved
            $addedMatchingCandidate = $addedMatchingCandidate -or $eventAdded
        }

        if ($addedMatchingCandidate) {
            foreach ($name in $previous.Keys) {
                if (-not $current.ContainsKey($name) -or -not (Test-LiveSaveGlobMatch -Name $name -Pattern $pattern)) {
                    continue
                }

                $previousFile = $previous[$name]
                $currentFile = $current[$name]
                if ([bool] $previousFile.Stable -and [bool] $currentFile.Stable -and (Test-LiveFingerprintEqual -Left $previousFile -Right $currentFile)) {
                    $state.OlderCandidateSurvivorComparisonCount++
                }
            }
        }

        if (($removedMatchingCandidate -or $matchingRemovalObserved) -and $addedMatchingCandidate) {
            $rotationObserved = $true
        }

        $previous = $current
    }

    $section11_56Passed = $state.SaveEventCount -ge 5 -and $state.LiveAutosaveCount -ge 1 -and $state.UnzipFailureCount -eq 0
    $section11_59Passed = $state.ManualSaveCount -ge 2 -and $state.QuicksaveCount -ge 1 -and $state.LiveAutosaveCount -ge 1 -and $state.OlderCandidateSurvivorComparisonCount -gt 0 -and $rotationObserved -and $CloudSyncEnabled.IsPresent -and $mutatedCandidates.Count -eq 0

    return [pscustomobject]@{
        SaveEventCount = $state.SaveEventCount
        StableArchiveCount = $state.StableArchiveCount
        UnzipFailureCount = $state.UnzipFailureCount
        ManualSaveCount = $state.ManualSaveCount
        QuicksaveCount = $state.QuicksaveCount
        AutosaveCount = $state.AutosaveCount
        LiveAutosaveCount = $state.LiveAutosaveCount
        OlderCandidateSurvivorComparisonCount = $state.OlderCandidateSurvivorComparisonCount
        OlderCandidateMutationCount = $mutatedCandidates.Count
        RewrittenOutsideGlobCount = $rewrittenOutsideGlob.Count
        RotationObserved = $rotationObserved
        CloudSyncEnabled = $CloudSyncEnabled.IsPresent
        Section11_56Passed = $section11_56Passed
        Section11_59Passed = $section11_59Passed
    }
}

function Test-Section11LiveArchive {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [string] $Path,
        [Parameter(Mandatory)] [string] $ScratchRoot,
        [Parameter()] [int] $SampleDelayMilliseconds = 2000
    )

    $sourceDirectory = $null
    try {
        $sourceDirectory = [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($Path))
    }
    catch [ArgumentException] {
        # The production stability sampler classifies malformed source paths through its typed channel.
    }
    Assert-LiveScratchBoundary -ScratchRoot $ScratchRoot -SaveDirectory $sourceDirectory

    if (-not (Test-FileWriteStable -Path $Path -SampleDelayMilliseconds $SampleDelayMilliseconds)) {
        return [pscustomobject]@{ Stable = $false; ZipValid = $false; Length = 0L; Hash = $null; LastWriteTimeUtc = $null }
    }

    $source = [IO.FileInfo]::new($Path)
    $source.Refresh()
    $copyPath = Join-Path $ScratchRoot ("live-save-$([guid]::NewGuid().ToString('N')).zip")
    try {
        [IO.File]::Copy($source.FullName, $copyPath, $false)
        $zipValid = $true
        try {
            $archive = [IO.Compression.ZipFile]::OpenRead($copyPath)
            try {
                [void] $archive.Entries.Count
            }
            finally {
                $archive.Dispose()
            }
        }
        catch [IO.InvalidDataException] {
            $zipValid = $false
        }

        return [pscustomobject]@{
            Stable = $true
            ZipValid = $zipValid
            Length = $source.Length
            Hash = (Get-FileHash -LiteralPath $copyPath -Algorithm SHA256).Hash.ToLowerInvariant()
            LastWriteTimeUtc = $source.LastWriteTimeUtc
        }
    }
    finally {
        if (Test-Path -LiteralPath $copyPath -PathType Leaf) {
            Remove-Item -LiteralPath $copyPath -Force -Confirm:$false
        }
    }
}

function Get-LiveFileHash {
    param([Parameter(Mandatory)] [string] $Path)

    $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete)
    try {
        $hash = [Security.Cryptography.IncrementalHash]::CreateHash([Security.Cryptography.HashAlgorithmName]::SHA256)
        try {
            $buffer = [byte[]]::new(65536)
            while (($read = $stream.Read($buffer, 0, $buffer.Length)) -gt 0) {
                $hash.AppendData($buffer, 0, $read)
            }

            return [Convert]::ToHexString($hash.GetHashAndReset()).ToLowerInvariant()
        }
        finally {
            $hash.Dispose()
        }
    }
    finally {
        $stream.Dispose()
    }
}

function Get-Section11LiveSaveFrame {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [string] $SaveDirectory,
        [Parameter(Mandatory)] [string] $ScratchRoot,
        [Parameter(Mandatory)] [datetime] $SessionStartedAtUtc,
        [Parameter()] [string] $SaveGlob = '*.ntwtf.zip',
        [Parameter()] [int] $SampleDelayMilliseconds = 2000,
        [Parameter()] $KnownFrame,
        [Parameter()] [scriptblock] $ArchiveValidator
    )

    Assert-LiveScratchBoundary -ScratchRoot $ScratchRoot -SaveDirectory $SaveDirectory

    $pattern = [Management.Automation.WildcardPattern]::new($SaveGlob, [Management.Automation.WildcardOptions]::IgnoreCase)
    $known = [Collections.Generic.Dictionary[string, object]]::new([StringComparer]::OrdinalIgnoreCase)
    if ($null -ne $KnownFrame) {
        foreach ($record in @($KnownFrame.Files)) {
            $known.Add([string] $record.Name, $record)
        }
    }

    $records = [Collections.Generic.List[object]]::new()
    $files = [IO.Directory]::EnumerateFiles($SaveDirectory, '*', [IO.SearchOption]::TopDirectoryOnly)
    foreach ($path in $files) {
        try {
            $file = [IO.FileInfo]::new($path)
            $file.Refresh()
            if (-not $file.Exists) {
                continue
            }

            $isSave = $pattern.IsMatch($file.Name)
            $knownRecord = if ($known.ContainsKey($file.Name)) { $known[$file.Name] } else { $null }
            $metadataChanged = $null -eq $knownRecord -or [long] $knownRecord.Length -ne $file.Length -or [datetime] $knownRecord.LastWriteTimeUtc -ne $file.LastWriteTimeUtc
            $requiresLiveValidation = $isSave -and $file.LastWriteTimeUtc -ge $SessionStartedAtUtc.ToUniversalTime() -and ($metadataChanged -or ($null -ne $knownRecord -and -not [bool] $knownRecord.Stable))
            if ($requiresLiveValidation) {
                $validation = if ($null -ne $ArchiveValidator) {
                    & $ArchiveValidator $file.FullName $ScratchRoot $SampleDelayMilliseconds
                }
                else {
                    Test-Section11LiveArchive -Path $file.FullName -ScratchRoot $ScratchRoot -SampleDelayMilliseconds $SampleDelayMilliseconds
                }
                $records.Add([pscustomobject]@{
                        Name = $file.Name
                        Length = if ($validation.Stable) { $validation.Length } else { $file.Length }
                        LastWriteTimeUtc = if ($validation.Stable) { $validation.LastWriteTimeUtc } else { $file.LastWriteTimeUtc }
                        Hash = $validation.Hash
                        Stable = $validation.Stable
                        ZipValid = $validation.ZipValid
                    })
                continue
            }

            $records.Add([pscustomobject]@{
                    Name = $file.Name
                    Length = $file.Length
                    LastWriteTimeUtc = $file.LastWriteTimeUtc
                    Hash = Get-LiveFileHash -Path $file.FullName
                    Stable = $isSave
                    ZipValid = $isSave
                })
        }
        catch [IO.FileNotFoundException] {
            continue
        }
        catch {
            if ([string]::Equals($_.Exception.GetType().Name, 'SaveSourceException', [StringComparison]::Ordinal) -and
                [string]::Equals([string] $_.Exception.SourceDisposition, 'vanished', [StringComparison]::Ordinal)) {
                continue
            }

            throw
        }
    }

    $ordered = $records.ToArray()
    [Array]::Sort($ordered, [Comparison[object]] {
            param($left, $right)

            return [string]::CompareOrdinal([string] $left.Name, [string] $right.Name)
        })

    return [pscustomobject]@{ Files = @($ordered) }
}

function Invoke-Section11LiveSaveMonitor {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [string] $SaveDirectory,
        [Parameter(Mandatory)] [string] $ScratchRoot,
        [Parameter(Mandatory)] [datetime] $SessionStartedAtUtc,
        [Parameter()] [Nullable[datetime]] $MonitorStartedAtUtc,
        [Parameter()] [string] $SaveGlob = '*.ntwtf.zip',
        [Parameter()] [switch] $CloudSyncEnabled,
        [Parameter()] [int] $TimeoutSeconds = 2700,
        [Parameter()] [int] $PollMilliseconds = 500,
        [Parameter()] [scriptblock] $FrameProvider,
        [Parameter()] [scriptblock] $SleepAction
    )

    if ($TimeoutSeconds -le 0) {
        throw [ArgumentOutOfRangeException]::new('TimeoutSeconds')
    }
    if ($PollMilliseconds -le 0) {
        throw [ArgumentOutOfRangeException]::new('PollMilliseconds')
    }

    $frames = [Collections.Generic.List[object]]::new()
    $stopwatch = [Diagnostics.Stopwatch]::StartNew()
    $liveBoundary = if ($null -ne $MonitorStartedAtUtc) { ([datetime] $MonitorStartedAtUtc).ToUniversalTime() } else { [datetime]::UtcNow }
    $knownFrame = $null
    while ($stopwatch.Elapsed.TotalSeconds -lt $TimeoutSeconds) {
        $frame = if ($null -ne $FrameProvider) {
            & $FrameProvider $knownFrame
        }
        else {
            Get-Section11LiveSaveFrame -SaveDirectory $SaveDirectory -SaveGlob $SaveGlob -ScratchRoot $ScratchRoot -SessionStartedAtUtc $SessionStartedAtUtc -KnownFrame $knownFrame
        }
        $frames.Add($frame)
        $knownFrame = $frame
        $measurement = Measure-Section11LiveSaveFrames -Frames $frames.ToArray() -SessionStartedAtUtc $SessionStartedAtUtc -MonitorStartedAtUtc $liveBoundary -SaveGlob $SaveGlob -CloudSyncEnabled:$CloudSyncEnabled
        if ($measurement.UnzipFailureCount -gt 0) {
            throw [InvalidOperationException]::new("The live save monitor observed $($measurement.UnzipFailureCount) stable archive(s) that failed ZIP validation.")
        }
        if ($measurement.OlderCandidateMutationCount -gt 0) {
            throw [InvalidOperationException]::new("The live save monitor observed $($measurement.OlderCandidateMutationCount) older matching candidate(s) mutate in place.")
        }
        if ($measurement.Section11_56Passed -and $measurement.Section11_59Passed) {
            $measurement | Add-Member -NotePropertyName FrameCount -NotePropertyValue $frames.Count
            $measurement | Add-Member -NotePropertyName TimedOut -NotePropertyValue $false
            return $measurement
        }

        if ($null -ne $SleepAction) {
            & $SleepAction $PollMilliseconds
        }
        else {
            [Threading.Thread]::Sleep($PollMilliseconds)
        }
    }

    $measurement | Add-Member -NotePropertyName FrameCount -NotePropertyValue $frames.Count
    $measurement | Add-Member -NotePropertyName TimedOut -NotePropertyValue $true
    return $measurement
}

Export-ModuleMember -Function Get-Section11LiveSaveFrame, Invoke-Section11LiveSaveMonitor, Measure-Section11LiveSaveFrames, Test-Section11LiveArchive
