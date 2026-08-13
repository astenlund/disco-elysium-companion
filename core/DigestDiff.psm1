#Requires -Version 7.5

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# The turn-context acquisition pass budget (one initial pass plus at most two
# reacquisitions). Single source of truth for the producer loop, the envelope
# refresher validator, and the TurnContextPayloadContext constructor, so changing
# the cap requires exactly one edit rather than four lockstep literals.
$script:TurnContextRefreshAttemptCap = 3

# The terminal-detail Unicode-scalar cap shared by New-TurnContextDetail and the
# ConsumeResult constructor (single source of truth for the 512 limit).
$script:TurnContextDetailScalarCap = 512

class CompanionContentException : System.Exception {
    CompanionContentException([string] $Message) : base($Message) {}
    CompanionContentException([string] $Message, [System.Exception] $InnerException) : base($Message, $InnerException) {}
}

class CompanionJsonParseException : CompanionContentException {
    CompanionJsonParseException([string] $Message) : base($Message) {}
    CompanionJsonParseException([string] $Message, [System.Exception] $InnerException) : base($Message, $InnerException) {}
}

class CompanionDocumentValidationException : CompanionContentException {
    CompanionDocumentValidationException([string] $Message) : base($Message) {}
}

class AdapterDigestValidationException : CompanionContentException {
    AdapterDigestValidationException([string] $Message) : base($Message) {}
}

class AdapterConfigurationException : CompanionContentException {
    AdapterConfigurationException([string] $Message) : base($Message) {}
    AdapterConfigurationException([string] $Message, [System.Exception] $InnerException) : base($Message, $InnerException) {}
}

class AdapterValidatorLease : System.IDisposable {
    hidden [string] $CacheKey
    hidden [bool] $Disposed

    AdapterValidatorLease([string] $CacheKey) { $this.CacheKey = $CacheKey }

    [void] Dispose() {
        if (-not $this.Disposed) {
            $this.Disposed = $true
            Release-AdapterValidatorLease -CacheKey $this.CacheKey
        }
    }
}

class AdapterCompatibilityConfig : System.IDisposable {
    [string] $AdapterName
    [string] $AdapterDirectory
    [string] $Game
    [long] $AdapterVersion
    [string] $SaveDirectory
    [string] $SaveGlob
    [string[]] $DiffExcludePaths
    [string] $SourceDomainId
    [string] $ConfigReceipt
    [string] $ArtifactRoot
    [string] $ValidatorPath
    hidden [AdapterValidatorLease] $Lease
    hidden [object] $Validator
    hidden [bool] $Disposed

    [void] Dispose() {
        if (-not $this.Disposed) {
            $this.Disposed = $true
            if ($null -ne $this.Lease) { $this.Lease.Dispose() }
            $this.Validator = $null
        }
    }
}

class AdapterConfig : AdapterCompatibilityConfig {
    [long] $MaxSourceBytes
    [string[]] $DumpCommand
    [int] $DumpEntrypointIndex
    [string[]] $DigestCommand
    [int] $DigestEntrypointIndex
    [string[]] $AmbientExtraPaths
    [string] $WalkPolicyId
}

class CompanionDiffCompatibilityException : CompanionContentException {
    CompanionDiffCompatibilityException([string] $Message) : base($Message) {}
}

class CompanionDiffSemanticException : CompanionContentException {
    CompanionDiffSemanticException([string] $Message) : base($Message) {}
}

class TurnContextProtocolException : CompanionContentException {
    TurnContextProtocolException([string] $Message) : base($Message) {}
}

class SaveSourceException : CompanionContentException {
    [string] $SourceDisposition

    SaveSourceException([string] $Disposition, [string] $Message, [System.Exception] $InnerException) : base($Message, $InnerException) { $this.SourceDisposition = $Disposition }
}

class SaveCandidateLimitException : CompanionContentException {
    SaveCandidateLimitException([string] $Message) : base($Message) {}
}

class SaveDigestStageException : CompanionContentException {
    [string] $Stage
    [string] $SourceDisposition
    [string] $Reason
    [object] $Atoms

    SaveDigestStageException([string] $Stage, [string] $Disposition, [string] $Reason, [object] $Atoms, [System.Exception] $InnerException) : base('save-digest-stage-failed', $InnerException) {
        $legalReasons = switch ($Stage) {
            'copy' { @('work-setup-failed', 'source-size-limit-exceeded', 'source-vanished', 'source-changed', 'source-unreadable') }
            'dump' { @('command-start-failed', 'adapter-release-corrupt', 'command-timeout', 'command-transport-failed', 'command-exit-nonzero', 'promised-output-missing') }
            'digest' { @('command-start-failed', 'adapter-release-corrupt', 'command-timeout', 'command-transport-failed', 'command-exit-nonzero', 'promised-output-missing', 'document-invalid', 'adapter-validator-infrastructure-failed', 'schema-version-mismatch', 'adapter-version-mismatch', 'game-mismatch', 'source-domain-mismatch', 'source-receipt-mismatch') }
            default { throw [ArgumentException]::new('Invalid save digest stage.') }
        }
        if ($Disposition -notin @('stable', 'vanished', 'changed', 'unreadable')) { throw [ArgumentException]::new('Invalid save digest source disposition.') }
        if ($Stage -in @('dump', 'digest') -and $Disposition -cne 'stable') { throw [ArgumentException]::new('Invalid save digest stage disposition.') }
        if ($Reason -notin $legalReasons) { throw [ArgumentException]::new('Invalid save digest stage reason.') }
        if ($null -eq $Atoms) { throw [ArgumentNullException]::new('Atoms') }

        $this.Stage = $Stage
        $this.SourceDisposition = $Disposition
        $this.Reason = $Reason
        $this.Atoms = $Atoms
    }
}

class AdapterCommandResult {
    [int] $ExitCode
    [string] $StandardOutput
    [string] $StandardError
    [bool] $Succeeded
    [bool] $TimedOut
    [bool] $Cancelled
    [bool] $Started
    [System.Exception] $TransportException
}

class SaveDigestResult : System.IDisposable {
    [string] $DigestPath
    [object] $Digest
    [object] $SourceIdentity
    [object] $SourceReceipt
    hidden [string[]] $OwnedPaths
    hidden [IO.FileStream] $Lease
    hidden [object] $WarningSink
    hidden [bool] $Disposed

    [void] Dispose() {
        if ($this.Disposed) { return }
        $this.Disposed = $true
        if ($null -ne $this.Lease) { $this.Lease.Dispose() }
        foreach ($path in $this.OwnedPaths) {
            try { if ([IO.File]::Exists($path)) { [IO.File]::Delete($path) } } catch { Add-CompanionWarning -Sink $this.WarningSink -Code 'pipeline-cleanup-degraded' -Detail $null }
        }
        $this.DigestPath = $null
    }
}

class CycleOutcome {
    [bool] $Completed
    [bool] $CurrentCommitted
    [bool] $GuardDiscarded
    [bool] $CacheWritten
    [bool] $BookkeepingWritten
    [AllowNull()] [object] $FailurePhase
    [string] $SourceDisposition
    [bool] $Retryable
    [AllowNull()] [object] $Detail
    [object] $Warnings

    CycleOutcome([bool] $Completed, [bool] $CurrentCommitted, [bool] $GuardDiscarded, [bool] $CacheWritten, [bool] $BookkeepingWritten, [object] $FailurePhase, [string] $SourceDisposition, [bool] $Retryable, [object] $Detail, [object] $Warnings) {
        $this.Completed = $Completed
        $this.CurrentCommitted = $CurrentCommitted
        $this.GuardDiscarded = $GuardDiscarded
        $this.CacheWritten = $CacheWritten
        $this.BookkeepingWritten = $BookkeepingWritten
        $this.FailurePhase = $FailurePhase
        $this.SourceDisposition = $SourceDisposition
        $this.Retryable = $Retryable
        $this.Detail = $Detail
        $this.Warnings = $Warnings
        Assert-CycleOutcome -Outcome $this
    }
}

class WatcherCancellationException : System.OperationCanceledException {
    [object] $Warnings

    WatcherCancellationException([object] $Warnings) : base('watcher-cancelled') {
        $this.Warnings = $Warnings
    }
}

class CompanionJsonValue {
    [object] $Materialized
    [System.Text.Json.JsonElement] $RootElement

    # No owned disposable resources: RootElement is a cloned value, not a live
    # JsonDocument. Dispose is a no-op so callers that treat this value like the
    # v1 JsonDocument-owned analogue (e.g. the cycle's finally-scoped document
    # disposal) can dispose a present document without a missing-member failure.
    [void] Dispose() { }
}

class TurnContextPayloadContext {
    [object] $SourceFloor
    [bool] $RefreshAttempted
    [bool] $RefreshCommitObserved
    [int] $RefreshAttempts

    TurnContextPayloadContext([object] $SourceFloor, [bool] $RefreshAttempted, [bool] $RefreshCommitObserved, [int] $RefreshAttempts) {
        if ($null -eq $SourceFloor -or $RefreshAttempts -lt 0 -or $RefreshAttempts -gt $script:TurnContextRefreshAttemptCap -or $RefreshAttempted -ne ($RefreshAttempts -gt 0) -or ($RefreshCommitObserved -and -not $RefreshAttempted)) {
            throw [ArgumentException]::new('Invalid turn-context payload context.')
        }

        $this.SourceFloor = $SourceFloor
        $this.RefreshAttempted = $RefreshAttempted
        $this.RefreshCommitObserved = $RefreshCommitObserved
        $this.RefreshAttempts = $RefreshAttempts
    }
}

class TurnContextPayloadCandidate {
    [CompanionJsonValue] $Diff
    [CompanionJsonValue] $State
    [TurnContextPayloadContext] $Context
    [bool] $CacheDegraded
    [object] $Warnings
    hidden [bool] $Serialized
    hidden [bool] $Invalidated

    TurnContextPayloadCandidate([CompanionJsonValue] $Diff, [CompanionJsonValue] $State, [TurnContextPayloadContext] $Context) {
        $this.Diff = $Diff
        $this.State = $State
        $this.Context = $Context
        $this.CacheDegraded = $false
        $this.Warnings = @()
    }

    [void] Complete([bool] $CacheDegraded, [object] $Warnings) {
        $this.AssertMutable()
        if ($null -eq $Warnings) { throw [ArgumentNullException]::new('Warnings') }

        $this.CacheDegraded = $CacheDegraded
        $this.Warnings = $Warnings
    }

    [void] MarkSerialized() { $this.AssertMutable(); $this.Serialized = $true }
    [void] Invalidate() { $this.Invalidated = $true; $this.Diff = $null; $this.State = $null; $this.Context = $null; $this.Warnings = $null }
    hidden [void] AssertUsable() { if ($this.Invalidated) { throw [InvalidOperationException]::new('Turn-context payload candidate is invalid.') } }
    hidden [void] AssertMutable() { $this.AssertUsable(); if ($this.Serialized) { throw [InvalidOperationException]::new('Turn-context payload candidate was serialized.') } }
}

class ConsumeResult {
    [string] $outcomeClass
    [string] $consumptionState
    [object] $payload
    [bool] $cacheDegraded
    [AllowNull()] [string] $detail

    ConsumeResult([string] $OutcomeClass, [string] $ConsumptionState, [object] $Payload, [bool] $CacheDegraded, [string] $Detail) {
        $success = $OutcomeClass -ceq 'success' -and $ConsumptionState -ceq 'consumed' -and $null -ne $Payload -and -not $CacheDegraded -and [string]::IsNullOrEmpty($Detail)
        $notConsumed = $OutcomeClass -ceq 'reset-write:not-consumed' -and $ConsumptionState -ceq 'notConsumed' -and $null -ne $Payload -and -not $CacheDegraded -and -not [string]::IsNullOrEmpty($Detail)
        $consumed = $OutcomeClass -ceq 'reset-write:consumed' -and $ConsumptionState -ceq 'consumed' -and $null -ne $Payload -and $CacheDegraded -and -not [string]::IsNullOrEmpty($Detail)
        $none = $OutcomeClass -in @('busy', 'lock', 'freshness', 'stale-target', 'compute') -and $ConsumptionState -ceq 'none' -and $null -eq $Payload -and -not $CacheDegraded -and -not [string]::IsNullOrEmpty($Detail)
        $emit = $OutcomeClass -ceq 'emit' -and $ConsumptionState -ceq 'none' -and $null -eq $Payload -and -not $CacheDegraded -and -not [string]::IsNullOrEmpty($Detail)
        if (-not ($success -or $notConsumed -or $consumed -or $none -or $emit) -or ($null -ne $Detail -and @($Detail.EnumerateRunes()).Count -gt $script:TurnContextDetailScalarCap)) { throw [ArgumentException]::new('Invalid consumption result.') }

        $this.outcomeClass = $OutcomeClass
        $this.consumptionState = $ConsumptionState
        $this.payload = $Payload
        $this.cacheDegraded = $CacheDegraded
        $this.detail = if ([string]::IsNullOrEmpty($Detail)) { $null } else { $Detail }
    }
}

class WalkPairReceipt {
    [int] $BaselineIndex
    [int] $TargetIndex
    [object] $BaselineSource
    [object] $TargetSource
    [bool] $Eventful

    WalkPairReceipt([int] $BaselineIndex, [int] $TargetIndex, [object] $BaselineSource, [object] $TargetSource, [bool] $Eventful) {
        if ($BaselineIndex -lt 0 -or $TargetIndex -lt 0 -or $TargetIndex -ne ($BaselineIndex - 1) -or $null -eq $BaselineSource -or $null -eq $TargetSource) {
            throw [ArgumentException]::new('Invalid walk pair receipt.')
        }

        $this.BaselineIndex = $BaselineIndex
        $this.TargetIndex = $TargetIndex
        $this.BaselineSource = $BaselineSource
        $this.TargetSource = $TargetSource
        $this.Eventful = $Eventful
    }
}

class WalkTraversalEvidence {
    [object[]] $Candidates
    [int] $EffectiveMaxSaves
    [int] $EffectiveMaxAgeHours
    [WalkPairReceipt[]] $Receipts

    WalkTraversalEvidence([object[]] $Candidates, [int] $EffectiveMaxSaves, [int] $EffectiveMaxAgeHours, [WalkPairReceipt[]] $Receipts) {
        if ($null -eq $Candidates -or $null -eq $Receipts -or $EffectiveMaxSaves -lt 2 -or $EffectiveMaxAgeHours -lt 1) {
            throw [ArgumentException]::new('Invalid walk traversal evidence.')
        }

        $this.Candidates = $Candidates
        $this.EffectiveMaxSaves = $EffectiveMaxSaves
        $this.EffectiveMaxAgeHours = $EffectiveMaxAgeHours
        $this.Receipts = $Receipts
    }
}

function New-WalkTraversalEvidence {
    param(
        [Parameter(Mandatory)] [object[]] $Candidates,
        [Parameter(Mandatory)] [int] $EffectiveMaxSaves,
        [Parameter(Mandatory)] [int] $EffectiveMaxAgeHours,
        [Parameter(Mandatory)] [object[]] $Receipts
    )

    $receiptArray = [WalkPairReceipt[]] @($Receipts)
    return [WalkTraversalEvidence]::new($Candidates, $EffectiveMaxSaves, $EffectiveMaxAgeHours, $receiptArray)
}

function Get-CoreSchemaVersion {
    return 2
}

. (Join-Path $PSScriptRoot 'private/CompanionJson.ps1')
. (Join-Path $PSScriptRoot 'private/SourceIdentity.ps1')
. (Join-Path $PSScriptRoot 'private/DocumentValidation.ps1')
. (Join-Path $PSScriptRoot 'private/AdapterConfig.ps1')
. (Join-Path $PSScriptRoot 'private/DiffEngine.ps1')
. (Join-Path $PSScriptRoot 'private/ProcessRunner.ps1')
. (Join-Path $PSScriptRoot 'private/Acquisition.ps1')
. (Join-Path $PSScriptRoot 'private/StateFiles.ps1')
. (Join-Path $PSScriptRoot 'private/Consumption.ps1')
. (Join-Path $PSScriptRoot 'private/TurnContext.ps1')
. (Join-Path $PSScriptRoot 'private/Watcher.ps1')
. (Join-Path $PSScriptRoot 'private/WalkProtocol.ps1')

Export-ModuleMember -Function Get-CoreSchemaVersion, Read-CompanionJson, ConvertTo-CompanionJson, Compare-SourceIdentity, New-SourceIdentity, ConvertFrom-SourceIdentity, New-CompanionWarningSink, Add-CompanionWarning, Read-DigestDocument, Read-DiffDocument, Get-AdapterConfig, Acquire-AdapterValidatorLease, Assert-AdapterDigestDocument, Read-AdapterDigestDocument, Compare-Digests, New-EmptyDiff, Test-UneventfulDiff, Assert-DiffSemantics, Invoke-AdapterCommand, Get-SaveCandidates, Get-NewestSave, Test-FileWriteStable, Invoke-SaveDigest, Invoke-CompanionCycle, Initialize-CompanionStateDirectories, Write-CompanionStateBytes, Write-CompanionStateJson, Enter-CompanionCycleLock, Enter-CompanionConsumeLock, Read-CompanionBaseline, Read-CompanionCurrent, Write-CompanionCurrent, Write-CompanionBaseline, Write-CompanionDiffCache, Write-CompanionBookkeeping, Invoke-WorkFileReaper, New-ConsumePayload, Invoke-CompanionConsumption, New-TurnContextDetail, New-TurnContextDiagnosticObject, Read-TurnContextDiagnostic, Read-TurnContextEnvelope, Assert-TurnContextAttemptResult, Invoke-TurnContextAttempt, Invoke-CompanionWatcher, Test-WalkOverAge, ConvertTo-WalkIdentity, New-WalkPairReceipt, New-WalkTraversalEvidence, Assert-WalkResultSemantics, Read-WalkResultDocument, Read-WalkWarningArray
