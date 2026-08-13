#Requires -Version 7.5

[CmdletBinding()]
param(
    [Parameter()]
    [ValidateSet('All', 'Quiescence', 'Cancellation', 'PollFailure', 'DefaultCycleLifecycle', 'CoordinatorRecovery', 'DuplicateBookkeepingRewrite', 'WatcherSampleIdentity', 'EqualIdentityRetention', 'SerializedCyclePublication', 'AcquisitionDomainIsolation')]
    [string] $Only = 'All'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Import-Module (Join-Path $PSScriptRoot 'TestSupport.psm1') -Force
Import-Module (Join-Path $PSScriptRoot '../DigestDiff.psm1') -Force

$root = New-ScratchCompanionRoot -Prefix 'watcher'
$outcome = Invoke-InCompanionModule {
    param($Root)
    $file = Join-Path $Root 'save.ntwtf.zip'
    [IO.File]::WriteAllText($file, 'x', [Text.UTF8Encoding]::new($false, $true))
    [IO.File]::SetLastWriteTimeUtc($file, [datetime]::Parse('2026-08-10T00:00:00.0000000Z', [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind))
    $services = [WatcherRuntimeServices]::new(
        { param($Token) [pscustomobject]@{ SourceDomainId = 'domain'; SaveDirectory = $Root; SaveGlob = '*.zip' } },
        { param($Config,$Token) @([IO.FileInfo]::new($file)) },
        { param($Config,$Token) [WatcherBookkeepingReadResult]::new('valid', (Read-CompanionJson -Json '{"domainId":"domain","saveFile":"save.ntwtf.zip","savedAt":"2026-08-10T00:00:00.0000000Z"}' -Budget config)) },
        { param($Config,$Token) [WatcherCurrentReadResult]::new('valid', (Read-CompanionJson -Json '{"source":{"domainId":"domain","saveFile":"save.ntwtf.zip","savedAt":"2026-08-10T00:00:00.0000000Z"}}' -Budget digest)) },
        { param($Config,$Candidate,$Token) [pscustomobject]@{ status = 'stable'; candidate = $Candidate } },
        { param($CompanionRoot,$Token) [pscustomobject]@{ status = 'busy'; owner = $null } },
        { param($Owner,$Config,$Candidate,$Sink,$Token) throw 'not reached' })
    $first = Invoke-WatcherPoll -PriorSample $null -Services $services -CompanionRoot $Root -CancellationToken ([Threading.CancellationToken]::None)
    $second = Invoke-WatcherPoll -PriorSample $first.sample -Services $services -CompanionRoot $Root -CancellationToken ([Threading.CancellationToken]::None)
    [pscustomobject]@{ first = $first.disposition; second = $second.disposition }
} @($root)
Assert-Equal -Actual $outcome.first -Expected 'sampled' -Message 'A first complete observation is retained as a sample.'
Assert-Equal -Actual $outcome.second -Expected 'quiescent' -Message 'A second equal healthy observation is quiescent.'

$noSaves = Invoke-InCompanionModule {
    $services = [WatcherRuntimeServices]::new({ param($Token) [pscustomobject]@{} },{ param($Config,$Token) @() },{ param($Config,$Token) $null },{ param($Config,$Token) $null },{ param($Config,$File,$Token) $null },{ param($Root,$Token) $null },{ param($Owner,$Config,$File,$Sink,$Token) $null })
    (Invoke-WatcherPoll -PriorSample $null -Services $services -CompanionRoot 'x' -CancellationToken ([Threading.CancellationToken]::None)).disposition
}
Assert-Equal -Actual $noSaves -Expected 'no-saves' -Message 'An empty candidate enumeration clears the pending sample.'
if ($Only -eq 'Quiescence') {
    Write-Output 'PASS: watcher'
    exit 0
}

$duplicateBookkeeping = Invoke-InCompanionModule {
    param($Root)
    $state = Join-Path $Root 'state'
    [IO.Directory]::CreateDirectory($state) | Out-Null
    $save = Join-Path $Root 'save.ntwtf.zip'
    [IO.File]::WriteAllText($save, 'x', [Text.UTF8Encoding]::new($false, $true))
    [IO.File]::SetLastWriteTimeUtc($save, [datetime]::Parse('2026-08-10T00:00:00.0000000Z', [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind))
    $bookkeepingPath = Join-Path $state 'last-processed.json'
    [IO.File]::WriteAllText($bookkeepingPath, '{"domainId":"domain","domainId":"other","saveFile":"save.ntwtf.zip","savedAt":"2026-08-10T00:00:00.0000000Z"}', [Text.UTF8Encoding]::new($false, $true))
    $cycles = [Collections.Generic.List[int]]::new()
    $services = [WatcherRuntimeServices]::new(
        { param($Token) [pscustomobject]@{ SourceDomainId = 'domain' } },
        { param($Config,$Token) @([IO.FileInfo]::new($save)) },
        { param($Config,$Token) try { [WatcherBookkeepingReadResult]::new('valid', (Read-CompanionJson -Path $bookkeepingPath -Budget config)) } catch [CompanionContentException] { [WatcherBookkeepingReadResult]::new('content-invalid', $null) } },
        { param($Config,$Token) [WatcherCurrentReadResult]::new('valid', (Read-CompanionJson -Json '{"source":{"domainId":"domain","saveFile":"save.ntwtf.zip","savedAt":"2026-08-10T00:00:00.0000000Z"}}' -Budget digest)) },
        { param($Config,$File,$Token) [pscustomobject]@{ status = 'stable'; candidate = $File } },
        { param($CompanionRoot,$Token) [pscustomobject]@{ status = 'acquired'; owner = [IO.MemoryStream]::new() } },
        { param($Owner,$Config,$Candidate,$Sink,$Token) try { $cycles.Add(1); Write-CompanionBookkeeping -CompanionRoot $Root -Document ([ordered]@{ domainId = 'domain'; saveFile = $Candidate.Name; savedAt = $Candidate.LastWriteTimeUtc.ToString('o', [Globalization.CultureInfo]::InvariantCulture) }); [CycleOutcome]::new($true, $true, $false, $true, $true, $null, 'stable', $false, $null, $Sink.Freeze()) } finally { $Owner.Dispose() } })
    $first = Invoke-WatcherPoll -PriorSample $null -Services $services -CompanionRoot $Root -CancellationToken ([Threading.CancellationToken]::None)
    $second = Invoke-WatcherPoll -PriorSample $first.sample -Services $services -CompanionRoot $Root -CancellationToken ([Threading.CancellationToken]::None)
    $bookkeeping = Read-CompanionJson -Path $bookkeepingPath -Budget config
    return [pscustomobject]@{ first = $first.disposition; second = $second.disposition; cycles = $cycles.Count; fields = @($bookkeeping.Materialized.Keys) }
} @((New-ScratchCompanionRoot -Prefix 'watcher-duplicate-bookkeeping'))
Assert-Equal -Actual $duplicateBookkeeping.first -Expected 'sampled' -Message 'Duplicate bookkeeping fixture first records the candidate sample.'
Assert-Equal -Actual $duplicateBookkeeping.second -Expected 'cycled' -Message 'Duplicate bookkeeping is not accepted as a completed watcher record.'
Assert-Equal -Actual $duplicateBookkeeping.cycles -Expected 1 -Message 'Duplicate bookkeeping triggers exactly one reprocessing cycle.'
Assert-Equal -Actual ($duplicateBookkeeping.fields -join ',') -Expected 'domainId,saveFile,savedAt' -Message 'The reprocessing cycle replaces bookkeeping with the exact three-field record.'
if ($Only -eq 'DuplicateBookkeepingRewrite') {
    Write-Output 'PASS: watcher'
    exit 0
}

$cancelled = Invoke-InCompanionModule {
    $source = [Threading.CancellationTokenSource]::new(); $source.Cancel()
    $services = [WatcherRuntimeServices]::new({ param($Token) throw 'not reached' },{ param($Config,$Token) @() },{ param($Config,$Token) $null },{ param($Config,$Token) $null },{ param($Config,$File,$Token) $null },{ param($Root,$Token) $null },{ param($Owner,$Config,$File,$Sink,$Token) $null })
    (Invoke-WatcherPoll -PriorSample $null -Services $services -CompanionRoot 'x' -CancellationToken $source.Token).disposition
}
Assert-Equal -Actual $cancelled -Expected 'cancelled' -Message 'Cancellation wins before configuration resolution.'

$waitCancelled = Invoke-InCompanionModule {
    $source = [Threading.CancellationTokenSource]::new()
    $source.Cancel()
    try {
        Wait-WatcherInterval -IntervalSeconds ([int]::MaxValue) -CancellationToken $source.Token
        $false
    }
    catch [WatcherCancellationException] {
        $true
    }
}
Assert-True -Condition $waitCancelled -Message 'The bounded interval wait observes cancellation before a one-day chunk can elapse.'

$cancellationAfterConfig = Invoke-InCompanionModule {
    $source = [Threading.CancellationTokenSource]::new()
    $services = [WatcherRuntimeServices]::new(
        { param($Token) $source.Cancel(); [pscustomobject]@{ SourceDomainId = 'domain' } },
        { param($Config, $Token) throw 'Candidate enumeration must not run after cancellation.' },
        { param($Config, $Token) throw 'not reached' },
        { param($Config, $Token) throw 'not reached' },
        { param($Config, $File, $Token) throw 'not reached' },
        { param($Root, $Token) throw 'not reached' },
        { param($Owner, $Config, $File, $Sink, $Token) throw 'not reached' })

    (Invoke-WatcherPoll -PriorSample $null -Services $services -CompanionRoot 'x' -CancellationToken $source.Token).disposition
}
Assert-Equal -Actual $cancellationAfterConfig -Expected 'cancelled' -Message 'Cancellation after config resolution wins before candidate enumeration.'

$cancellationAfterCandidates = Invoke-InCompanionModule {
    $source = [Threading.CancellationTokenSource]::new()
    $file = [IO.FileInfo]::new((Join-Path $Root 'save.ntwtf.zip'))
    $services = [WatcherRuntimeServices]::new(
        { param($Token) [pscustomobject]@{ SourceDomainId = 'domain' } },
        { param($Config, $Token) $source.Cancel(); @($file) },
        { param($Config, $Token) throw 'not reached' },
        { param($Config, $Token) throw 'not reached' },
        { param($Config, $File, $Token) throw 'not reached' },
        { param($Root, $Token) throw 'not reached' },
        { param($Owner, $Config, $File, $Sink, $Token) throw 'not reached' })

    (Invoke-WatcherPoll -PriorSample $null -Services $services -CompanionRoot $Root -CancellationToken $source.Token).disposition
} @($root)
Assert-Equal -Actual $cancellationAfterCandidates -Expected 'cancelled' -Message 'Cancellation after candidate enumeration wins before metadata sampling.'

$cancellationAfterLockAcquisition = Invoke-InCompanionModule {
    param($Root)
    $file = Join-Path $Root 'cancel-lock.ntwtf.zip'
    [IO.File]::WriteAllText($file, 'x', [Text.UTF8Encoding]::new($false, $true))
    [IO.File]::SetLastWriteTimeUtc($file, [datetime]::Parse('2026-08-10T00:00:00.0000000Z', [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind))
    Initialize-CompanionStateDirectories -CompanionRoot $Root
    $source = [Threading.CancellationTokenSource]::new()
    $sampleFile = [IO.FileInfo]::new($file)
    $sample = [WatcherSample]::new('domain', $sampleFile.Name, $sampleFile.LastWriteTimeUtc, $sampleFile.Length)
    $services = [WatcherRuntimeServices]::new(
        { param($Token) [pscustomobject]@{ SourceDomainId = 'domain' } },
        { param($Config, $Token) @($sampleFile) },
        { param($Config, $Token) [WatcherBookkeepingReadResult]::new('absent', $null) },
        { param($Config, $Token) [WatcherCurrentReadResult]::new('absent', $null) },
        { param($Config, $Candidate, $Token) [WatcherStabilityResult]::new('stable', $Candidate) },
        { param($Root2, $Token) $lockOwner = Enter-CompanionCycleLock -CompanionRoot $Root2 -TimeoutMilliseconds 0 -CancellationToken $Token; $source.Cancel(); [WatcherCycleLockTryResult]::new('acquired', $lockOwner) },
        { param($Owner, $Config, $Candidate, $Sink, $Token) throw 'Cycle must not run after the lock-acquired cancellation checkpoint.' })

    $poll = Invoke-WatcherPoll -PriorSample $sample -Services $services -CompanionRoot $Root -CancellationToken $source.Token
    $reacquire = $null
    try { $reacquire = Enter-CompanionCycleLock -CompanionRoot $Root -TimeoutMilliseconds 0 } catch [TimeoutException] { }
    if ($null -ne $reacquire) { $reacquire.Dispose() }

    return [pscustomobject]@{ disposition = $poll.disposition; reacquireSucceeded = $null -ne $reacquire }
} @($root)
Assert-Equal -Actual $cancellationAfterLockAcquisition.disposition -Expected 'cancelled' -Message 'Cancellation right after cycle-lock acquisition returns the cancelled disposition.'
Assert-True -Condition $cancellationAfterLockAcquisition.reacquireSucceeded -Message 'Cancellation after cycle-lock acquisition releases the held lock before returning.'
if ($Only -eq 'Cancellation') {
    Write-Output 'PASS: watcher'
    exit 0
}

$enumerationFailure = Invoke-InCompanionModule {
    $services = [WatcherRuntimeServices]::new(
        { param($Token) [pscustomobject]@{ SourceDomainId = 'domain' } },
        { param($Config, $Token) throw [IO.IOException]::new('offline') },
        { param($Config, $Token) throw 'not reached' },
        { param($Config, $Token) throw 'not reached' },
        { param($Config, $File, $Token) throw 'not reached' },
        { param($Root, $Token) throw 'not reached' },
        { param($Owner, $Config, $File, $Sink, $Token) throw 'not reached' })

    (Invoke-WatcherPoll -PriorSample $null -Services $services -CompanionRoot 'x' -CancellationToken ([Threading.CancellationToken]::None)).disposition
}
Assert-Equal -Actual $enumerationFailure -Expected 'enumeration-failed' -Message 'Ordinary candidate enumeration failure clears the sample and skips the poll.'

$triggerDisposition = Invoke-InCompanionModule {
    param($Root)
    $file = [IO.FileInfo]::new((Join-Path $Root 'save.ntwtf.zip'))
    $sample = [WatcherSample]::new('domain', $file.Name, $file.LastWriteTimeUtc, $file.Length)
    $services = [WatcherRuntimeServices]::new(
        { param($Token) [pscustomobject]@{ SourceDomainId = 'domain' } },
        { param($Config, $Token) @($file) },
        { param($Config, $Token) [WatcherBookkeepingReadResult]::new('absent', $null) },
        { param($Config, $Token) [WatcherCurrentReadResult]::new('stale', $null) },
        { param($Config, $Candidate, $Token) [WatcherStabilityResult]::new('stable', $Candidate) },
        { param($Root, $Token) [WatcherCycleLockTryResult]::new('busy', $null) },
        { param($Owner, $Config, $Candidate, $Sink, $Token) throw 'Cycle must not run while the lock is busy.' })

    (Invoke-WatcherPoll -PriorSample $sample -Services $services -CompanionRoot $Root -CancellationToken ([Threading.CancellationToken]::None)).disposition
} @($root)
Assert-Equal -Actual $triggerDisposition -Expected 'busy' -Message 'Invalid bookkeeping and stale current trigger one zero-wait lock attempt without a cycle.'

$lockFailure = Invoke-InCompanionModule {
    param($Root)
    $file = [IO.FileInfo]::new((Join-Path $Root 'save.ntwtf.zip'))
    $sample = [WatcherSample]::new('domain', $file.Name, $file.LastWriteTimeUtc, $file.Length)
    $services = [WatcherRuntimeServices]::new(
        { param($Token) [pscustomobject]@{ SourceDomainId = 'domain' } },
        { param($Config, $Token) @($file) },
        { param($Config, $Token) [WatcherBookkeepingReadResult]::new('absent', $null) },
        { param($Config, $Token) [WatcherCurrentReadResult]::new('absent', $null) },
        { param($Config, $Candidate, $Token) [WatcherStabilityResult]::new('stable', $Candidate) },
        { param($Root, $Token) throw [IO.IOException]::new('lock unavailable') },
        { param($Owner, $Config, $Candidate, $Sink, $Token) throw 'not reached' })

    (Invoke-WatcherPoll -PriorSample $sample -Services $services -CompanionRoot $Root -CancellationToken ([Threading.CancellationToken]::None)).disposition
} @($root)
Assert-Equal -Actual $lockFailure -Expected 'lock-failed' -Message 'A lock infrastructure failure clears the sample without entering a cycle.'

$incompleteObservation = Invoke-InCompanionModule {
    param($Root)
    $file = [IO.FileInfo]::new((Join-Path $Root 'save.ntwtf.zip'))
    $sample = [WatcherSample]::new('domain', $file.Name, $file.LastWriteTimeUtc, $file.Length)
    $services = [WatcherRuntimeServices]::new(
        { param($Token) [pscustomobject]@{ SourceDomainId = 'domain' } },
        { param($Config, $Token) @($file) },
        { param($Config, $Token) [WatcherBookkeepingReadResult]::new('absent', $null) },
        { param($Config, $Token) [WatcherCurrentReadResult]::new('absent', $null) },
        { param($Config, $Candidate, $Token) [WatcherStabilityResult]::new('unreadable', $null) },
        { param($Root, $Token) throw 'Lock must not be reached for an incomplete observation.' },
        { param($Owner, $Config, $Candidate, $Sink, $Token) throw 'not reached' })

    (Invoke-WatcherPoll -PriorSample $sample -Services $services -CompanionRoot $Root -CancellationToken ([Threading.CancellationToken]::None)).disposition
} @($root)
Assert-Equal -Actual $incompleteObservation -Expected 'observation-incomplete' -Message 'An unreadable stability result clears the sample before lock acquisition.'
if ($Only -eq 'PollFailure') {
    Write-Output 'PASS: watcher'
    exit 0
}

if ($Only -eq 'WatcherSampleIdentity') {
    $identityRoot = New-ScratchCompanionRoot -Prefix 'watcher-sample-identity'
    $file = Join-Path $identityRoot 'save.ntwtf.zip'
    $t1 = [datetime]::Parse('2026-08-10T00:00:00.0000000Z', [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind)
    $t2 = [datetime]::Parse('2026-08-10T01:00:00.0000000Z', [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind)
    [IO.File]::WriteAllText($file, 'x', [Text.UTF8Encoding]::new($false, $true))
    [IO.File]::SetLastWriteTimeUtc($file, $t1)

    $identityResult = Invoke-InCompanionModule -ArgumentList @($identityRoot, $file, $t1, $t2) -ScriptBlock {
        param($Root, $File, $T1, $T2)

        $identityServices = [WatcherRuntimeServices]::new(
            { param($Token) [pscustomobject]@{ SourceDomainId = 'domain' } },
            { param($Config, $Token) @([IO.FileInfo]::new($File)) },
            { param($Config, $Token) [WatcherBookkeepingReadResult]::new('absent', $null) },
            { param($Config, $Token) [WatcherCurrentReadResult]::new('absent', $null) },
            { param($Config, $Candidate, $Token) [WatcherStabilityResult]::new('stable', $Candidate) },
            { param($Root, $Token) [WatcherCycleLockTryResult]::new('acquired', [System.IO.MemoryStream]::new()) },
            { param($Owner, $Config, $Candidate, $Sink, $Token) $Owner.Dispose(); [CycleOutcome]::new($true, $true, $false, $true, $true, $null, 'stable', $false, $null, $Sink.Freeze()) })

        $p0 = Invoke-WatcherPoll -PriorSample $null -Services $identityServices -CompanionRoot $Root -CancellationToken ([Threading.CancellationToken]::None)
        $p0Size = $p0.sample.size

        # P0 recorded (N, T1, L). Rewrite N to different bytes with the same size but
        # a new timestamp T2. The full bookkeeping tuple now differs from P0, so P1
        # replaces the sample without dispatch.
        [IO.File]::WriteAllText($File, 'y', [Text.UTF8Encoding]::new($false, $true))
        [IO.File]::SetLastWriteTimeUtc($File, $T2)
        $p1Size = [IO.FileInfo]::new($File).Length
        $p1 = Invoke-WatcherPoll -PriorSample $p0.sample -Services $identityServices -CompanionRoot $Root -CancellationToken ([Threading.CancellationToken]::None)

        # P2 observes the unchanged P1 tuple: metadata is identical and bookkeeping/current
        # are absent, so the trigger fires and the poll dispatches a cycle.
        $p2 = Invoke-WatcherPoll -PriorSample $p1.sample -Services $identityServices -CompanionRoot $Root -CancellationToken ([Threading.CancellationToken]::None)

        return [pscustomobject]@{ p0 = $p0.disposition; p0Size = $p0Size; p1Size = $p1Size; p1 = $p1.disposition; p2 = $p2.disposition }
    }

    Assert-Equal -Actual $identityResult.p0 -Expected 'sampled' -Message 'P0 records the initial (name, savedAt, size) observation as a sample.'
    Assert-Equal -Actual $identityResult.p0Size -Expected $identityResult.p1Size -Message 'The byte rewrite preserves the sample size.'
    Assert-Equal -Actual $identityResult.p1 -Expected 'sampled' -Message 'P1 replaces the sample without dispatch when the timestamp tuple changes.'
    Assert-Equal -Actual $identityResult.p2 -Expected 'cycled' -Message 'An unchanged P2 metadata tuple dispatches a cycle.'

    Write-Output 'PASS: watcher'
    exit 0
}

$cycleCancellationWarnings = Invoke-InCompanionModule {
    param($Root)
    $file = [IO.FileInfo]::new((Join-Path $Root 'save.ntwtf.zip'))
    $sample = [WatcherSample]::new('domain', $file.Name, $file.LastWriteTimeUtc, $file.Length)
    $services = [WatcherRuntimeServices]::new(
        { param($Token) [pscustomobject]@{ SourceDomainId = 'domain' } },
        { param($Config, $Token) @($file) },
        { param($Config, $Token) [WatcherBookkeepingReadResult]::new('absent', $null) },
        { param($Config, $Token) [WatcherCurrentReadResult]::new('absent', $null) },
        { param($Config, $Candidate, $Token) [WatcherStabilityResult]::new('stable', $Candidate) },
        { param($Root, $Token) [WatcherCycleLockTryResult]::new('acquired', [System.IO.MemoryStream]::new()) },
        { param($Owner, $Config, $Candidate, $Sink, $Token) $Owner.Dispose(); throw [WatcherCancellationException]::new(@('pipeline-cleanup-degraded')) })

    Invoke-WatcherPoll -PriorSample $sample -Services $services -CompanionRoot $Root -CancellationToken ([Threading.CancellationToken]::None)
} @($root)
Assert-Equal -Actual $cycleCancellationWarnings.disposition -Expected 'cancelled' -Message 'Cycle cancellation returns the graceful watcher disposition.'
Assert-Equal -Actual $cycleCancellationWarnings.warnings[0] -Expected 'pipeline-cleanup-degraded' -Message 'Cycle cancellation preserves its final warning set.'

$defaultCycleRoot = New-ScratchCompanionRoot -Prefix 'watcher-default-cycle'
[IO.File]::WriteAllText((Join-Path $defaultCycleRoot 'watch.ntwtf.zip'), 'fixture', [Text.UTF8Encoding]::new($false))
$defaultCycleSave = Join-Path $defaultCycleRoot 'watch.ntwtf.zip'
$defaultCycleTrace = Invoke-InCompanionModule {
    param($Root, $Save)

    $trace = [Collections.Generic.List[string]]::new()
    $source = [Threading.CancellationTokenSource]::new()
    $script:WatcherCycleTraceHook = { param($Step) $trace.Add($Step) }
    $originalConfig = ${function:Get-AdapterConfig}
    $originalCandidates = ${function:Get-SaveCandidates}
    $originalStable = ${function:Test-FileWriteStable}
    $originalDirectories = ${function:Initialize-CompanionStateDirectories}
    $originalReaper = ${function:Invoke-WorkFileReaper}
    $originalCycle = ${function:Invoke-CompanionCycle}
    try {
        function Get-AdapterConfig {
            param($Adapter, $CompanionRoot, $Profile)

            $config = [pscustomobject]@{ ConfigReceipt = 'receipt'; SaveDirectory = $Root; SaveGlob = '*.ntwtf.zip'; AdapterDirectory = 'adapter' }
            $config | Add-Member -MemberType ScriptMethod -Name Dispose -Value { }
            return $config
        }

        function Get-SaveCandidates {
            param($SaveDirectory, $SaveGlob)

            return [IO.FileInfo]::new($Save)
        }

        function Test-FileWriteStable {
            param($Path, $CancellationToken)

            return $true
        }

        function Initialize-CompanionStateDirectories {
            param($CompanionRoot)
        }

        function Invoke-WorkFileReaper {
            param($CompanionRoot, $WarningSink)
        }

        function Invoke-CompanionCycle {
            param($CompanionRoot, $AdapterDirectory, $AdapterConfig, $SourceSave, $WarningSink, $CancellationToken)

            $source.Cancel()
            return [pscustomobject]@{ Warnings = @() }
        }

        $defaults = New-WatcherRuntimeServices -AdapterName 'example' -CompanionRoot $Root
        $config = & $defaults.ResolveConfig $source.Token
        $result = & $defaults.InvokeCycle ([IO.MemoryStream]::new()) $config ([IO.FileInfo]::new($Save)) (New-CompanionWarningSink -Profile Cycle) $source.Token
        [pscustomobject]@{ Trace = $trace -join ','; Warnings = $result.Warnings }
    }
    finally {
        ${function:Get-AdapterConfig} = $originalConfig
        ${function:Get-SaveCandidates} = $originalCandidates
        ${function:Test-FileWriteStable} = $originalStable
        ${function:Initialize-CompanionStateDirectories} = $originalDirectories
        ${function:Invoke-WorkFileReaper} = $originalReaper
        ${function:Invoke-CompanionCycle} = $originalCycle
        $script:WatcherCycleTraceHook = $null
        $source.Dispose()
    }
} @($defaultCycleRoot, $defaultCycleSave)
Assert-Equal -Actual $defaultCycleTrace.Trace -Expected 'config-confirmed,candidate-revalidated,stability-revalidated,roots-recreated,full-reaper-complete,cycle-work-allocated,resources-disposed' -Message 'The default cycle invocation performs each post-lock operation in order before allocating cycle work.'
Assert-Equal -Actual $defaultCycleTrace.Warnings.Count -Expected 0 -Message 'The dependency-substituted default cycle preserves the cycle warning contract.'
if ($Only -eq 'DefaultCycleLifecycle') {
    Write-Output 'PASS: watcher'
    exit 0
}

$serviceIndependence = Invoke-InCompanionModule {
    $source = [Threading.CancellationTokenSource]::new()
    $calls = [Collections.Generic.List[string]]::new()
    $originalConfig = ${function:Get-AdapterConfig}
    try {
        function Get-AdapterConfig {
            param($Adapter, $CompanionRoot, $Profile)

            $calls.Add("$Adapter|$CompanionRoot")
            $config = [pscustomobject]@{ ConfigReceipt = "receipt-$Adapter"; SaveDirectory = $CompanionRoot; SaveGlob = '*.ntwtf.zip'; AdapterDirectory = 'adapter' }
            $config | Add-Member -MemberType ScriptMethod -Name Dispose -Value { }
            return $config
        }

        $bundleA = New-WatcherRuntimeServices -AdapterName 'alpha' -CompanionRoot 'root-a'
        $bundleB = New-WatcherRuntimeServices -AdapterName 'beta' -CompanionRoot 'root-b'
        $configA = & $bundleA.ResolveConfig $source.Token
        $configB = & $bundleB.ResolveConfig $source.Token
        return [pscustomobject]@{ A = $configA.ConfigReceipt; B = $configB.ConfigReceipt; Calls = ($calls -join ',') }
    }
    finally {
        ${function:Get-AdapterConfig} = $originalConfig
        $source.Dispose()
    }
}
Assert-OrdinalEqual -Actual $serviceIndependence.A -Expected 'receipt-alpha' -Message 'Two default service bundles resolve their own adapter independently.'
Assert-OrdinalEqual -Actual $serviceIndependence.B -Expected 'receipt-beta' -Message 'Two default service bundles resolve their own companion root independently.'
Assert-OrdinalEqual -Actual $serviceIndependence.Calls -Expected 'alpha|root-a,beta|root-b' -Message 'Each default service bundle binds its own adapter and root to config resolution without shared mutable state.'

$acceptedCycleTrace = Invoke-InCompanionModule {
    $trace = [Collections.Generic.List[string]]::new()
    $script:WatcherCycleTraceHook = { param($Step) $trace.Add($Step) }
    try {
        foreach ($step in 'config-confirmed', 'candidate-revalidated', 'stability-revalidated', 'roots-recreated', 'full-reaper-complete', 'cycle-work-allocated', 'resources-disposed') {
            Write-WatcherCycleTrace -Step $step
        }

        $trace -join ','
    }
    finally {
        $script:WatcherCycleTraceHook = $null
    }
}
Assert-Equal -Actual $acceptedCycleTrace -Expected 'config-confirmed,candidate-revalidated,stability-revalidated,roots-recreated,full-reaper-complete,cycle-work-allocated,resources-disposed' -Message 'The accepted-cycle trace has a closed, ordered lifecycle including cleanup.'

$coordinatorRecovers = Invoke-InCompanionModule {
    $source = [Threading.CancellationTokenSource]::new()
    $state = [pscustomobject]@{ Calls = 0 }
    $services = [WatcherRuntimeServices]::new(
        { param($Token) $state.Calls++; if ($state.Calls -eq 1) { throw [InvalidOperationException]::new('injected') }; $source.Cancel(); [pscustomobject]@{ SourceDomainId = 'domain' } },
        { param($Config, $Token) throw 'not reached' },
        { param($Config, $Token) throw 'not reached' },
        { param($Config, $Token) throw 'not reached' },
        { param($Config, $File, $Token) throw 'not reached' },
        { param($Root, $Token) throw 'not reached' },
        { param($Owner, $Config, $File, $Sink, $Token) throw 'not reached' })

    Invoke-CompanionWatcher -AdapterName 'adapter' -CompanionRoot 'x' -IntervalSeconds 2 -CancellationToken $source.Token -Services $services
    $state.Calls
}
Assert-Equal -Actual $coordinatorRecovers -Expected 2 -Message 'The coordinator clears an unexpected poll failure and continues until a later cancellation.'
if ($Only -eq 'CoordinatorRecovery') {
    Write-Output 'PASS: watcher'
    exit 0
}

$invalidResultRejected = Invoke-InCompanionModule {
    try {
        [WatcherPollResult]::new($null, 'sampled', @(), $null)
        $false
    }
    catch [ArgumentException] {
        $true
    }
}
Assert-True -Condition $invalidResultRejected -Message 'Watcher poll results reject illegal sample nullability.'

if ($Only -eq 'EqualIdentityRetention') {
    $idRoot = New-ScratchCompanionRoot -Prefix 'watcher-equal-identity'
    $idFile = Join-Path $idRoot 'save.ntwtf.zip'
    $idT = [datetime]::Parse('2026-08-10T00:00:00.0000000Z', [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind)
    [IO.File]::WriteAllText($idFile, 'H1', [Text.UTF8Encoding]::new($false, $true))
    [IO.File]::SetLastWriteTimeUtc($idFile, $idT)

    $retention = Invoke-InCompanionModule -ArgumentList @($idRoot, $idFile, $idT) -ScriptBlock {
        param($Root, $File, $T)

        $Domain = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
        $bookkeepingJson = '{"domainId":"' + $Domain + '","saveFile":"save.ntwtf.zip","savedAt":"' + $T.ToString('o', [Globalization.CultureInfo]::InvariantCulture) + '"}'
        $currentJson = '{"source":{"domainId":"' + $Domain + '","saveFile":"save.ntwtf.zip","savedAt":"' + $T.ToString('o', [Globalization.CultureInfo]::InvariantCulture) + '"}}'
        $cycles = [Collections.Generic.List[int]]::new()
        $services = [WatcherRuntimeServices]::new(
            { param($Token) [pscustomobject]@{ SourceDomainId = $Domain } },
            { param($Config,$Token) @([IO.FileInfo]::new($File)) },
            { param($Config,$Token) [WatcherBookkeepingReadResult]::new('valid', (Read-CompanionJson -Json $bookkeepingJson -Budget config)) },
            { param($Config,$Token) [WatcherCurrentReadResult]::new('valid', (Read-CompanionJson -Json $currentJson -Budget digest)) },
            { param($Config,$Candidate,$Token) [WatcherStabilityResult]::new('stable',$Candidate) },
            { param($Root2,$Token) [WatcherCycleLockTryResult]::new('acquired',[IO.MemoryStream]::new()) },
            { param($Owner,$Config,$Candidate,$Sink,$Token) $cycles.Add(1); $Owner.Dispose(); [CycleOutcome]::new($true,$true,$false,$true,$true,$null,'stable',$false,$null,$Sink.Freeze()) })

        $p0 = Invoke-WatcherPoll -PriorSample $null -Services $services -CompanionRoot $Root -CancellationToken ([Threading.CancellationToken]::None)
        # Replace source bytes with H2 preserving name, savedAt, and length: an equal-identity candidate.
        [IO.File]::WriteAllText($File, 'H2', [Text.UTF8Encoding]::new($false, $true))
        [IO.File]::SetLastWriteTimeUtc($File, $T)
        $p1 = Invoke-WatcherPoll -PriorSample $p0.sample -Services $services -CompanionRoot $Root -CancellationToken ([Threading.CancellationToken]::None)
        $p2 = Invoke-WatcherPoll -PriorSample $p1.sample -Services $services -CompanionRoot $Root -CancellationToken ([Threading.CancellationToken]::None)
        return [pscustomobject]@{ p0 = $p0.disposition; p1 = $p1.disposition; p2 = $p2.disposition; cycles = $cycles.Count }
    }
    Assert-Equal -Actual $retention.p0 -Expected 'sampled' -Message 'EqualIdentityRetention: the accepted H1 identity records a first observation.'
    Assert-Equal -Actual $retention.p1 -Expected 'quiescent' -Message 'EqualIdentityRetention: an equal-identity byte-touched candidate stays quiescent.'
    Assert-Equal -Actual $retention.p2 -Expected 'quiescent' -Message 'EqualIdentityRetention: repeated equal-identity polls never resume publication.'
    Assert-Equal -Actual $retention.cycles -Expected 0 -Message 'EqualIdentityRetention: the watcher never dispatches a cycle or hashes the equal-identity candidate.'

    # An explicit forced run reprocesses H2; the equal-identity commit guard permits that replacement.
    $forceRoot = New-ScratchCompanionRoot -Prefix 'watcher-equal-identity-force'
    $forced = Invoke-InCompanionModule -ArgumentList @($forceRoot) -ScriptBlock {
        param($Root)

        $Domain = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
        $T = [datetime]::Parse('2026-08-10T00:00:00.0000000Z', [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind)
        $identity = [pscustomobject]@{ domainId = $Domain; saveFile = 'save.ntwtf.zip'; savedAt = $T }
        Initialize-CompanionStateDirectories -CompanionRoot $Root
        $config = [AdapterConfig]::new(); $config.AdapterDirectory = $Root
        $currentPath = Join-Path $Root 'state/current.json'
        $save = Join-Path $Root 'save.ntwtf.zip'
        [IO.File]::WriteAllText($save, 'H1', [Text.UTF8Encoding]::new($false, $true))
        [IO.File]::SetLastWriteTimeUtc($save, $T)

        $readCurrent = { param($Unused) if ([IO.File]::Exists($currentPath)) { $v = Read-CompanionJson -Json ([Text.Encoding]::UTF8.GetString([IO.File]::ReadAllBytes($currentPath))) -Budget digest; $doc = [pscustomobject]@{ RootElement = $v.RootElement; Materialized = $v.Materialized }; $doc | Add-Member -MemberType ScriptMethod -Name Dispose -Value { } -Force | Out-Null; return [pscustomobject]@{ outcome = 'valid'; document = $doc } }; return [pscustomobject]@{ outcome = 'absent'; document = $null } }
        $baseOps = @{
            ReadCurrent = $readCurrent
            ReadBaseline = { [pscustomobject]@{ outcome = 'absent'; document = $null } }
            CompareDiff = { [ordered]@{} }
            WriteCache = { }
            WriteBookkeeping = { }
        }

        $saveDigestH1 = { param($Unused) $r = [SaveDigestResult]::new(); $r.Digest = [ordered]@{ receipt = 'H1'; source = @{ domainId = $Domain; saveFile = 'save.ntwtf.zip'; savedAt = $T.ToString('o', [Globalization.CultureInfo]::InvariantCulture); contentSha256 = 'aaaa' } }; $r.SourceIdentity = $identity; $r }
        $ops1 = $baseOps.Clone(); $ops1.SaveDigest = $saveDigestH1
        $o1 = Invoke-CompanionCycle -CompanionRoot $Root -AdapterDirectory $Root -AdapterConfig $config -SourceSave ([IO.FileInfo]::new($save)) -WarningSink (New-CompanionWarningSink -Profile Cycle) -Operations $ops1
        $h1bytes = [Text.Encoding]::UTF8.GetString([IO.File]::ReadAllBytes($currentPath))

        $saveDigestH2 = { param($Unused) $r = [SaveDigestResult]::new(); $r.Digest = [ordered]@{ receipt = 'H2'; source = @{ domainId = $Domain; saveFile = 'save.ntwtf.zip'; savedAt = $T.ToString('o', [Globalization.CultureInfo]::InvariantCulture); contentSha256 = 'bbbb' } }; $r.SourceIdentity = $identity; $r }
        $ops2 = $baseOps.Clone(); $ops2.SaveDigest = $saveDigestH2
        $o2 = Invoke-CompanionCycle -CompanionRoot $Root -AdapterDirectory $Root -AdapterConfig $config -SourceSave ([IO.FileInfo]::new($save)) -WarningSink (New-CompanionWarningSink -Profile Cycle) -Operations $ops2
        $h2bytes = [Text.Encoding]::UTF8.GetString([IO.File]::ReadAllBytes($currentPath))

        return [pscustomobject]@{ o1 = $o1; o2 = $o2; h1 = $h1bytes; h2 = $h2bytes }
    }
    Assert-True -Condition ($forced.o1.Completed -and $forced.o1.CurrentCommitted -and -not $forced.o1.GuardDiscarded) -Message 'EqualIdentityRetention: H1 publishes fresh when no current exists.'
    Assert-True -Condition $forced.h1.Contains('"receipt":"H1"', [StringComparison]::Ordinal) -Message 'EqualIdentityRetention: the H1 receipt is committed to current.'
    Assert-True -Condition ($forced.o2.Completed -and $forced.o2.CurrentCommitted -and -not $forced.o2.GuardDiscarded) -Message 'EqualIdentityRetention: the equal-identity commit guard permits the forced H2 replacement.'
    Assert-False -Condition $forced.h2.Contains('"receipt":"H1"', [StringComparison]::Ordinal) -Message 'EqualIdentityRetention: forced H2 displacement removes H1 from current.'
    Assert-True -Condition $forced.h2.Contains('"receipt":"H2"', [StringComparison]::Ordinal) -Message 'EqualIdentityRetention: the H2 receipt is committed to current afterwards.'

    Write-Output 'PASS: watcher'
    exit 0
}

if ($Only -eq 'SerializedCyclePublication') {
    $serRoot = New-ScratchCompanionRoot -Prefix 'watcher-serialized'
    $serFile = Join-Path $serRoot 'save.ntwtf.zip'
    $serT = [datetime]::Parse('2026-08-10T00:00:00.0000000Z', [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind)
    [IO.File]::WriteAllText($serFile, 'H1', [Text.UTF8Encoding]::new($false, $true))
    [IO.File]::SetLastWriteTimeUtc($serFile, $serT)

    $serResult = Invoke-InCompanionModule -ArgumentList @($serRoot, $serT) -ScriptBlock {
        param($Root, $T)

        $Domain = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
        Initialize-CompanionStateDirectories -CompanionRoot $Root
        $config = [AdapterConfig]::new(); $config.AdapterDirectory = $Root
        $currentPath = Join-Path $Root 'state/current.json'
        $save = Join-Path $Root 'save.ntwtf.zip'
        $identity = [pscustomobject]@{ domainId = $Domain; saveFile = 'save.ntwtf.zip'; savedAt = $T }

        $readCurrent = { param($Unused) if ([IO.File]::Exists($currentPath)) { $v = Read-CompanionJson -Json ([Text.Encoding]::UTF8.GetString([IO.File]::ReadAllBytes($currentPath))) -Budget digest; $doc = [pscustomobject]@{ RootElement = $v.RootElement; Materialized = $v.Materialized }; $doc | Add-Member -MemberType ScriptMethod -Name Dispose -Value { } -Force | Out-Null; return [pscustomobject]@{ outcome = 'valid'; document = $doc } }; return [pscustomobject]@{ outcome = 'absent'; document = $null } }
        $baseOps = @{ ReadCurrent = $readCurrent; ReadBaseline = { [pscustomobject]@{ outcome = 'absent'; document = $null } }; CompareDiff = { [ordered]@{} }; WriteCache = { }; WriteBookkeeping = { } }
        $makeDigest = { param($Receipt, $Hash, $Identity) [ordered]@{ receipt = $Receipt; source = @{ domainId = $Identity.domainId; saveFile = $Identity.saveFile; savedAt = $Identity.savedAt.ToString('o', [Globalization.CultureInfo]::InvariantCulture); contentSha256 = $Hash } } }

        # W acquires the real cycle.lock.
        $wLock = Enter-CompanionCycleLock -CompanionRoot $Root
        $uBlocked = $false
        try { $null = Enter-CompanionCycleLock -CompanionRoot $Root -TimeoutMilliseconds 0 } catch [TimeoutException] { $uBlocked = $true }

        # A second watcher skips (busy) rather than waiting on a held lock; lock-path errors map the lock domain.
        $probeSample = [WatcherSample]::new($Domain, 'save.ntwtf.zip', $T, [IO.FileInfo]::new($save).Length)
        $busyServices = [WatcherRuntimeServices]::new(
            { param($Token) [pscustomobject]@{ SourceDomainId = $Domain } },
            { param($Config,$Token) @([IO.FileInfo]::new($save)) },
            { param($Config,$Token) [WatcherBookkeepingReadResult]::new('absent',$null) },
            { param($Config,$Token) [WatcherCurrentReadResult]::new('absent',$null) },
            { param($Config,$Candidate,$Token) [WatcherStabilityResult]::new('stable',$Candidate) },
            { param($Root2,$Token) [WatcherCycleLockTryResult]::new('busy',$null) },
            { param($Owner,$Config,$Candidate,$Sink,$Token) throw 'Cycle must not run while the lock is busy.' })
        $busyDisposition = (Invoke-WatcherPoll -PriorSample $probeSample -Services $busyServices -CompanionRoot $Root -CancellationToken ([Threading.CancellationToken]::None)).disposition
        $lockFailServices = [WatcherRuntimeServices]::new(
            { param($Token) [pscustomobject]@{ SourceDomainId = $Domain } },
            { param($Config,$Token) @([IO.FileInfo]::new($save)) },
            { param($Config,$Token) [WatcherBookkeepingReadResult]::new('absent',$null) },
            { param($Config,$Token) [WatcherCurrentReadResult]::new('absent',$null) },
            { param($Config,$Candidate,$Token) [WatcherStabilityResult]::new('stable',$Candidate) },
            { param($Root2,$Token) throw [IO.IOException]::new('lock unavailable') },
            { param($Owner,$Config,$Candidate,$Sink,$Token) throw 'not reached' })
        $lockFailDisposition = (Invoke-WatcherPoll -PriorSample $probeSample -Services $lockFailServices -CompanionRoot $Root -CancellationToken ([Threading.CancellationToken]::None)).disposition

        # W publishes H1 while still holding the lock, then releases.
        $ops1 = $baseOps.Clone(); $ops1.SaveDigest = { param($Unused) $r = [SaveDigestResult]::new(); $r.Digest = & $makeDigest 'H1' 'aaaa' $identity; $r.SourceIdentity = $identity; $r }
        $o1 = Invoke-CompanionCycle -CompanionRoot $Root -AdapterDirectory $Root -AdapterConfig $config -SourceSave ([IO.FileInfo]::new($save)) -WarningSink (New-CompanionWarningSink -Profile Cycle) -Operations $ops1
        $afterW = [Text.Encoding]::UTF8.GetString([IO.File]::ReadAllBytes($currentPath))
        $wLock.Dispose()

        # U re-enumerates the source (now H2) and publishes H2 after acquiring the released lock.
        [IO.File]::WriteAllText($save, 'H2', [Text.UTF8Encoding]::new($false, $true))
        [IO.File]::SetLastWriteTimeUtc($save, $T)
        $uLock = Enter-CompanionCycleLock -CompanionRoot $Root -TimeoutMilliseconds 0
        $ops2 = $baseOps.Clone(); $ops2.SaveDigest = { param($Unused) $r = [SaveDigestResult]::new(); $r.Digest = & $makeDigest 'H2' 'bbbb' $identity; $r.SourceIdentity = $identity; $r }
        $o2 = Invoke-CompanionCycle -CompanionRoot $Root -AdapterDirectory $Root -AdapterConfig $config -SourceSave ([IO.FileInfo]::new($save)) -WarningSink (New-CompanionWarningSink -Profile Cycle) -Operations $ops2
        $afterU = [Text.Encoding]::UTF8.GetString([IO.File]::ReadAllBytes($currentPath))
        $uLock.Dispose()

        # A stale H1 cycle (older identity) is guard-discarded, so H2 stays current (no H1 republish).
        $older = [pscustomobject]@{ domainId = $Domain; saveFile = 'save.ntwtf.zip'; savedAt = $T.AddHours(-1) }
        $ops3 = $baseOps.Clone(); $ops3.SaveDigest = { param($Unused) $r = [SaveDigestResult]::new(); $r.Digest = & $makeDigest 'H1Stale' 'cccc' $older; $r.SourceIdentity = $older; $r }
        $o3 = Invoke-CompanionCycle -CompanionRoot $Root -AdapterDirectory $Root -AdapterConfig $config -SourceSave ([IO.FileInfo]::new($save)) -WarningSink (New-CompanionWarningSink -Profile Cycle) -Operations $ops3
        $afterStale = [Text.Encoding]::UTF8.GetString([IO.File]::ReadAllBytes($currentPath))

        return [pscustomobject]@{ uBlocked = $uBlocked; busy = $busyDisposition; lockFail = $lockFailDisposition; o1 = $o1; o2 = $o2; o3 = $o3; afterW = $afterW; afterU = $afterU; afterStale = $afterStale }
    }
    Assert-True -Condition $serResult.uBlocked -Message 'SerializedCyclePublication: an acquisition remains blocked before source acceptance while the publisher holds the real cycle.lock.'
    Assert-Equal -Actual $serResult.busy -Expected 'busy' -Message 'SerializedCyclePublication: a second watcher skips (busy) rather than waits on a held lock.'
    Assert-Equal -Actual $serResult.lockFail -Expected 'lock-failed' -Message 'SerializedCyclePublication: lock-path errors map to the lock disposition.'
    Assert-True -Condition ($serResult.o1.Completed -and $serResult.o1.CurrentCommitted) -Message 'SerializedCyclePublication: W publishes H1 under its held lock.'
    Assert-True -Condition $serResult.afterW.Contains('"receipt":"H1"', [StringComparison]::Ordinal) -Message 'SerializedCyclePublication: W''s H1 receipt is committed to current.'
    Assert-True -Condition ($serResult.o2.Completed -and $serResult.o2.CurrentCommitted) -Message 'SerializedCyclePublication: U re-enumerates and publishes H2 after W releases.'
    Assert-True -Condition ($serResult.afterU.Contains('"receipt":"H2"', [StringComparison]::Ordinal) -and -not $serResult.afterU.Contains('"receipt":"H1"', [StringComparison]::Ordinal)) -Message 'SerializedCyclePublication: the serialized later publication leaves H2 current.'
    Assert-True -Condition ($serResult.o3.GuardDiscarded -and $serResult.afterStale.Contains('"receipt":"H2"', [StringComparison]::Ordinal)) -Message 'SerializedCyclePublication: a stale H1 cycle cannot publish over current H2.'

    Write-Output 'PASS: watcher'
    exit 0
}

if ($Only -eq 'AcquisitionDomainIsolation') {
    $d1Root = New-ScratchCompanionRoot -Prefix 'watcher-domain-a'
    $d2Root = New-ScratchCompanionRoot -Prefix 'watcher-domain-b'
    $d1Save = Join-Path $d1Root 'save.ntwtf.zip'
    $d2Save = Join-Path $d2Root 'save.ntwtf.zip'
    $dT = [datetime]::Parse('2026-08-10T00:00:00.0000000Z', [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind)
    # Newest files share name, timestamp, and size but differ in bytes.
    [IO.File]::WriteAllText($d1Save, 'AAAAAAAAAA', [Text.UTF8Encoding]::new($false, $true))
    [IO.File]::WriteAllText($d2Save, 'BBBBBBBBBB', [Text.UTF8Encoding]::new($false, $true))
    [IO.File]::SetLastWriteTimeUtc($d1Save, $dT)
    [IO.File]::SetLastWriteTimeUtc($d2Save, $dT)
    Assert-Equal -Actual ([IO.FileInfo]::new($d1Save).Length) -Expected ([IO.FileInfo]::new($d2Save).Length) -Message 'AcquisitionDomainIsolation: the two newest slices share byte length.'

    $isolation = Invoke-InCompanionModule -ArgumentList @($d1Root, $d2Root, $d1Save, $d2Save, $dT) -ScriptBlock {
        param($RootA, $RootB, $SaveA, $SaveB, $T)

        $glob = '*.ntwtf.zip'
        # The exact derivation Get-AdapterConfig uses: sha256(SaveDirectory + NUL + saveGlob).
        $domainA = Get-AdapterSha256 -Bytes ([Text.UTF8Encoding]::new($false).GetBytes([IO.Path]::GetFullPath($RootA) + [char]0 + $glob))
        $domainB = Get-AdapterSha256 -Bytes ([Text.UTF8Encoding]::new($false).GetBytes([IO.Path]::GetFullPath($RootB) + [char]0 + $glob))
        $caseVariant = Get-AdapterSha256 -Bytes ([Text.UTF8Encoding]::new($false).GetBytes([IO.Path]::GetFullPath($RootA).ToUpperInvariant() + [char]0 + $glob))
        $globVariant = Get-AdapterSha256 -Bytes ([Text.UTF8Encoding]::new($false).GetBytes([IO.Path]::GetFullPath($RootA) + [char]0 + '*.zip'))

        $cycles = [Collections.Generic.List[string]]::new()
        $newBytes = [Collections.Generic.List[string]]::new()
        $servicesA = [WatcherRuntimeServices]::new(
            { param($Token) [pscustomobject]@{ SourceDomainId = $domainA } },
            { param($Config,$Token) @([IO.FileInfo]::new($SaveA)) },
            { param($Config,$Token) [WatcherBookkeepingReadResult]::new('valid', (Read-CompanionJson -Json ('{"domainId":"' + $domainA + '","saveFile":"save.ntwtf.zip","savedAt":"' + $T.ToString('o', [Globalization.CultureInfo]::InvariantCulture) + '"}') -Budget config)) },
            { param($Config,$Token) [WatcherCurrentReadResult]::new('valid', (Read-CompanionJson -Json ('{"source":{"domainId":"' + $domainA + '","saveFile":"save.ntwtf.zip","savedAt":"' + $T.ToString('o', [Globalization.CultureInfo]::InvariantCulture) + '"}}') -Budget digest)) },
            { param($Config,$Candidate,$Token) [WatcherStabilityResult]::new('stable',$Candidate) },
            { param($Root,$Token) [WatcherCycleLockTryResult]::new('acquired',[IO.MemoryStream]::new()) },
            { param($Owner,$Config,$Candidate,$Sink,$Token) $cycles.Add('domainA'); $Owner.Dispose(); [CycleOutcome]::new($true,$true,$false,$true,$true,$null,'stable',$false,$null,$Sink.Freeze()) })
        $servicesB = [WatcherRuntimeServices]::new(
            { param($Token) [pscustomobject]@{ SourceDomainId = $domainB } },
            { param($Config,$Token) @([IO.FileInfo]::new($SaveB)) },
            { param($Config,$Token) [WatcherBookkeepingReadResult]::new('absent',$null) },
            { param($Config,$Token) [WatcherCurrentReadResult]::new('absent',$null) },
            { param($Config,$Candidate,$Token) [WatcherStabilityResult]::new('stable',$Candidate) },
            { param($Root,$Token) [WatcherCycleLockTryResult]::new('acquired',[IO.MemoryStream]::new()) },
            { param($Owner,$Config,$Candidate,$Sink,$Token) $cycles.Add('domainB'); $newBytes.Add([IO.File]::ReadAllText($Candidate.FullName)); $Owner.Dispose(); [CycleOutcome]::new($true,$true,$false,$true,$true,$null,'stable',$false,$null,$Sink.Freeze()) })

        # Domain A: observe twice, then quiescence under its own bookkeeping.
        $pA0 = Invoke-WatcherPoll -PriorSample $null -Services $servicesA -CompanionRoot $RootA -CancellationToken ([Threading.CancellationToken]::None)
        $pA1 = Invoke-WatcherPoll -PriorSample $pA0.sample -Services $servicesA -CompanionRoot $RootA -CancellationToken ([Threading.CancellationToken]::None)
        # Switch the save selector to domain B: the old domain-A sample no longer matches.
        $pB0 = Invoke-WatcherPoll -PriorSample $pA1.sample -Services $servicesB -CompanionRoot $RootB -CancellationToken ([Threading.CancellationToken]::None)
        $pB1 = Invoke-WatcherPoll -PriorSample $pB0.sample -Services $servicesB -CompanionRoot $RootB -CancellationToken ([Threading.CancellationToken]::None)
        # A fresh watcher restart in domain B also re-extracts the slice bytes.
        $pBRestart = Invoke-WatcherPoll -PriorSample $null -Services $servicesB -CompanionRoot $RootB -CancellationToken ([Threading.CancellationToken]::None)
        $restartBytes = [IO.File]::ReadAllText($SaveB)

        return [pscustomobject]@{ domainSwitch = (-not [string]::Equals($domainA,$domainB,[StringComparison]::Ordinal)); caseSwitch = (-not [string]::Equals($domainA,$caseVariant,[StringComparison]::Ordinal)); globSwitch = (-not [string]::Equals($domainA,$globVariant,[StringComparison]::Ordinal)); pA0=$pA0.disposition; pA1=$pA1.disposition; pB0=$pB0.disposition; pB1=$pB1.disposition; pBRestart=$pBRestart.disposition; cycles=($cycles -join ','); newBytes=($newBytes -join ','); restartBytes=$restartBytes }
    }
    Assert-True -Condition $isolation.domainSwitch -Message 'AcquisitionDomainIsolation: switching the save selector derives a different domain.'
    Assert-True -Condition $isolation.caseSwitch -Message 'AcquisitionDomainIsolation: case-only path spellings conservatively derive different domains.'
    Assert-True -Condition $isolation.globSwitch -Message 'AcquisitionDomainIsolation: a changed saveGlob derives a different domain.'
    Assert-Equal -Actual $isolation.pA0 -Expected 'sampled' -Message 'AcquisitionDomainIsolation: domain A records its first observation.'
    Assert-Equal -Actual $isolation.pA1 -Expected 'quiescent' -Message 'AcquisitionDomainIsolation: domain A reaches quiescence under its own bookkeeping.'
    Assert-Equal -Actual $isolation.pB0 -Expected 'sampled' -Message 'AcquisitionDomainIsolation: the domain switch clears the old sample and requires a new observation.'
    Assert-Equal -Actual $isolation.pB1 -Expected 'cycled' -Message 'AcquisitionDomainIsolation: the second new-domain observation dispatches against the old-domain gap.'
    Assert-OrdinalEqual -Actual $isolation.cycles -Expected 'domainB' -Message 'AcquisitionDomainIsolation: no cycle publishes before two new-domain observations.'
    Assert-OrdinalEqual -Actual $isolation.newBytes -Expected 'BBBBBBBBBB' -Message 'AcquisitionDomainIsolation: watcher extraction reads the new domain''s slice bytes.'
    Assert-OrdinalEqual -Actual $isolation.restartBytes -Expected 'BBBBBBBBBB' -Message 'AcquisitionDomainIsolation: a fresh watcher restart re-extracts the new slice bytes.'

    Write-Output 'PASS: watcher'
    exit 0
}

Write-Output 'PASS: watcher'
