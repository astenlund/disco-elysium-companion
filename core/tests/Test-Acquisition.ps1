#Requires -Version 7.5

[CmdletBinding()]
param(
    [Parameter()]
    [ValidateSet('All', 'SaveCandidates', 'FileWriteStable', 'FileWriteStableUnstable', 'FileWriteStableCancellation', 'MissingSource', 'CopyFidelityReasons', 'CopyFidelitySizeLimit', 'AdapterFailureReason', 'OutcomeClosure', 'OutcomeFreeze', 'StagedOneShot', 'ScratchDefault', 'CopyFailure', 'AdapterFailures', 'CurrentReadFailure', 'CurrentWriteFailure', 'CacheWriteFailure', 'BookkeepingFailure', 'GuardDiscard', 'BaselineFallback', 'Cancellation', 'CheckpointCancellation', 'CurrentWriteCancellation', 'CheckpointPropagation', 'SaveCandidatesEnumerationFailure', 'PackageMemberRemediation')]
    [string] $Only = 'All'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Import-Module (Join-Path (Split-Path $PSScriptRoot -Parent) 'DigestDiff.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'TestSupport.psm1') -Force

function Test-SaveCandidatesUseOrdinalTieBreakAndEmptyArray {
    $root = New-ScratchCompanionRoot -Prefix 'acquisition'
    $saveDirectory = Join-Path $root 'saves'
    [void] [IO.Directory]::CreateDirectory($saveDirectory)
    $timestamp = [datetime]::UtcNow
    foreach ($name in @('a.ntwtf.zip', 'B.ntwtf.zip', 'ignored.txt')) {
        $path = Join-Path $saveDirectory $name
        [IO.File]::WriteAllText($path, 'x', [Text.UTF8Encoding]::new($false))
        [IO.File]::SetLastWriteTimeUtc($path, $timestamp)
    }

    $candidates = @(Get-SaveCandidates -SaveDirectory $saveDirectory -SaveGlob '*.ntwtf.zip')
    Assert-Equal -Actual $candidates.Count -Expected 2 -Message 'only matching direct children are retained'
    Assert-Equal -Actual $candidates[0].Name -Expected 'a.ntwtf.zip' -Message 'ordinal descending tie break is applied'
    Assert-Equal -Actual (Get-NewestSave -SaveDirectory $saveDirectory -SaveGlob '*.missing') -Expected $null -Message 'no candidate has a null newest result'
    Assert-Equal -Actual (@(Get-SaveCandidates -SaveDirectory $saveDirectory -SaveGlob '*.missing')).Count -Expected 0 -Message 'no candidate returns an empty array'
}

function Test-SaveCandidatesEnumerationFailure {
    $root = New-ScratchCompanionRoot -Prefix 'enumeration-failure'
    $saveDirectory = Join-Path $root 'saves'
    [void] [IO.Directory]::CreateDirectory($saveDirectory)

    $emptyAtLimit = Invoke-InCompanionModule -ArgumentList @($saveDirectory) -ScriptBlock {
        param($InnerSaveDirectory)
        $script:SaveCandidateEntryLimit = 1
        try {
            return @(Get-SaveCandidates -SaveDirectory $InnerSaveDirectory -SaveGlob '*.ntwtf.zip').Count
        }
        finally {
            $script:SaveCandidateEntryLimit = 65536
        }
    }
    Assert-Equal -Actual $emptyAtLimit -Expected 0 -Message 'an empty candidate set at the exact limit is legal'

    $threwLimit = Invoke-InCompanionModule -ArgumentList @($saveDirectory) -ScriptBlock {
        param($InnerSaveDirectory)
        [IO.File]::WriteAllText((Join-Path $InnerSaveDirectory 'a.ntwtf.zip'), 'x', [Text.UTF8Encoding]::new($false))
        [IO.File]::WriteAllText((Join-Path $InnerSaveDirectory 'b.ntwtf.zip'), 'x', [Text.UTF8Encoding]::new($false))
        $script:SaveCandidateEntryLimit = 1
        try {
            Get-SaveCandidates -SaveDirectory $InnerSaveDirectory -SaveGlob '*.ntwtf.zip'
            return $false
        }
        catch [SaveCandidateLimitException] {
            return $true
        }
        finally {
            $script:SaveCandidateEntryLimit = 65536
        }
    }
    Assert-True -Condition $threwLimit -Message 'an over-limit enumeration throws the typed limit exception rather than returning a truncated set'
}

function Test-FileWriteStableReturnsAfterMatchingSamples {
    $root = New-ScratchCompanionRoot -Prefix 'stability'
    $save = Join-Path $root 'save.ntwtf.zip'
    [IO.File]::WriteAllText($save, 'stable', [Text.UTF8Encoding]::new($false))

    Assert-True -Condition (Test-FileWriteStable -Path $save -SampleDelayMilliseconds 1) -Message 'equal consecutive metadata samples are stable'
}

function Test-SaveDigestClassifiesMissingSourceAsVanished {
    $root = New-ScratchCompanionRoot -Prefix 'missing-source'
    try {
        Invoke-InCompanionModule -ArgumentList @($root) -ScriptBlock {
            param($innerRoot)
            $config = [AdapterConfig]::new()
            $config.MaxSourceBytes = 1024
            Invoke-SaveDigest -AdapterDirectory $innerRoot -AdapterConfig $config -SourceSave ([IO.FileInfo]::new((Join-Path $innerRoot 'gone.ntwtf.zip'))) -WorkFileStem 'work-cycle' -WarningSink (New-CompanionWarningSink -Profile Cycle)
        }
        throw [InvalidOperationException]::new('Missing source was accepted.')
    }
    catch {
        Assert-Equal -Actual $_.Exception.GetType().Name -Expected 'SaveDigestStageException' -Message 'source absence uses the typed stage channel'
        Assert-Equal -Actual $_.Exception.Stage -Expected 'copy' -Message 'source absence is a copy-stage failure'
        Assert-Equal -Actual $_.Exception.SourceDisposition -Expected 'vanished' -Message 'missing source remains distinguishable from unreadable source'
    }
}

function Test-SaveDigestClassifiesSizeLimitAsUnreadableCopyFailure {
    $root = New-ScratchCompanionRoot -Prefix 'copy-size-limit'
    $source = Join-Path $root 'big.ntwtf.zip'
    [IO.File]::WriteAllText($source, ('x' * 1024), [Text.UTF8Encoding]::new($false))
    try {
        Invoke-InCompanionModule -ArgumentList @($root, $source) -ScriptBlock {
            param($innerRoot, $innerSource)
            $config = [AdapterConfig]::new()
            $config.MaxSourceBytes = 4
            Invoke-SaveDigest -AdapterDirectory (Join-Path $innerRoot 'adapters/example') -AdapterConfig $config -SourceSave ([IO.FileInfo]::new($innerSource)) -WorkFileStem 'work-cycle' -WarningSink (New-CompanionWarningSink -Profile Cycle)
        }
        throw [InvalidOperationException]::new('An oversized source was accepted.')
    }
    catch {
        Assert-Equal -Actual $_.Exception.GetType().Name -Expected 'SaveDigestStageException' -Message 'size limit uses the typed stage channel'
        Assert-Equal -Actual $_.Exception.Stage -Expected 'copy' -Message 'size limit is a copy-stage failure'
        Assert-Equal -Actual $_.Exception.Reason -Expected 'source-size-limit-exceeded' -Message 'size limit reason is carried by the typed exception'
        Assert-Equal -Actual $_.Exception.SourceDisposition -Expected 'unreadable' -Message 'size limit is not treated as a retryable source change'
    }
}

function Test-AdapterCommandFailureReasonClassifiesExitAndMissingOutput {
    $root = New-ScratchCompanionRoot -Prefix 'adapter-failure-reason'
    $result = Invoke-InCompanionModule -ArgumentList @($root) -ScriptBlock {
        param($innerRoot)
        $nonzero = [AdapterCommandResult]::new()
        $nonzero.Started = $true
        $nonzero.ExitCode = 5
        $exitNonzero = Get-AdapterCommandFailureReason -Result $nonzero -OutputPath (Join-Path $innerRoot 'never.json')
        $clean = [AdapterCommandResult]::new()
        $clean.Started = $true
        $clean.ExitCode = 0
        $promisedMissing = Get-AdapterCommandFailureReason -Result $clean -OutputPath (Join-Path $innerRoot 'missing.json')

        return [pscustomobject]@{ ExitNonzero = $exitNonzero; PromisedMissing = $promisedMissing }
    }
    Assert-OrdinalEqual -Actual $result.ExitNonzero -Expected 'command-exit-nonzero' -Message 'a nonzero exit classifies as command-exit-nonzero'
    Assert-OrdinalEqual -Actual $result.PromisedMissing -Expected 'promised-output-missing' -Message 'a missing promised output file classifies as promised-output-missing'
}

function Test-CycleMapsCopyFailureReasonsToDispositionAndRetryable {
    foreach ($row in @(
            [pscustomobject]@{ Reason = 'source-changed'; Disposition = 'changed'; Retryable = $true },
            [pscustomobject]@{ Reason = 'source-size-limit-exceeded'; Disposition = 'unreadable'; Retryable = $false })) {
        $root = New-ScratchCompanionRoot -Prefix 'cycle-copy-disposition'
        Invoke-InCompanionModule -ArgumentList @($root, $row) -ScriptBlock {
            param($innerRoot, $innerRow)
            $config = [AdapterConfig]::new(); $config.AdapterDirectory = $innerRoot
            $sink = New-CompanionWarningSink -Profile Cycle
            $operations = @{ SaveDigest = { throw [SaveDigestStageException]::new('copy', $innerRow.Disposition, $innerRow.Reason, [pscustomobject]@{}, $null) } }
            $outcome = Invoke-CompanionCycle -CompanionRoot $innerRoot -AdapterDirectory $innerRoot -AdapterConfig $config -SourceSave ([IO.FileInfo]::new((Join-Path $innerRoot 'source.zip'))) -WarningSink $sink -Operations $operations
            Assert-OrdinalEqual -Actual $outcome.FailurePhase -Expected 'source' -Message 'copy failure maps to source phase'
            Assert-OrdinalEqual -Actual $outcome.Detail -Expected $innerRow.Reason -Message 'copy reason survives into the outcome detail'
            Assert-True -Condition ($outcome.Retryable -eq $innerRow.Retryable) -Message "copy reason $($innerRow.Reason) maps to retryable $($innerRow.Retryable), got $($outcome.Retryable)"
        }
    }
}

function Test-FileWriteStableRejectsMismatchingSamples {
    $root = New-ScratchCompanionRoot -Prefix 'stability-unstable'
    $save = Join-Path $root 'save.ntwtf.zip'
    [IO.File]::WriteAllText($save, 'x', [Text.UTF8Encoding]::new($false))
    $writerProgram = 'while ($true) { [IO.File]::AppendAllText($env:COMPANION_WRITE_TARGET, "x"); Start-Sleep -Milliseconds 1 }'
    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = 'pwsh'
    $startInfo.UseShellExecute = $false
    foreach ($argument in @('-NoProfile', '-Command', $writerProgram)) { $startInfo.ArgumentList.Add($argument) }
    $startInfo.Environment['COMPANION_WRITE_TARGET'] = $save
    $writer = [Diagnostics.Process]::Start($startInfo)
    try {
        $initialLength = [IO.FileInfo]::new($save).Length
        $wait = [Diagnostics.Stopwatch]::StartNew()
        while ([IO.FileInfo]::new($save).Length -le $initialLength) {
            if ($wait.ElapsedMilliseconds -gt 5000) { throw [TimeoutException]::new('Writer never grew the source.') }
            [Threading.Thread]::Sleep(10)
        }
        Assert-False -Condition (Test-FileWriteStable -Path $save -SampleDelayMilliseconds 200) -Message 'a continuously growing source is never stable'
    }
    finally {
        if (-not $writer.HasExited) { $writer.Kill($true); $writer.WaitForExit() }
        $writer.Dispose()
    }
}

function Test-FileWriteStableCancellationReturnsFalse {
    $root = New-ScratchCompanionRoot -Prefix 'stability-cancel'
    $save = Join-Path $root 'save.ntwtf.zip'
    [IO.File]::WriteAllText($save, 'x', [Text.UTF8Encoding]::new($false))
    $cancel = [Threading.CancellationTokenSource]::new()
    $cancel.Cancel()
    try {
        Assert-False -Condition (Test-FileWriteStable -Path $save -SampleDelayMilliseconds 1 -CancellationToken $cancel.Token) -Message 'a cancelled stability probe returns false before its delay'
    }
    finally {
        $cancel.Dispose()
    }
}


function Test-CycleOutcomeRejectsIllegalCombinations {
    Invoke-InCompanionModule -ScriptBlock {
        $rows = @(
            @($true, $true, $false, $true, $true, $null, 'stable', $false, $null), @($true, $false, $true, $false, $true, $null, 'stable', $false, $null),
            @($false, $false, $false, $false, $false, 'initialize', 'not-checked', $false, 'cycle-initialize-failed'), @($false, $false, $false, $false, $false, 'source', 'vanished', $true, 'source-vanished'),
            @($false, $false, $false, $false, $false, 'source', 'changed', $true, 'source-changed'), @($false, $false, $false, $false, $false, 'source', 'unreadable', $false, 'source-unreadable'),
            @($false, $false, $false, $false, $false, 'dump', 'stable', $false, 'command-timeout'), @($false, $false, $false, $false, $false, 'digest', 'stable', $false, 'document-invalid'),
            @($false, $false, $false, $false, $false, 'commit', 'stable', $false, 'current-write-failed'), @($false, $true, $false, $false, $false, 'cache', 'stable', $false, 'cycle-cache'),
            @($false, $true, $false, $true, $false, 'bookkeeping', 'stable', $false, 'cycle-bookkeeping'), @($false, $false, $true, $false, $false, 'bookkeeping', 'stable', $false, 'cycle-bookkeeping')
        )
        foreach ($row in $rows) {
            $outcome = [CycleOutcome]::new($row[0], $row[1], $row[2], $row[3], $row[4], $row[5], $row[6], $row[7], $row[8], @())
            Assert-True -Condition ($outcome -is [CycleOutcome]) -Message 'every closed outcome row is accepted'
        }
        $sink = New-CompanionWarningSink -Profile Cycle
        $factorySuccess = New-CycleOutcome -Completed $true -CurrentCommitted $true -GuardDiscarded $false -CacheWritten $true -BookkeepingWritten $true -FailurePhase $null -SourceDisposition 'stable' -Retryable $false -Detail $null -WarningSink $sink
        Assert-True -Condition $factorySuccess.Completed -Message 'cycle factory preserves null success fields'
        Assert-ThrowsType -TypeName 'CompanionDocumentValidationException' -Action {
            [CycleOutcome]::new($true, $true, $false, $false, $true, $null, 'stable', $false, $null, @())
        }
    }
}

function Test-CycleOutcomeFreezesWarningsAfterResultDisposal {
    $root = New-ScratchCompanionRoot -Prefix 'cycle-cleanup-warning'
    $ownedPath = Join-Path $root 'owned.tmp'
    [IO.File]::WriteAllText($ownedPath, 'owned', [Text.UTF8Encoding]::new($false))
    $lock = [IO.File]::Open($ownedPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    try {
        Invoke-InCompanionModule -ArgumentList @($ownedPath) -ScriptBlock {
            param($innerOwnedPath)
            $sink = New-CompanionWarningSink -Profile Cycle
            $result = [SaveDigestResult]::new()
            $result.OwnedPaths = @($innerOwnedPath)
            $result.WarningSink = $sink
            $outcome = Complete-CycleOutcome -Result $result -Completed $true -CurrentCommitted $true -GuardDiscarded $false -CacheWritten $true -BookkeepingWritten $true -FailurePhase $null -SourceDisposition 'stable' -Retryable $false -Detail $null -WarningSink $sink
            Assert-Equal -Actual $outcome.Warnings.Count -Expected 1 -Message 'result disposal warning survives outcome freezing'
            Assert-OrdinalEqual -Actual $outcome.Warnings[0].code -Expected 'pipeline-cleanup-degraded' -Message 'result cleanup warning is retained'
        }
    }
    finally {
        $lock.Dispose()
    }
}

function Test-StagedOneShotKeepsPreCycleOrdering {
    # Behavioral order probe: the staged one-shot runs against stub EntryFence/DigestDiff
    # modules whose functions append their step to a trace file, so the assertion pins the
    # executed order rather than the script's source text.
    $root = New-ScratchCompanionRoot -Prefix 'one-shot-ordering'
    $core = Join-Path $root 'core'
    [void] [IO.Directory]::CreateDirectory($core)
    Copy-Item -LiteralPath (Join-Path (Split-Path $PSScriptRoot -Parent) 'Update-CompanionState.ps1') -Destination (Join-Path $core 'Update-CompanionState.ps1')
    $stubEntryFence = @'
function Enter-CompanionEntryFence { param($CompanionRoot) return [pscustomobject]@{} | Add-Member -MemberType ScriptMethod -Name Dispose -Value { } -PassThru }
Export-ModuleMember -Function Enter-CompanionEntryFence
'@
    [IO.File]::WriteAllText((Join-Path $core 'EntryFence.psm1'), $stubEntryFence, [Text.UTF8Encoding]::new($false))
    $stubDigestDiff = @'
$script:TracePath = Join-Path (Split-Path $PSScriptRoot -Parent) 'trace.txt'
function Add-TraceStep { param([string] $Step) Add-Content -LiteralPath $script:TracePath -Value $Step }
function New-DisposableStub { param([hashtable] $Properties = @{}) return [pscustomobject]$Properties | Add-Member -MemberType ScriptMethod -Name Dispose -Value { } -PassThru }
function Get-AdapterConfig { param($CompanionRoot, $Adapter, $Profile) Add-TraceStep ($(if ([string]::IsNullOrEmpty($Adapter)) { 'config' } else { 'confirmation' })); return New-DisposableStub @{ AdapterName = 'example'; AdapterDirectory = $CompanionRoot; SaveDirectory = $CompanionRoot; SaveGlob = '*.zip'; ConfigReceipt = 'receipt' } }
function Initialize-CompanionStateDirectories { param($CompanionRoot) }
function New-CompanionWarningSink { param($Profile) return [pscustomobject]@{} }
function Invoke-WorkFileReaper { param($CompanionRoot, $WarningSink) Add-TraceStep 'reaper' }
function Enter-CompanionCycleLock { param($CompanionRoot) Add-TraceStep 'cycle-lock'; return New-DisposableStub }
function Get-NewestSave { param($SaveDirectory, $SaveGlob) Add-TraceStep 'candidates'; return [pscustomobject]@{ FullName = Join-Path $SaveDirectory 'save.zip' } }
function Test-FileWriteStable { param($Path) return $true }
function Invoke-CompanionCycle { param($CompanionRoot, $AdapterDirectory, $AdapterConfig, $SourceSave, $WarningSink) Add-TraceStep 'cycle'; return [pscustomobject]@{ Completed = $true; Warnings = @() } }
Export-ModuleMember -Function *
'@
    [IO.File]::WriteAllText((Join-Path $core 'DigestDiff.psm1'), $stubDigestDiff, [Text.UTF8Encoding]::new($false))

    $child = Invoke-BoundedPwsh -Arguments @('-File', (Join-Path $core 'Update-CompanionState.ps1'), '-CompanionRoot', $root) -WorkingDirectory $root
    Assert-Equal -Actual $child.ExitCode -Expected 0 -Message 'the traced one-shot completes cleanly against the stub modules'
    $trace = [IO.File]::ReadAllLines((Join-Path $root 'trace.txt'))
    Assert-OrdinalEqual -Actual ($trace -join ',') -Expected 'config,reaper,cycle-lock,confirmation,candidates,reaper,cycle' -Message 'one-shot executes config, reaping, lock, confirmation, candidate selection, reaping, and cycle allocation in order'

    # Static guard, anchored on function names only: the cycle body never recursively
    # acquires the caller-owned cycle lock.
    $cycleSource = [IO.File]::ReadAllText((Join-Path (Split-Path $PSScriptRoot -Parent) 'private/Acquisition.ps1'), [Text.UTF8Encoding]::new($false, $true))
    $cycleStart = $cycleSource.IndexOf('function Invoke-CompanionCycle', [StringComparison]::Ordinal)
    Assert-True -Condition ($cycleStart -ge 0) -Message 'the cycle function is present for the recursive-lock guard'
    $cycleBody = $cycleSource.Substring($cycleStart, $cycleSource.IndexOf('function Invoke-SaveDigest', $cycleStart, [StringComparison]::Ordinal) - $cycleStart)
    Assert-False -Condition $cycleBody.Contains('Enter-CompanionCycleLock', [StringComparison]::Ordinal) -Message 'cycle never recursively acquires its caller-owned lock'
}

function Test-StagedOneShotUsesScratchDefaultRootAndReleasesEntryLeaseAfterConfigFailure {
    $root = New-ScratchCompanionRoot -Prefix 'staged-one-shot'
    $sourceCore = Split-Path $PSScriptRoot -Parent
    Copy-Item -LiteralPath $sourceCore -Destination $root -Recurse
    $stagedSource = Join-Path $sourceCore 'Update-CompanionState.ps1'
    $stagedDestination = Join-Path $root 'core/Update-CompanionState.ps1'
    [IO.File]::Delete($stagedDestination)
    [IO.File]::Copy($stagedSource, $stagedDestination, $false)
    $adapterDirectory = Join-Path $root 'adapters/bad'
    [void] [IO.Directory]::CreateDirectory($adapterDirectory)
    [IO.File]::WriteAllText((Join-Path $adapterDirectory 'adapter.json'), '{}', [Text.UTF8Encoding]::new($false))

    $child = Invoke-BoundedPwsh -Arguments @('-File', $stagedDestination, '-Adapter', 'bad') -WorkingDirectory $root
    Assert-Equal -Actual $child.ExitCode -Expected 1 -Message 'staged one-shot rejects an invalid scratch adapter'
    Assert-OrdinalEqual -Actual $child.StdOut -Expected '' -Message 'failed staged one-shot emits no stdout'
    Assert-OrdinalEqual -Actual $child.StdErr.Trim() -Expected '[config] adapter-config-invalid' -Message 'staged one-shot maps adapter configuration failures to the closed stderr frame'

    $entryLockPath = Join-Path $root '.tmp/state-extraction-v2-entry-fence.lock'
    Assert-True -Condition ([IO.File]::Exists($entryLockPath)) -Message 'staged one-shot creates its scratch entry fence lock'
    $entryLock = [IO.File]::Open($entryLockPath, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    try {
        Assert-True -Condition ($null -ne $entryLock) -Message 'staged one-shot releases its entry lease before process exit'
    }
    finally {
        $entryLock.Dispose()
    }
}

function Test-CycleMapsInjectedCopyFailureToRetryableSourceOutcome {
    $root = New-ScratchCompanionRoot -Prefix 'cycle-stage-seam'
    Invoke-InCompanionModule -ArgumentList @($root) -ScriptBlock {
        param($innerRoot)
        $config = [AdapterConfig]::new()
        $config.AdapterDirectory = $innerRoot
        $sink = New-CompanionWarningSink -Profile Cycle
        $operations = @{ SaveDigest = { throw [SaveDigestStageException]::new('copy', 'changed', 'source-changed', [pscustomobject]@{}, $null) } }
        $outcome = Invoke-CompanionCycle -CompanionRoot $innerRoot -AdapterDirectory $innerRoot -AdapterConfig $config -SourceSave ([IO.FileInfo]::new((Join-Path $innerRoot 'source.zip'))) -WarningSink $sink -Operations $operations
        Assert-OrdinalEqual -Actual $outcome.FailurePhase -Expected 'source' -Message 'injected copy failure maps to source phase'
        Assert-True -Condition $outcome.Retryable -Message 'changed source is retryable'
    }
}

function Test-CycleMapsInjectedAdapterStageFailures {
    foreach ($stage in @('dump', 'digest')) {
        $root = New-ScratchCompanionRoot -Prefix 'cycle-adapter-stage'
        Invoke-InCompanionModule -ArgumentList @($root, $stage) -ScriptBlock {
            param($innerRoot, $innerStage)
            $config = [AdapterConfig]::new(); $config.AdapterDirectory = $innerRoot
            $sink = New-CompanionWarningSink -Profile Cycle
            $operations = @{ SaveDigest = { throw [SaveDigestStageException]::new($innerStage, 'stable', 'command-timeout', [pscustomobject]@{}, $null) } }
            $outcome = Invoke-CompanionCycle -CompanionRoot $innerRoot -AdapterDirectory $innerRoot -AdapterConfig $config -SourceSave ([IO.FileInfo]::new((Join-Path $innerRoot 'source.zip'))) -WarningSink $sink -Operations $operations
            Assert-OrdinalEqual -Actual $outcome.FailurePhase -Expected $innerStage -Message 'adapter failure preserves its stage'
            Assert-False -Condition $outcome.Retryable -Message 'adapter failures are not retryable'
        }
    }
}

function Test-CycleMapsInjectedCurrentReadFailureToCommitOutcome {
    $root = New-ScratchCompanionRoot -Prefix 'cycle-commit-seam'
    Invoke-InCompanionModule -ArgumentList @($root) -ScriptBlock {
        param($innerRoot)
        $config = [AdapterConfig]::new(); $config.AdapterDirectory = $innerRoot
        $sink = New-CompanionWarningSink -Profile Cycle
        $operations = @{
            SaveDigest = { [SaveDigestResult]::new() }
            ReadCurrent = { [pscustomobject]@{ outcome = 'infrastructure-failure'; document = $null } }
        }
        $outcome = Invoke-CompanionCycle -CompanionRoot $innerRoot -AdapterDirectory $innerRoot -AdapterConfig $config -SourceSave ([IO.FileInfo]::new((Join-Path $innerRoot 'source.zip'))) -WarningSink $sink -Operations $operations
        Assert-OrdinalEqual -Actual $outcome.FailurePhase -Expected 'commit' -Message 'current infrastructure failure maps to commit phase'
        Assert-False -Condition $outcome.CurrentCommitted -Message 'failed guard never commits current'
    }
}

function Test-CycleMapsInjectedCurrentWriteFailureToCommitOutcome {
    $root = New-ScratchCompanionRoot -Prefix 'cycle-write-seam'
    Invoke-InCompanionModule -ArgumentList @($root) -ScriptBlock {
        param($innerRoot)
        $config = [AdapterConfig]::new(); $config.AdapterDirectory = $innerRoot
        $sink = New-CompanionWarningSink -Profile Cycle
        $operations = @{
            SaveDigest = { [SaveDigestResult]::new() }
            ReadCurrent = { [pscustomobject]@{ outcome = 'absent'; document = $null } }
            WriteCurrent = { throw [IO.IOException]::new('injected') }
        }
        $outcome = Invoke-CompanionCycle -CompanionRoot $innerRoot -AdapterDirectory $innerRoot -AdapterConfig $config -SourceSave ([IO.FileInfo]::new((Join-Path $innerRoot 'source.zip'))) -WarningSink $sink -Operations $operations
        Assert-OrdinalEqual -Actual $outcome.FailurePhase -Expected 'commit' -Message 'current write failure maps to commit phase'
        Assert-False -Condition $outcome.CurrentCommitted -Message 'failed current write does not publish current'
    }
}

function Test-CycleMapsInjectedCacheWriteFailureAfterCommit {
    $root = New-ScratchCompanionRoot -Prefix 'cycle-cache-seam'
    Invoke-InCompanionModule -ArgumentList @($root) -ScriptBlock {
        param($innerRoot)
        $config = [AdapterConfig]::new(); $config.AdapterDirectory = $innerRoot
        $sink = New-CompanionWarningSink -Profile Cycle
        $operations = @{
            SaveDigest = { [SaveDigestResult]::new() }
            ReadCurrent = { [pscustomobject]@{ outcome = 'absent'; document = $null } }
            WriteCurrent = { }
            ReadBaseline = { [pscustomobject]@{ outcome = 'absent'; document = $null } }
            CompareDiff = { [ordered]@{} }
            WriteCache = { throw [IO.IOException]::new('injected') }
        }
        $outcome = Invoke-CompanionCycle -CompanionRoot $innerRoot -AdapterDirectory $innerRoot -AdapterConfig $config -SourceSave ([IO.FileInfo]::new((Join-Path $innerRoot 'source.zip'))) -WarningSink $sink -Operations $operations
        Assert-OrdinalEqual -Actual $outcome.FailurePhase -Expected 'cache' -Message 'cache write failure maps to cache phase'
        Assert-True -Condition $outcome.CurrentCommitted -Message 'cache failure preserves committed current'
    }
}

function Test-CycleMapsInjectedBookkeepingFailureAfterCommit {
    $root = New-ScratchCompanionRoot -Prefix 'cycle-bookkeeping-seam'
    Invoke-InCompanionModule -ArgumentList @($root) -ScriptBlock {
        param($innerRoot)
        $config = [AdapterConfig]::new(); $config.AdapterDirectory = $innerRoot
        $sink = New-CompanionWarningSink -Profile Cycle
        $operations = @{
            SaveDigest = { [SaveDigestResult]::new() }
            ReadCurrent = { [pscustomobject]@{ outcome = 'absent'; document = $null } }
            WriteCurrent = { }
            ReadBaseline = { [pscustomobject]@{ outcome = 'absent'; document = $null } }
            CompareDiff = { [ordered]@{} }
            WriteCache = { }
            WriteBookkeeping = { throw [IO.IOException]::new('injected') }
        }
        $outcome = Invoke-CompanionCycle -CompanionRoot $innerRoot -AdapterDirectory $innerRoot -AdapterConfig $config -SourceSave ([IO.FileInfo]::new((Join-Path $innerRoot 'source.zip'))) -WarningSink $sink -Operations $operations
        Assert-OrdinalEqual -Actual $outcome.FailurePhase -Expected 'bookkeeping' -Message 'bookkeeping failure maps to bookkeeping phase'
        Assert-True -Condition ($outcome.CurrentCommitted -and $outcome.CacheWritten) -Message 'bookkeeping failure preserves completed prior stages'
    }
}

function Test-GuardDiscardSkipsCacheAndStillWritesBookkeeping {
    $root = New-ScratchCompanionRoot -Prefix 'cycle-guard-discard'
    Invoke-InCompanionModule -ArgumentList @($root) -ScriptBlock {
        param($innerRoot)
        $config = [AdapterConfig]::new(); $config.AdapterDirectory = $innerRoot
        $sink = New-CompanionWarningSink -Profile Cycle
        Initialize-CompanionStateDirectories -CompanionRoot $innerRoot
        $stages = [Collections.Generic.List[string]]::new()
        try {
            $outcome = Invoke-CompanionCycle -CompanionRoot $innerRoot -AdapterDirectory $innerRoot -AdapterConfig $config -SourceSave ([IO.FileInfo]::new((Join-Path $innerRoot 'source.zip'))) -WarningSink $sink -Operations @{
                SaveDigest = {
                    $saveDigestResult = [SaveDigestResult]::new()
                    $saveDigestResult.Digest = [Text.Json.JsonDocument]::Parse('{}')
                    $saveDigestResult.SourceIdentity = [pscustomobject]@{ domainId = 'domain'; saveFile = 'older.zip'; savedAt = [datetime]::Parse('2026-08-10T11:00:00.0000000Z', [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind) }

                    return $saveDigestResult
                }
                ReadCurrent = { [pscustomobject]@{ outcome = 'valid'; document = [Text.Json.JsonDocument]::Parse('{"source":{"domainId":"domain","saveFile":"newer.zip","savedAt":"2026-08-10T12:00:00.0000000Z"}}') } }
                WriteCurrent = { $stages.Add('current') }
                ReadBaseline = { $stages.Add('baseline'); [pscustomobject]@{ outcome = 'absent'; document = $null } }
                CompareDiff = { $stages.Add('compare'); [ordered]@{} }
                WriteCache = { $stages.Add('cache') }
            }
            Assert-True -Condition ($outcome.Completed -and $outcome.GuardDiscarded -and $outcome.BookkeepingWritten) -Message "newer admitted current guard-discard completes after bookkeeping: $($outcome.Completed),$($outcome.GuardDiscarded),$($outcome.BookkeepingWritten),$($outcome.FailurePhase),$($outcome.Detail)"
            Assert-Equal -Actual ($stages -join ',') -Expected '' -Message 'guard discard skips current and every cache stage'
            Assert-Equal -Actual $outcome.Warnings.Count -Expected 1 -Message 'guard discard emits its sole typed warning'
            Assert-OrdinalEqual -Actual $outcome.Warnings[0].code -Expected 'pipeline-guard-discarded' -Message 'guard discard warning is retained after bookkeeping'
        }
        finally { }
    }
    $bookkeepingPath = Join-Path $root 'state/last-processed.json'
    Assert-OrdinalEqual -Actual ([Text.Encoding]::UTF8.GetString([IO.File]::ReadAllBytes($bookkeepingPath))) -Expected '{"domainId":"domain","saveFile":"older.zip","savedAt":"2026-08-10T11:00:00.0000000Z"}' -Message 'guard discard writes byte-identical bookkeeping from the accepted source identity'
}

function Test-CycleBaselineFallbackWarningsReachSuccessfulOutcome {
    foreach ($baselineOutcome in @('absent', 'content-invalid', 'infrastructure-failure')) {
        $root = New-ScratchCompanionRoot -Prefix 'cycle-baseline-fallback'
        Invoke-InCompanionModule -ArgumentList @($root, $baselineOutcome) -ScriptBlock {
            param($innerRoot, $innerBaselineOutcome)
            $config = [AdapterConfig]::new(); $config.AdapterDirectory = $innerRoot
            $sink = New-CompanionWarningSink -Profile Cycle
            $result = [SaveDigestResult]::new()
            $result.Digest = [Text.Json.JsonDocument]::Parse('{}')
            $result.SourceIdentity = [pscustomobject]@{ domainId = 'domain'; saveFile = 'save.zip'; savedAt = [datetime]::UtcNow }
            $outcome = Invoke-CompanionCycle -CompanionRoot $innerRoot -AdapterDirectory $innerRoot -AdapterConfig $config -SourceSave ([IO.FileInfo]::new((Join-Path $innerRoot 'source.zip'))) -WarningSink $sink -Operations @{
                SaveDigest = { $result }
                ReadCurrent = { [pscustomobject]@{ outcome = 'absent'; document = $null } }
                WriteCurrent = { }
                ReadBaseline = { [pscustomobject]@{ outcome = $innerBaselineOutcome; document = $null } }
                CompareDiff = { [ordered]@{} }
                WriteCache = { }
                WriteBookkeeping = { }
            }
            $expected = @{ absent = 'pipeline-baseline-absent'; 'content-invalid' = 'pipeline-baseline-content-invalid'; 'infrastructure-failure' = 'pipeline-baseline-unreadable' }[$innerBaselineOutcome]
            Assert-True -Condition ($outcome.Completed -and $outcome.CacheWritten -and $outcome.BookkeepingWritten) -Message 'baseline fallback retains successful derived completion'
            Assert-Equal -Actual $outcome.Warnings.Count -Expected 1 -Message 'baseline fallback produces one classified warning'
            Assert-OrdinalEqual -Actual $outcome.Warnings[0].code -Expected $expected -Message 'baseline fallback warning preserves its exact class'
        }
    }
}

function Test-CycleCancellationProducesNoOrdinaryOutcome {
    $root = New-ScratchCompanionRoot -Prefix 'cycle-cancellation-seam'
    Invoke-InCompanionModule -ArgumentList @($root) -ScriptBlock {
        param($innerRoot)
        $config = [AdapterConfig]::new(); $config.AdapterDirectory = $innerRoot
        $sink = New-CompanionWarningSink -Profile Cycle
        $source = [Threading.CancellationTokenSource]::new(); $source.Cancel()
        try {
            Invoke-CompanionCycle -CompanionRoot $innerRoot -AdapterDirectory $innerRoot -AdapterConfig $config -SourceSave ([IO.FileInfo]::new((Join-Path $innerRoot 'source.zip'))) -WarningSink $sink -CancellationToken $source.Token
            throw [InvalidOperationException]::new('Cancellation produced an ordinary result.')
        }
        catch [WatcherCancellationException] {
            Assert-Equal -Actual $_.Exception.Warnings.Count -Expected 0 -Message 'cancellation carries only frozen warnings'
        }
        finally {
            $source.Dispose()
        }
    }
}

function Test-CycleCheckpointCancellationDisposesResultBeforeSignal {
    $root = New-ScratchCompanionRoot -Prefix 'cycle-checkpoint-cancellation'
    Invoke-InCompanionModule -ArgumentList @($root) -ScriptBlock {
        param($innerRoot)
        $config = [AdapterConfig]::new(); $config.AdapterDirectory = $innerRoot
        $sink = New-CompanionWarningSink -Profile Cycle
        $operations = @{
            SaveDigest = { [SaveDigestResult]::new() }
            Checkpoint = { param($name) if ($name -ceq 'before-commit-guard') { throw [OperationCanceledException]::new('injected') } }
        }
        Assert-ThrowsType -TypeName 'WatcherCancellationException' -Action {
            Invoke-CompanionCycle -CompanionRoot $innerRoot -AdapterDirectory $innerRoot -AdapterConfig $config -SourceSave ([IO.FileInfo]::new((Join-Path $innerRoot 'source.zip'))) -WarningSink $sink -Operations $operations
        }
    }
}

function Test-CancellationAfterAtomicCurrentWritePreservesCurrentAndSkipsDerivedStages {
    $root = New-ScratchCompanionRoot -Prefix 'cycle-atomic-cancellation'
    $digest = [Text.Json.JsonDocument]::Parse('{}')
    $cancellation = [Threading.CancellationTokenSource]::new()
    try {
        Invoke-InCompanionModule -ArgumentList @($root, $digest, $cancellation) -ScriptBlock {
            param($innerRoot, $innerDigest, $innerCancellation)
            Initialize-CompanionStateDirectories -CompanionRoot $innerRoot
            $config = [AdapterConfig]::new(); $config.AdapterDirectory = $innerRoot
            $sink = New-CompanionWarningSink -Profile Cycle
            $cacheStarted = $false
            Assert-ThrowsType -TypeName 'WatcherCancellationException' -Action {
                Invoke-CompanionCycle -CompanionRoot $innerRoot -AdapterDirectory $innerRoot -AdapterConfig $config -SourceSave ([IO.FileInfo]::new((Join-Path $innerRoot 'source.zip'))) -WarningSink $sink -CancellationToken $innerCancellation.Token -Operations @{
                    SaveDigest = {
                        $saveDigestResult = [SaveDigestResult]::new()
                        $saveDigestResult.Digest = $innerDigest
                        $saveDigestResult.SourceIdentity = [pscustomobject]@{ domainId = 'domain'; saveFile = 'save.zip'; savedAt = [datetime]::UtcNow }

                        return $saveDigestResult
                    }
                    ReadCurrent = { [pscustomobject]@{ outcome = 'absent'; document = $null } }
                    WriteCurrent = {
                        Write-CompanionCurrent -CompanionRoot $innerRoot -Document ([ordered]@{})
                        $innerCancellation.Cancel()
                    }
                    ReadBaseline = { $cacheStarted = $true; [pscustomobject]@{ outcome = 'absent'; document = $null } }
                    CompareDiff = { $cacheStarted = $true; [ordered]@{} }
                    WriteCache = { $cacheStarted = $true }
                    WriteBookkeeping = { $cacheStarted = $true }
                }
            }
            Assert-False -Condition $cacheStarted -Message 'post-commit cancellation skips every unstarted derived stage'
        }
        $currentPath = Join-Path $root 'state/current.json'
        Assert-True -Condition ([IO.File]::Exists($currentPath)) -Message 'atomic current replacement survives cancellation observed afterward'
        Assert-OrdinalEqual -Actual ([Text.Encoding]::UTF8.GetString([IO.File]::ReadAllBytes($currentPath))) -Expected '{}' -Message 'cancellation preserves the fully published current bytes'
        Assert-False -Condition ([IO.File]::Exists((Join-Path $root 'state/diff-since-last-read.json'))) -Message 'skipped cache has no published replacement'
    }
    finally {
        $digest.Dispose()
        $cancellation.Dispose()
    }
}

function Test-EveryCycleCheckpointPropagatesOnlyCancellationSignal {
    foreach ($checkpoint in @('before-save-digest', 'before-commit-guard', 'before-current-commit', 'before-cache', 'before-bookkeeping')) {
        $root = New-ScratchCompanionRoot -Prefix 'cycle-checkpoint-row'
        Invoke-InCompanionModule -ArgumentList @($root, $checkpoint) -ScriptBlock {
            param($innerRoot, $innerCheckpoint)
            $config = [AdapterConfig]::new(); $config.AdapterDirectory = $innerRoot
            $sink = New-CompanionWarningSink -Profile Cycle
            $durableStages = [Collections.Generic.List[string]]::new()
            $operations = @{
                SaveDigest = { [SaveDigestResult]::new() }
                ReadCurrent = { [pscustomobject]@{ outcome = 'absent'; document = $null } }
                WriteCurrent = { $durableStages.Add('current') }
                ReadBaseline = { [pscustomobject]@{ outcome = 'absent'; document = $null } }
                CompareDiff = { [ordered]@{} }
                WriteCache = { $durableStages.Add('cache') }
                WriteBookkeeping = { $durableStages.Add('bookkeeping') }
                Checkpoint = { param($name) if ($name -ceq $innerCheckpoint) { throw [OperationCanceledException]::new('injected') } }
            }
            Assert-ThrowsType -TypeName 'WatcherCancellationException' -Action {
                Invoke-CompanionCycle -CompanionRoot $innerRoot -AdapterDirectory $innerRoot -AdapterConfig $config -SourceSave ([IO.FileInfo]::new((Join-Path $innerRoot 'source.zip'))) -WarningSink $sink -Operations $operations
            }
            $expected = switch ($innerCheckpoint) {
                'before-save-digest' { @() }
                'before-commit-guard' { @() }
                'before-current-commit' { @() }
                'before-cache' { @('current') }
                'before-bookkeeping' { @('current', 'cache') }
            }
            Assert-Equal -Actual ($durableStages -join ',') -Expected ($expected -join ',') -Message 'cancellation preserves only completed durable stages'
        }
    }
}

function New-AdapterFixture {
    param(
        [Parameter(Mandatory)] [string] $Root,
        [Parameter()] [string] $Name = 'example',
        [Parameter()] [string] $ValidatorModule = "function Assert-AdapterDigestSemantics { param([Parameter(Mandatory)] [System.Text.Json.JsonElement] `$RootElement) }`nExport-ModuleMember -Function Assert-AdapterDigestSemantics`n",
        [Parameter()] [switch] $OmitDumpTool,
        [Parameter()] [string] $SaveDirectory = 'C:\saves'
    )

    $escapedSave = $SaveDirectory.Replace('\', '\\')
    $adapterJson = '{"game":"example","adapterVersion":-9223372036854775808,"saveDirectory":"' + $escapedSave + '","saveGlob":"*.zip","maxSourceBytes":1,"dumpCommand":["{artifactRoot}/adapters/' + $Name + '/tool.exe","{save}","{dump}","{digest}","{adapterVersion}","{sourceDomainId}","{saveName}","{savedAt}","{sourceLength}","{sourceSha256}"],"dumpEntrypointIndex":0,"digestCommand":["pwsh","-NoProfile","-File","{artifactRoot}/adapters/' + $Name + '/Build-Digest.ps1","{dump}","{digest}","{adapterVersion}","{sourceDomainId}","{saveName}","{savedAt}","{sourceLength}","{sourceSha256}"],"digestEntrypointIndex":3,"diffExcludePaths":[],"ambientExtraPaths":[]}'
    New-AdapterFixtureTree -Root $Root -Name $Name -AdapterJson $adapterJson -ValidatorModule $ValidatorModule -OmitDumpTool:$OmitDumpTool
}

function Get-ReleaseConfigReason {
    param([Parameter(Mandatory)] [string] $Root, [Parameter()] [string] $Profile = 'StateCompatibility')

    try {
        $config = Get-AdapterConfig -CompanionRoot $Root -Profile $Profile
        $config.Dispose()

        return $null
    }
    catch {
        if ([string]::Equals($_.Exception.GetType().Name, 'AdapterConfigurationException', [StringComparison]::Ordinal)) {
            return $_.Exception.Message
        }

        throw
    }
}

function Test-PackageMemberRemediation {
    $assertCorrupt = {
        param($Message)
        Assert-OrdinalEqual -Actual $Message -Expected 'adapter-release-corrupt' -Message 'the release validator is classified by the typed corrupt-release reason before save enumeration'
    }
    $assertNotCorrupt = {
        param($Message)
        Assert-True -Condition ($null -ne $Message -and $Message -ne 'adapter-release-corrupt') -Message 'the missing declared member stays the ordinary config class, never release corruption'
    }

    # A healthy release resolves its exact single-export validator set.
    $healthy = New-ScratchCompanionRoot -Prefix 'release-corrupt'
    New-AdapterFixture -Root $healthy
    $control = Get-AdapterConfig -CompanionRoot $healthy -Profile StateCompatibility
    try {
        Assert-True -Condition ($null -ne $control.Validator) -Message 'a healthy release resolves an exact validator export set'
    }
    finally {
        $control.Dispose()
    }

    # A validator that cannot be imported (syntax error) is corrupt release.
    $importFail = New-ScratchCompanionRoot -Prefix 'release-corrupt-import'
    New-AdapterFixture -Root $importFail -ValidatorModule 'function Assert-AdapterDigestSemantics { '
    & $assertCorrupt (Get-ReleaseConfigReason -Root $importFail)

    # A validator whose required export is missing is corrupt release.
    $missingExport = New-ScratchCompanionRoot -Prefix 'release-corrupt-export'
    New-AdapterFixture -Root $missingExport -ValidatorModule "function SomethingElse { }`nExport-ModuleMember -Function SomethingElse`n"
    & $assertCorrupt (Get-ReleaseConfigReason -Root $missingExport)

    # A validator with a spurious extra export is corrupt release.
    $extraExport = New-ScratchCompanionRoot -Prefix 'release-corrupt-extra'
    New-AdapterFixture -Root $extraExport -ValidatorModule "function Assert-AdapterDigestSemantics { param([Parameter(Mandatory)] [System.Text.Json.JsonElement] `$RootElement) }`nfunction Extra { }`nExport-ModuleMember -Function Assert-AdapterDigestSemantics, Extra`n"
    & $assertCorrupt (Get-ReleaseConfigReason -Root $extraExport)

    # The mapping is generic: repeat the import failure under a second adapter name with the
    # Acquisition non-module rules satisfied (spec section 8: the save directory must exist
    # before the validator lease is acquired), so the corrupt release is classified rather
    # than masked by an unrelated acquisition rule.
    $second = New-ScratchCompanionRoot -Prefix 'release-corrupt-second'
    $secondSaves = Join-Path $second 'saves'
    [void] [IO.Directory]::CreateDirectory($secondSaves)
    New-AdapterFixture -Root $second -Name 'xeno' -ValidatorModule 'function Assert-AdapterDigestSemantics { ' -SaveDirectory $secondSaves
    & $assertCorrupt (Get-ReleaseConfigReason -Root $second -Profile Acquisition)

    # Removing the release validator module itself is the ordinary config class.
    $removed = New-ScratchCompanionRoot -Prefix 'release-corrupt-removed'
    New-AdapterFixture -Root $removed
    [IO.File]::Delete((Join-Path $removed 'adapters/example/releases/-9223372036854775808/schema-2/adapters/example/Validate-Digest.psm1'))
    & $assertNotCorrupt (Get-ReleaseConfigReason -Root $removed)

    # An artifact-root member named by dumpCommand that is absent is rejected at the
    # config surface before spawn and is not misclassified as release corruption.
    $saveDirRoot = New-ScratchCompanionRoot -Prefix 'release-corrupt-save'
    $saveDir = Join-Path $saveDirRoot 'saves'
    [void] [IO.Directory]::CreateDirectory($saveDir)
    $absent = New-ScratchCompanionRoot -Prefix 'release-corrupt-absent'
    New-AdapterFixture -Root $absent -OmitDumpTool -SaveDirectory $saveDir
    & $assertNotCorrupt (Get-ReleaseConfigReason -Root $absent -Profile Acquisition)
}

$tests = [ordered]@{
    SaveCandidates = ${function:Test-SaveCandidatesUseOrdinalTieBreakAndEmptyArray}; FileWriteStable = ${function:Test-FileWriteStableReturnsAfterMatchingSamples}; FileWriteStableUnstable = ${function:Test-FileWriteStableRejectsMismatchingSamples}; FileWriteStableCancellation = ${function:Test-FileWriteStableCancellationReturnsFalse}; MissingSource = ${function:Test-SaveDigestClassifiesMissingSourceAsVanished}; CopyFidelitySizeLimit = ${function:Test-SaveDigestClassifiesSizeLimitAsUnreadableCopyFailure}; CopyFidelityReasons = ${function:Test-CycleMapsCopyFailureReasonsToDispositionAndRetryable}; AdapterFailureReason = ${function:Test-AdapterCommandFailureReasonClassifiesExitAndMissingOutput}; OutcomeClosure = ${function:Test-CycleOutcomeRejectsIllegalCombinations}; OutcomeFreeze = ${function:Test-CycleOutcomeFreezesWarningsAfterResultDisposal}; StagedOneShot = ${function:Test-StagedOneShotKeepsPreCycleOrdering}; ScratchDefault = ${function:Test-StagedOneShotUsesScratchDefaultRootAndReleasesEntryLeaseAfterConfigFailure}; CopyFailure = ${function:Test-CycleMapsInjectedCopyFailureToRetryableSourceOutcome}; AdapterFailures = ${function:Test-CycleMapsInjectedAdapterStageFailures}; CurrentReadFailure = ${function:Test-CycleMapsInjectedCurrentReadFailureToCommitOutcome}; CurrentWriteFailure = ${function:Test-CycleMapsInjectedCurrentWriteFailureToCommitOutcome}; CacheWriteFailure = ${function:Test-CycleMapsInjectedCacheWriteFailureAfterCommit}; BookkeepingFailure = ${function:Test-CycleMapsInjectedBookkeepingFailureAfterCommit}; GuardDiscard = ${function:Test-GuardDiscardSkipsCacheAndStillWritesBookkeeping}; BaselineFallback = ${function:Test-CycleBaselineFallbackWarningsReachSuccessfulOutcome}; Cancellation = ${function:Test-CycleCancellationProducesNoOrdinaryOutcome}; CheckpointCancellation = ${function:Test-CycleCheckpointCancellationDisposesResultBeforeSignal}; CurrentWriteCancellation = ${function:Test-CancellationAfterAtomicCurrentWritePreservesCurrentAndSkipsDerivedStages}; CheckpointPropagation = ${function:Test-EveryCycleCheckpointPropagatesOnlyCancellationSignal}; SaveCandidatesEnumerationFailure = ${function:Test-SaveCandidatesEnumerationFailure}; PackageMemberRemediation = ${function:Test-PackageMemberRemediation}
}

if ($Only -eq 'All') {
    foreach ($test in $tests.Values) { & $test }
}
else { & $tests[$Only] }

Write-Output 'PASS: Acquisition'
