#Requires -Version 7.5

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Import-Module (Join-Path $PSScriptRoot 'TestSupport.psm1') -Force

$modulePath = Join-Path $PSScriptRoot 'Section11LiveProbeSupport.psm1'
Assert-True -Condition (Test-Path -LiteralPath $modulePath -PathType Leaf) -Message 'the section 11 live-probe support module must exist'
Import-Module $modulePath -Force
Assert-True -Condition ($null -ne (Get-Command Get-Section11LiveSaveFrame -ErrorAction SilentlyContinue)) -Message 'the support module must expose live frame capture'
Assert-True -Condition ($null -ne (Get-Command Invoke-Section11LiveSaveMonitor -ErrorAction SilentlyContinue)) -Message 'the support module must expose the joint live monitor'

function New-ProbeFile {
    param(
        [Parameter(Mandatory)] [string] $Name,
        [Parameter(Mandatory)] [string] $Timestamp,
        [Parameter(Mandatory)] [string] $Hash,
        [Parameter()] [long] $Length = 100,
        [Parameter()] [bool] $Stable = $true,
        [Parameter()] [bool] $ZipValid = $true
    )

    return [pscustomobject]@{
        Name = $Name
        Length = $Length
        LastWriteTimeUtc = [datetime]::Parse($Timestamp, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AssumeUniversal).ToUniversalTime()
        Hash = $Hash
        Stable = $Stable
        ZipValid = $ZipValid
    }
}

function New-ProbeFrame {
    param([Parameter()] [object[]] $Files = @())

    return [pscustomobject]@{ Files = @($Files) }
}

function New-ValidProbeArchive {
    param(
        [Parameter(Mandatory)] [string] $Path,
        [Parameter()] [string] $Content = 'probe'
    )

    $zip = [IO.Compression.ZipFile]::Open($Path, [IO.Compression.ZipArchiveMode]::Create)
    try {
        $entry = $zip.CreateEntry('probe.txt')
        $writer = [IO.StreamWriter]::new($entry.Open())
        try {
            $writer.Write($Content)
        }
        finally {
            $writer.Dispose()
        }
    }
    finally {
        $zip.Dispose()
    }
}

function Test-FramesCloseBothClaimsWithoutMeaningfulGameChanges {
    # Production mutation caught: omitting retrospective session files or treating
    # an allowed non-save rewrite as a save mutation makes this result fail.
    # Arrange
    $sessionStart = [datetime]'2026-08-16T23:24:28Z'
    $monitorStart = [datetime]'2026-08-16T23:34:00Z'
    $oldManual = New-ProbeFile -Name 'manual-old.ntwtf.zip' -Timestamp '2026-08-15T10:00:00Z' -Hash 'old-manual'
    $oldAuto = New-ProbeFile -Name 'AutoSave-old.ntwtf.zip' -Timestamp '2026-08-15T10:01:00Z' -Hash 'old-auto'
    $sessionManual = New-ProbeFile -Name 'manual-session.ntwtf.zip' -Timestamp '2026-08-16T23:31:33Z' -Hash 'manual-session'
    $cloudBefore = New-ProbeFile -Name 'steam_autocloud.vdf' -Timestamp '2026-08-16T23:24:28Z' -Hash 'cloud-before' -Length 50 -ZipValid:$false
    $cloudAfter = New-ProbeFile -Name 'steam_autocloud.vdf' -Timestamp '2026-08-16T23:40:00Z' -Hash 'cloud-after' -Length 50 -ZipValid:$false
    $manualOverwrite = New-ProbeFile -Name 'manual-overwrite.ntwtf.zip' -Timestamp '2026-08-16T23:35:00Z' -Hash 'manual-overwrite'
    $quick = New-ProbeFile -Name 'QuickSave-session.ntwtf.zip' -Timestamp '2026-08-16T23:36:00Z' -Hash 'quick'
    $autoOne = New-ProbeFile -Name 'AutoSave-session-1.ntwtf.zip' -Timestamp '2026-08-16T23:37:00Z' -Hash 'auto-one'
    $autoTwo = New-ProbeFile -Name 'AutoSave-session-2.ntwtf.zip' -Timestamp '2026-08-16T23:38:00Z' -Hash 'auto-two'
    $frames = @(
        (New-ProbeFrame -Files @($oldManual, $oldAuto, $sessionManual, $cloudBefore)),
        (New-ProbeFrame -Files @($oldAuto, $sessionManual, $manualOverwrite, $cloudAfter)),
        (New-ProbeFrame -Files @($oldAuto, $sessionManual, $manualOverwrite, $quick, $cloudAfter)),
        (New-ProbeFrame -Files @($oldAuto, $sessionManual, $manualOverwrite, $quick, $autoOne, $cloudAfter)),
        (New-ProbeFrame -Files @($sessionManual, $manualOverwrite, $quick, $autoOne, $autoTwo, $cloudAfter))
    )

    # Act
    $result = Measure-Section11LiveSaveFrames -Frames $frames -SessionStartedAtUtc $sessionStart -MonitorStartedAtUtc $monitorStart -SaveGlob '*.ntwtf.zip' -CloudSyncEnabled

    # Assert
    Assert-Equal -Actual $result.SaveEventCount -Expected 5 -Message 'the retrospective manual save and four live saves count as five session events'
    Assert-Equal -Actual $result.LiveAutosaveCount -Expected 2 -Message 'both autosaves are observed after monitoring starts'
    Assert-Equal -Actual $result.ManualSaveCount -Expected 2 -Message 'manual creation and overwrite replacement are classified as manual saves'
    Assert-Equal -Actual $result.QuicksaveCount -Expected 1 -Message 'the quicksave is classified separately'
    Assert-Equal -Actual $result.AutosaveCount -Expected 2 -Message 'the autosaves are classified separately'
    Assert-Equal -Actual $result.OlderCandidateMutationCount -Expected 0 -Message 'surviving older save candidates remain immutable'
    Assert-Equal -Actual $result.UnzipFailureCount -Expected 0 -Message 'every stable session archive is a valid ZIP'
    Assert-Equal -Actual $result.RewrittenOutsideGlobCount -Expected 1 -Message 'the cloud metadata rewrite is recorded outside saveGlob'
    Assert-True -Condition $result.RotationObserved -Message 'removal of older candidates while later saves arrive records rotation or overwrite behavior'
    Assert-True -Condition ($result.OlderCandidateSurvivorComparisonCount -gt 0) -Message 'at least one older matching candidate is compared after a later save'
    Assert-True -Condition $result.Section11_56Passed -Message 'five saves with a live autosave and zero unzip failures close row 56'
    Assert-True -Condition $result.Section11_59Passed -Message 'all save modes, rotation, cloud, and immutability close row 59'
}

function Test-MatchingCandidateMutationFailsImmutabilityClaim {
    # Production mutation caught: comparing only candidate names and ignoring
    # hash, size, or timestamp changes would incorrectly pass row 59.
    # Arrange
    $sessionStart = [datetime]'2026-08-16T23:24:28Z'
    $before = New-ProbeFile -Name 'manual-old.ntwtf.zip' -Timestamp '2026-08-15T10:00:00Z' -Hash 'before'
    $after = New-ProbeFile -Name 'manual-old.ntwtf.zip' -Timestamp '2026-08-16T23:35:00Z' -Hash 'after' -Length 101
    $newSave = New-ProbeFile -Name 'AutoSave-new.ntwtf.zip' -Timestamp '2026-08-16T23:35:01Z' -Hash 'new'

    # Act
    $frames = @((New-ProbeFrame -Files @($before)), (New-ProbeFrame -Files @($after, $newSave)))
    $result = Measure-Section11LiveSaveFrames -Frames $frames -SessionStartedAtUtc $sessionStart -SaveGlob '*.ntwtf.zip' -CloudSyncEnabled

    # Assert
    Assert-Equal -Actual $result.OlderCandidateMutationCount -Expected 1 -Message 'an older matching candidate changed in place'
    Assert-False -Condition $result.Section11_59Passed -Message 'in-place mutation of a matching save keeps row 59 provisional'
}

function Test-StableInvalidArchiveFailsStabilityClaim {
    # Production mutation caught: counting a size-stable archive without checking
    # its ZIP grammar would incorrectly pass row 56.
    # Arrange
    $sessionStart = [datetime]'2026-08-16T23:24:28Z'
    $invalid = New-ProbeFile -Name 'AutoSave-invalid.ntwtf.zip' -Timestamp '2026-08-16T23:35:00Z' -Hash 'invalid' -ZipValid:$false

    # Act
    $frames = @((New-ProbeFrame), (New-ProbeFrame -Files @($invalid)))
    $result = Measure-Section11LiveSaveFrames -Frames $frames -SessionStartedAtUtc $sessionStart -SaveGlob '*.ntwtf.zip' -CloudSyncEnabled

    # Assert
    Assert-Equal -Actual $result.UnzipFailureCount -Expected 1 -Message 'the stable invalid archive is an unzip failure'
    Assert-False -Condition $result.Section11_56Passed -Message 'an unzip failure keeps row 56 provisional'
}

function Test-UnstableArchiveCanSettleOnALaterFrame {
    # Production mutation caught: treating the first stable fingerprint after an
    # unstable sample as an older-candidate mutation aborts a legitimate gate retry.
    # Arrange
    $sessionStart = [datetime]'2026-08-16T23:24:28Z'
    $unstable = New-ProbeFile -Name 'AutoSave-settling.ntwtf.zip' -Timestamp '2026-08-16T23:35:00Z' -Hash 'pending' -Stable:$false -ZipValid:$false
    $stable = New-ProbeFile -Name 'AutoSave-settling.ntwtf.zip' -Timestamp '2026-08-16T23:35:00Z' -Hash 'settled'
    $frames = @((New-ProbeFrame), (New-ProbeFrame -Files @($unstable)), (New-ProbeFrame -Files @($stable)))

    # Act
    $result = Measure-Section11LiveSaveFrames -Frames $frames -SessionStartedAtUtc $sessionStart -SaveGlob '*.ntwtf.zip' -CloudSyncEnabled

    # Assert
    Assert-Equal -Actual $result.SaveEventCount -Expected 1 -Message 'the save counts once when the later gate attempt stabilizes'
    Assert-Equal -Actual $result.StableArchiveCount -Expected 1 -Message 'the settled archive is validated once'
    Assert-Equal -Actual $result.LiveAutosaveCount -Expected 1 -Message 'the settled autosave remains a live observation'
    Assert-Equal -Actual $result.OlderCandidateMutationCount -Expected 0 -Message 'settling after an unstable sample is not historical mutation'
}

function Test-UnstableSiblingDoesNotHideAStableRotationEvent {
    # Production mutation caught: overwriting the per-frame added-event flag with a
    # later unstable sibling loses a real rotation observation.
    # Arrange
    $sessionStart = [datetime]'2026-08-16T23:24:28Z'
    $old = New-ProbeFile -Name 'manual-old.ntwtf.zip' -Timestamp '2026-08-15T10:00:00Z' -Hash 'old'
    $stable = New-ProbeFile -Name 'manual-new.ntwtf.zip' -Timestamp '2026-08-16T23:35:00Z' -Hash 'stable'
    $unstable = New-ProbeFile -Name 'QuickSave-pending.ntwtf.zip' -Timestamp '2026-08-16T23:35:01Z' -Hash 'pending' -Stable:$false -ZipValid:$false
    $frames = @((New-ProbeFrame -Files @($old)), (New-ProbeFrame -Files @($stable, $unstable)))

    # Act
    $result = Measure-Section11LiveSaveFrames -Frames $frames -SessionStartedAtUtc $sessionStart -SaveGlob '*.ntwtf.zip' -CloudSyncEnabled

    # Assert
    Assert-True -Condition $result.RotationObserved -Message 'the stable replacement records rotation even when another new file is still unstable'
}

function Test-Claim59RequiresAutosaveAfterMonitorStart {
    # Production mutation caught: a session autosave that predates the monitor must
    # not satisfy the live-autosave boundary for historical immutability.
    # Arrange
    $sessionStart = [datetime]'2026-08-16T23:24:28Z'
    $monitorStart = [datetime]'2026-08-16T23:34:00Z'
    $old = New-ProbeFile -Name 'manual-old.ntwtf.zip' -Timestamp '2026-08-15T10:00:00Z' -Hash 'old'
    $manual = New-ProbeFile -Name 'manual-session.ntwtf.zip' -Timestamp '2026-08-16T23:31:00Z' -Hash 'manual'
    $auto = New-ProbeFile -Name 'AutoSave-before-monitor.ntwtf.zip' -Timestamp '2026-08-16T23:32:00Z' -Hash 'auto'
    $manualOverwrite = New-ProbeFile -Name 'manual-overwrite.ntwtf.zip' -Timestamp '2026-08-16T23:35:00Z' -Hash 'manual-overwrite'
    $quick = New-ProbeFile -Name 'QuickSave-session.ntwtf.zip' -Timestamp '2026-08-16T23:36:00Z' -Hash 'quick'
    $frames = @(
        (New-ProbeFrame -Files @($old, $manual, $auto)),
        (New-ProbeFrame -Files @($manual, $auto, $manualOverwrite)),
        (New-ProbeFrame -Files @($manual, $auto, $manualOverwrite, $quick))
    )

    # Act
    $result = Measure-Section11LiveSaveFrames -Frames $frames -SessionStartedAtUtc $sessionStart -MonitorStartedAtUtc $monitorStart -SaveGlob '*.ntwtf.zip' -CloudSyncEnabled

    # Assert
    Assert-Equal -Actual $result.AutosaveCount -Expected 1 -Message 'the pre-monitor autosave remains session evidence'
    Assert-Equal -Actual $result.LiveAutosaveCount -Expected 0 -Message 'the pre-monitor autosave is not live monitor evidence'
    Assert-False -Condition $result.Section11_59Passed -Message 'row 59 stays provisional without an autosave after monitor start'
}

function Test-LaterFrameTimestampControlsLiveAutosaveEvidence {
    # Production mutation caught: frame position alone must not turn an archive
    # whose mtime predates observation into a live autosave.
    # Arrange
    $sessionStart = [datetime]'2026-08-16T23:24:28Z'
    $manual = New-ProbeFile -Name 'manual-session.ntwtf.zip' -Timestamp '2026-08-16T23:31:00Z' -Hash 'manual'
    $oldAuto = New-ProbeFile -Name 'AutoSave-old.ntwtf.zip' -Timestamp '2026-08-15T10:00:00Z' -Hash 'auto'
    $frames = @((New-ProbeFrame -Files @($manual)), (New-ProbeFrame -Files @($manual, $oldAuto)))

    # Act
    $result = Measure-Section11LiveSaveFrames -Frames $frames -SessionStartedAtUtc $sessionStart -SaveGlob '*.ntwtf.zip' -CloudSyncEnabled

    # Assert
    Assert-Equal -Actual $result.LiveAutosaveCount -Expected 0 -Message 'an old autosave first enumerated later is not live evidence'
}

function Test-Claim59RequiresAnOlderCandidateToSurviveALaterSave {
    # Production mutation caught: zero mutations is vacuous when every older save
    # disappears before the later save frame.
    # Arrange
    $sessionStart = [datetime]'2026-08-16T23:24:28Z'
    $monitorStart = [datetime]'2026-08-16T23:34:00Z'
    $old = New-ProbeFile -Name 'manual-old.ntwtf.zip' -Timestamp '2026-08-15T10:00:00Z' -Hash 'old'
    $manual = New-ProbeFile -Name 'manual-session.ntwtf.zip' -Timestamp '2026-08-16T23:31:00Z' -Hash 'manual'
    $manualOverwrite = New-ProbeFile -Name 'manual-overwrite.ntwtf.zip' -Timestamp '2026-08-16T23:35:00Z' -Hash 'manual-overwrite'
    $quick = New-ProbeFile -Name 'QuickSave-session.ntwtf.zip' -Timestamp '2026-08-16T23:35:01Z' -Hash 'quick'
    $auto = New-ProbeFile -Name 'AutoSave-session.ntwtf.zip' -Timestamp '2026-08-16T23:35:02Z' -Hash 'auto'
    $frames = @(
        (New-ProbeFrame -Files @($old, $manual)),
        (New-ProbeFrame -Files @($manualOverwrite, $quick, $auto))
    )

    # Act
    $result = Measure-Section11LiveSaveFrames -Frames $frames -SessionStartedAtUtc $sessionStart -MonitorStartedAtUtc $monitorStart -SaveGlob '*.ntwtf.zip' -CloudSyncEnabled

    # Assert
    Assert-False -Condition $result.Section11_59Passed -Message 'row 59 stays provisional when no older matching candidate survives a later save'
    Assert-Equal -Actual $result.OlderCandidateSurvivorComparisonCount -Expected 0 -Message 'the vacuous session records no survivor comparisons'
}

function Test-RealArchiveValidationUsesTheStabilityGateBeforeZipOpen {
    # Production mutation caught: dispatching an archive while its metadata keeps
    # changing would return a ZIP result instead of an unstable result.
    # Arrange
    $sourceRoot = New-ScratchCompanionRoot -Prefix 'section11-live-support-source'
    $scratchRoot = New-ScratchCompanionRoot -Prefix 'section11-live-support-copy'
    try {
        $archive = Join-Path $sourceRoot 'valid.ntwtf.zip'
        New-ValidProbeArchive -Path $archive

        # Act
        $result = Test-Section11LiveArchive -Path $archive -ScratchRoot $scratchRoot -SampleDelayMilliseconds 1

        # Assert
        Assert-True -Condition $result.Stable -Message 'the completed archive passes the production stability gate'
        Assert-True -Condition $result.ZipValid -Message 'the stable archive copy opens as a ZIP'
    }
    finally {
        if (Test-Path -LiteralPath $sourceRoot) {
            Remove-Item -LiteralPath $sourceRoot -Recurse -Force -Confirm:$false
        }
        if (Test-Path -LiteralPath $scratchRoot) {
            Remove-Item -LiteralPath $scratchRoot -Recurse -Force -Confirm:$false
        }
    }
}

function Test-LiveArchiveRejectsScratchOverlapWithSource {
    # Production mutation caught: the validation copy must never be created in the
    # source directory, especially when that directory is the real save root.
    # Arrange
    $probeRoot = New-ScratchCompanionRoot -Prefix 'section11-live-overlap'
    try {
        $archive = Join-Path $probeRoot 'valid.ntwtf.zip'
        New-ValidProbeArchive -Path $archive

        # Act / Assert
        Assert-ThrowsType -TypeName 'ArgumentException' -Action {
            Test-Section11LiveArchive -Path $archive -ScratchRoot $probeRoot -SampleDelayMilliseconds 1
        }
    }
    finally {
        if (Test-Path -LiteralPath $probeRoot) {
            Remove-Item -LiteralPath $probeRoot -Recurse -Force -Confirm:$false
        }
    }
}

function Test-LiveArchiveRejectsScratchOutsideProjectTmp {
    # Production mutation caught: exported helpers must not accept an arbitrary
    # copy destination merely because it is writable.
    # Arrange
    $probeRoot = New-ScratchCompanionRoot -Prefix 'section11-live-outside'
    $projectRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
    try {
        $archive = Join-Path $probeRoot 'valid.ntwtf.zip'
        New-ValidProbeArchive -Path $archive

        # Act / Assert
        Assert-ThrowsType -TypeName 'ArgumentException' -Action {
            Test-Section11LiveArchive -Path $archive -ScratchRoot $projectRoot -SampleDelayMilliseconds 1
        }
    }
    finally {
        if (Test-Path -LiteralPath $probeRoot) {
            Remove-Item -LiteralPath $probeRoot -Recurse -Force -Confirm:$false
        }
    }
}

function Test-UnstableArchiveNeverCreatesAValidationCopy {
    # Production mutation caught: the archive must pass the full stability gate
    # before any validation copy is created or opened.
    # Arrange
    $sourceRoot = New-ScratchCompanionRoot -Prefix 'section11-live-writing-source'
    $scratchRoot = New-ScratchCompanionRoot -Prefix 'section11-live-writing-copy'
    $archive = Join-Path $sourceRoot 'AutoSave-writing.ntwtf.zip'
    [IO.File]::WriteAllText($archive, 'x', [Text.UTF8Encoding]::new($false))
    $writerProgram = 'while ($true) { [IO.File]::AppendAllText($env:COMPANION_WRITE_TARGET, "x"); Start-Sleep -Milliseconds 1 }'
    $writer = Start-BoundedPwsh -Arguments @('-Command', $writerProgram) -Environment @{ COMPANION_WRITE_TARGET = $archive }
    try {
        $initialLength = [IO.FileInfo]::new($archive).Length
        $wait = [Diagnostics.Stopwatch]::StartNew()
        while ([IO.FileInfo]::new($archive).Length -le $initialLength) {
            if ($wait.ElapsedMilliseconds -gt 5000) {
                throw [TimeoutException]::new('Writer never grew the live-probe source.')
            }

            [Threading.Thread]::Sleep(10)
        }

        # Act
        $result = Test-Section11LiveArchive -Path $archive -ScratchRoot $scratchRoot -SampleDelayMilliseconds 100

        # Assert
        Assert-False -Condition $result.Stable -Message 'a continuously growing archive never passes the stability gate'
        Assert-Equal -Actual @([IO.Directory]::EnumerateFiles($scratchRoot)).Count -Expected 0 -Message 'an unstable archive never creates a validation copy'
    }
    finally {
        Stop-BoundedPwsh -Child $writer
        if (Test-Path -LiteralPath $sourceRoot) {
            Remove-Item -LiteralPath $sourceRoot -Recurse -Force -Confirm:$false
        }
        if (Test-Path -LiteralPath $scratchRoot) {
            Remove-Item -LiteralPath $scratchRoot -Recurse -Force -Confirm:$false
        }
    }
}

function Test-LiveFrameValidatesOnlySessionArchivesAndFingerprintsOlderCandidates {
    # Production mutation caught: skipping the session archive ZIP check or failing
    # to fingerprint an older candidate makes the frame incomplete.
    # Arrange
    $saveRoot = New-ScratchCompanionRoot -Prefix 'section11-live-frame-save'
    $scratchRoot = New-ScratchCompanionRoot -Prefix 'section11-live-frame-copy'
    try {
        $old = Join-Path $saveRoot 'AutoSave-old.ntwtf.zip'
        $session = Join-Path $saveRoot 'manual-session.ntwtf.zip'
        $cloud = Join-Path $saveRoot 'steam_autocloud.vdf'
        New-ValidProbeArchive -Path $old -Content 'old'
        New-ValidProbeArchive -Path $session -Content 'session'
        [IO.File]::WriteAllText($cloud, 'cloud', [Text.UTF8Encoding]::new($false))
        [IO.File]::SetLastWriteTimeUtc($old, [datetime]'2026-08-15T10:00:00Z')
        [IO.File]::SetLastWriteTimeUtc($session, [datetime]'2026-08-16T23:31:33Z')

        # Act
        $frame = Get-Section11LiveSaveFrame -SaveDirectory $saveRoot -SaveGlob '*.ntwtf.zip' -ScratchRoot $scratchRoot -SessionStartedAtUtc ([datetime]'2026-08-16T23:24:28Z') -SampleDelayMilliseconds 1

        # Assert
        Assert-Equal -Actual @($frame.Files).Count -Expected 3 -Message 'the frame includes matching saves and nonmatching cloud metadata'
        $oldRecord = @($frame.Files | Where-Object { $_.Name -ceq 'AutoSave-old.ntwtf.zip' })[0]
        $sessionRecord = @($frame.Files | Where-Object { $_.Name -ceq 'manual-session.ntwtf.zip' })[0]
        Assert-True -Condition (-not [string]::IsNullOrEmpty($oldRecord.Hash)) -Message 'the older candidate has a content fingerprint'
        Assert-True -Condition $sessionRecord.Stable -Message 'the session archive passes the production stability gate'
        Assert-True -Condition $sessionRecord.ZipValid -Message 'the session archive copy opens as a ZIP'
    }
    finally {
        if (Test-Path -LiteralPath $saveRoot) {
            Remove-Item -LiteralPath $saveRoot -Recurse -Force -Confirm:$false
        }
        if (Test-Path -LiteralPath $scratchRoot) {
            Remove-Item -LiteralPath $scratchRoot -Recurse -Force -Confirm:$false
        }
    }
}

function Test-LiveFrameOmitsArchiveThatVanishesDuringValidation {
    # Production mutation caught: save rotation during the stability gate is a
    # transient omission, not a reason to abort the full monitor.
    # Arrange
    $saveRoot = New-ScratchCompanionRoot -Prefix 'section11-live-vanished-save'
    $scratchRoot = New-ScratchCompanionRoot -Prefix 'section11-live-vanished-copy'
    try {
        $archive = Join-Path $saveRoot 'AutoSave-rotated.ntwtf.zip'
        New-ValidProbeArchive -Path $archive
        [IO.File]::SetLastWriteTimeUtc($archive, [datetime]'2026-08-16T23:31:33Z')
        $validator = {
            param($Path, $ScratchRoot, $SampleDelayMilliseconds)

            Remove-Item -LiteralPath $Path -Force -Confirm:$false
            return Test-Section11LiveArchive -Path $Path -ScratchRoot $ScratchRoot -SampleDelayMilliseconds $SampleDelayMilliseconds
        }

        # Act
        $frame = Get-Section11LiveSaveFrame -SaveDirectory $saveRoot -SaveGlob '*.ntwtf.zip' -ScratchRoot $scratchRoot -SessionStartedAtUtc ([datetime]'2026-08-16T23:24:28Z') -SampleDelayMilliseconds 1 -ArchiveValidator $validator

        # Assert
        Assert-Equal -Actual @($frame.Files).Count -Expected 0 -Message 'a save that rotates away during validation is omitted from the frame'
    }
    finally {
        if (Test-Path -LiteralPath $saveRoot) {
            Remove-Item -LiteralPath $saveRoot -Recurse -Force -Confirm:$false
        }
        if (Test-Path -LiteralPath $scratchRoot) {
            Remove-Item -LiteralPath $scratchRoot -Recurse -Force -Confirm:$false
        }
    }
}

function Test-LiveFrameRethrowsUnreadableValidationFailure {
    # Production mutation caught: only the typed vanished disposition is transient;
    # unreadable source failures remain fatal.
    # Arrange
    $saveRoot = New-ScratchCompanionRoot -Prefix 'section11-live-unreadable-save'
    $scratchRoot = New-ScratchCompanionRoot -Prefix 'section11-live-unreadable-copy'
    try {
        $archive = Join-Path $saveRoot 'AutoSave-unreadable.ntwtf.zip'
        New-ValidProbeArchive -Path $archive
        [IO.File]::SetLastWriteTimeUtc($archive, [datetime]'2026-08-16T23:31:33Z')
        $validator = {
            param($Path, $ScratchRoot, $SampleDelayMilliseconds)

            $exceptionType = & (Get-Module DigestDiff) { [SaveSourceException] }
            $exception = [Activator]::CreateInstance($exceptionType, [object[]] @('unreadable', 'save-source-unreadable', $null))
            throw $exception
        }

        # Act / Assert
        Assert-ThrowsType -TypeName 'RuntimeException' -Action {
            Get-Section11LiveSaveFrame -SaveDirectory $saveRoot -SaveGlob '*.ntwtf.zip' -ScratchRoot $scratchRoot -SessionStartedAtUtc ([datetime]'2026-08-16T23:24:28Z') -SampleDelayMilliseconds 1 -ArchiveValidator $validator
        }
    }
    finally {
        if (Test-Path -LiteralPath $saveRoot) {
            Remove-Item -LiteralPath $saveRoot -Recurse -Force -Confirm:$false
        }
        if (Test-Path -LiteralPath $scratchRoot) {
            Remove-Item -LiteralPath $scratchRoot -Recurse -Force -Confirm:$false
        }
    }
}

function Test-LiveMonitorStopsWhenBothClaimsPass {
    # Production mutation caught: evaluating each selector in a separate session
    # would exhaust the shared frame sequence or require duplicate save activity.
    # Arrange
    $sessionStart = [datetime]'2026-08-16T23:24:28Z'
    $oldManual = New-ProbeFile -Name 'manual-old.ntwtf.zip' -Timestamp '2026-08-15T10:00:00Z' -Hash 'old-manual'
    $sessionManual = New-ProbeFile -Name 'manual-session.ntwtf.zip' -Timestamp '2026-08-16T23:31:33Z' -Hash 'manual-session'
    $manualOverwrite = New-ProbeFile -Name 'manual-overwrite.ntwtf.zip' -Timestamp '2026-08-16T23:35:00Z' -Hash 'manual-overwrite'
    $quick = New-ProbeFile -Name 'QuickSave-session.ntwtf.zip' -Timestamp '2026-08-16T23:36:00Z' -Hash 'quick'
    $autoOne = New-ProbeFile -Name 'AutoSave-session-1.ntwtf.zip' -Timestamp '2026-08-16T23:37:00Z' -Hash 'auto-one'
    $autoTwo = New-ProbeFile -Name 'AutoSave-session-2.ntwtf.zip' -Timestamp '2026-08-16T23:38:00Z' -Hash 'auto-two'
    $frames = @(
        (New-ProbeFrame -Files @($oldManual, $sessionManual)),
        (New-ProbeFrame -Files @($sessionManual, $manualOverwrite)),
        (New-ProbeFrame -Files @($sessionManual, $manualOverwrite, $quick)),
        (New-ProbeFrame -Files @($sessionManual, $manualOverwrite, $quick, $autoOne)),
        (New-ProbeFrame -Files @($sessionManual, $manualOverwrite, $quick, $autoOne, $autoTwo))
    )
    $frameQueue = [Collections.Generic.Queue[object]]::new()
    foreach ($frame in $frames) {
        $frameQueue.Enqueue($frame)
    }
    $provider = {
        return $frameQueue.Dequeue()
    }

    # Act
    $result = Invoke-Section11LiveSaveMonitor -SaveDirectory 'unused' -ScratchRoot 'unused' -SessionStartedAtUtc $sessionStart -MonitorStartedAtUtc $sessionStart -CloudSyncEnabled -TimeoutSeconds 5 -PollMilliseconds 1 -FrameProvider $provider -SleepAction { param($Milliseconds) }

    # Assert
    Assert-True -Condition $result.Section11_56Passed -Message 'the joint monitor closes row 56 from the shared observation frames'
    Assert-True -Condition $result.Section11_59Passed -Message 'the joint monitor closes row 59 from the same observation frames'
    Assert-Equal -Actual $result.FrameCount -Expected 5 -Message 'the monitor stops immediately after the first jointly passing frame'
}

function Test-LiveMonitorRejectsAnyInvalidStableArchive {
    # Production mutation caught: selecting only the row 59 result must not hide a
    # fatal invalid ZIP observation that was discovered by the joint monitor.
    # Arrange
    $sessionStart = [datetime]'2026-08-16T23:24:28Z'
    $invalid = New-ProbeFile -Name 'AutoSave-invalid.ntwtf.zip' -Timestamp '2026-08-16T23:35:00Z' -Hash 'invalid' -ZipValid:$false
    $provider = { return New-ProbeFrame -Files @($invalid) }

    # Act / Assert
    Assert-ThrowsType -TypeName 'InvalidOperationException' -Action {
        Invoke-Section11LiveSaveMonitor -SaveDirectory 'unused' -ScratchRoot 'unused' -SessionStartedAtUtc $sessionStart -MonitorStartedAtUtc $sessionStart -CloudSyncEnabled -TimeoutSeconds 5 -PollMilliseconds 1 -FrameProvider $provider -SleepAction { param($Milliseconds) }
    }
}

function Test-LiveMonitorRejectsAnyMatchingCandidateMutation {
    # Production mutation caught: selecting only the row 56 result must not hide a
    # fatal in-place mutation discovered by the joint monitor.
    # Arrange
    $sessionStart = [datetime]'2026-08-16T23:24:28Z'
    $before = New-ProbeFile -Name 'manual-old.ntwtf.zip' -Timestamp '2026-08-15T10:00:00Z' -Hash 'before'
    $after = New-ProbeFile -Name 'manual-old.ntwtf.zip' -Timestamp '2026-08-16T23:35:00Z' -Hash 'after' -Length 101
    $frames = [Collections.Generic.Queue[object]]::new()
    $frames.Enqueue((New-ProbeFrame -Files @($before)))
    $frames.Enqueue((New-ProbeFrame -Files @($after)))
    $provider = { return $frames.Dequeue() }

    # Act / Assert
    Assert-ThrowsType -TypeName 'InvalidOperationException' -Action {
        Invoke-Section11LiveSaveMonitor -SaveDirectory 'unused' -ScratchRoot 'unused' -SessionStartedAtUtc $sessionStart -MonitorStartedAtUtc $sessionStart -CloudSyncEnabled -TimeoutSeconds 5 -PollMilliseconds 1 -FrameProvider $provider -SleepAction { param($Milliseconds) }
    }
}

Test-FramesCloseBothClaimsWithoutMeaningfulGameChanges
Test-MatchingCandidateMutationFailsImmutabilityClaim
Test-StableInvalidArchiveFailsStabilityClaim
Test-UnstableArchiveCanSettleOnALaterFrame
Test-UnstableSiblingDoesNotHideAStableRotationEvent
Test-Claim59RequiresAutosaveAfterMonitorStart
Test-LaterFrameTimestampControlsLiveAutosaveEvidence
Test-Claim59RequiresAnOlderCandidateToSurviveALaterSave
Test-RealArchiveValidationUsesTheStabilityGateBeforeZipOpen
Test-LiveArchiveRejectsScratchOverlapWithSource
Test-LiveArchiveRejectsScratchOutsideProjectTmp
Test-UnstableArchiveNeverCreatesAValidationCopy
Test-LiveFrameValidatesOnlySessionArchivesAndFingerprintsOlderCandidates
Test-LiveFrameOmitsArchiveThatVanishesDuringValidation
Test-LiveFrameRethrowsUnreadableValidationFailure
Test-LiveMonitorStopsWhenBothClaimsPass
Test-LiveMonitorRejectsAnyInvalidStableArchive
Test-LiveMonitorRejectsAnyMatchingCandidateMutation

Write-Output 'PASS: section 11 live-probe support tests'
