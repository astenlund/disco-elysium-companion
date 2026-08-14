function Get-ConsumptionSourceIdentity {
    param([Parameter(Mandatory)] [CompanionJsonValue] $Document)

    return ConvertFrom-SourceIdentity -Value $Document.Materialized['source']
}

function Test-ConsumptionMeetsSourceFloor {
    param([Parameter(Mandatory)] [CompanionJsonValue] $Document, [Parameter(Mandatory)] $Floor)

    $comparison = Compare-SourceIdentity -Left (Get-ConsumptionSourceIdentity -Document $Document) -Right $Floor

    return $comparison.comparable -and $comparison.order -ge 0
}

function Complete-ConsumePayload {
    param([Parameter(Mandatory)] [AllowNull()] $Payload, [Parameter(Mandatory)] [bool] $CacheDegraded, [Parameter(Mandatory)] [CompanionWarningSink] $WarningSink)

    if ($Payload -is [TurnContextPayloadCandidate]) { $Payload.Complete($CacheDegraded, $WarningSink.Freeze()) }
}

function New-ConsumePayload {
    [CmdletBinding(DefaultParameterSetName = 'Raw')]
    param(
        [Parameter(Mandatory)] [ValidateSet('rawStdout', 'privateResult')] [string] $DeliveryMode,
        [Parameter(Mandatory)] [CompanionJsonValue] $Diff,
        [Parameter(Mandatory, ParameterSetName = 'Private')] [CompanionJsonValue] $State,
        [Parameter(Mandatory, ParameterSetName = 'Private')] [TurnContextPayloadContext] $Context
    )

    if ($DeliveryMode -ceq 'rawStdout') {
        if ($PSCmdlet.ParameterSetName -cne 'Raw') { throw [CompanionDiffSemanticException]::new('Raw payload cannot contain state or context.') }

        return $Diff
    }
    if ($PSCmdlet.ParameterSetName -cne 'Private') { throw [CompanionDiffSemanticException]::new('Private payload requires state and context.') }

    if (-not (Test-ConsumptionMeetsSourceFloor -Document $State -Floor $Context.SourceFloor)) { throw [CompanionDiffSemanticException]::new('Private payload state does not meet its source floor.') }
    if ($Diff.RootElement.GetProperty('adapterVersion').GetInt64() -ne $State.RootElement.GetProperty('adapterVersion').GetInt64() -or -not [string]::Equals($Diff.RootElement.GetProperty('game').GetString(), $State.RootElement.GetProperty('game').GetString(), [StringComparison]::Ordinal)) { throw [CompanionDiffSemanticException]::new('Private payload documents are incompatible.') }

    return [TurnContextPayloadCandidate]::new($Diff, $State, $Context)
}

function New-ConsumptionResult {
    param([Parameter(Mandatory)] [string] $OutcomeClass, [Parameter(Mandatory)] [string] $ConsumptionState, [AllowNull()] $Payload, [bool] $CacheDegraded, [AllowNull()] [string] $Detail)

    return [ConsumeResult]::new($OutcomeClass, $ConsumptionState, $Payload, $CacheDegraded, $Detail)
}

function Invoke-CompanionConsumption {
    param(
        [Parameter(Mandatory)] [AdapterCompatibilityConfig] $AdapterConfig,
        [Parameter(Mandatory)] [string] $CompanionRoot,
        [Parameter(Mandatory)] [ValidateSet('rawStdout', 'privateResult')] [string] $DeliveryMode,
        [AllowNull()] [object] $SourceFloor,
        [AllowNull()] [TurnContextPayloadContext] $Context,
        [Parameter(Mandatory)] [CompanionWarningSink] $WarningSink,
        [Parameter()] [scriptblock] $WriteStdout = { param([string] $Text) [Console]::Out.Write($Text) },
        [Parameter()] [scriptblock] $SerializePayload = { param($Payload) ConvertTo-CompanionJson -InputObject $Payload -Budget diff },
        [Parameter()] [scriptblock] $EnterConsumeLock = { param([string] $Root) Enter-CompanionConsumeLock -CompanionRoot $Root },
        [Parameter()] [scriptblock] $ReadCurrent = { param([string] $Root, [AdapterCompatibilityConfig] $Config) Read-CompanionCurrent -CompanionRoot $Root -AdapterConfig $Config },
        [Parameter()] [scriptblock] $ReadBaseline = { param([string] $Root) Read-CompanionBaseline -CompanionRoot $Root },
        [Parameter()] [scriptblock] $WriteBaseline = { param([string] $Root, [CompanionJsonValue] $Document) Write-CompanionBaseline -CompanionRoot $Root -Document $Document },
        [Parameter()] [scriptblock] $WriteCache = { param([string] $Root, [CompanionJsonValue] $Document) Write-CompanionDiffCache -CompanionRoot $Root -Document $Document }
    )

    try {
        $lease = & $EnterConsumeLock $CompanionRoot
    }
    catch [TimeoutException] {
        return New-ConsumptionResult -OutcomeClass 'busy' -ConsumptionState 'none' -Payload $null -CacheDegraded $false -Detail 'consume-lock-busy'
    }
    catch {
        return New-ConsumptionResult -OutcomeClass 'lock' -ConsumptionState 'none' -Payload $null -CacheDegraded $false -Detail 'consume-lock-failed'
    }

    try {
        $current = & $ReadCurrent $CompanionRoot $AdapterConfig
        if ($current.outcome -ne 'valid') {
            $detail = if ($current.outcome -eq 'stale') { 'current-stale' } else { 'current-missing-or-invalid' }
            return New-ConsumptionResult -OutcomeClass 'freshness' -ConsumptionState 'none' -Payload $null -CacheDegraded $false -Detail $detail
        }
        $target = $current.document
        if ($null -ne $SourceFloor -and -not (Test-ConsumptionMeetsSourceFloor -Document $target -Floor $SourceFloor)) {
            return New-ConsumptionResult -OutcomeClass 'freshness' -ConsumptionState 'none' -Payload $null -CacheDegraded $false -Detail 'source-floor-not-met'
        }

        $baselineRead = & $ReadBaseline $CompanionRoot
        if ($baselineRead.outcome -eq 'infrastructure-failure') { return New-ConsumptionResult -OutcomeClass 'compute' -ConsumptionState 'none' -Payload $null -CacheDegraded $false -Detail 'baseline-read-failed' }
        $baseline = $baselineRead.document
        if ($baselineRead.outcome -eq 'valid') {
            try {
                Assert-AdapterDigestDocument -Document $baseline -AdapterConfig $AdapterConfig
            }
            catch [CompanionContentException] {
                $baselineRead = [pscustomobject]@{ outcome = 'content-invalid'; document = $null }
                $baseline = $null
            }
        }
        $baselineReset = $baselineRead.outcome -ne 'valid'
        if ($baselineReset) {
            if ($DeliveryMode -ceq 'rawStdout') {
                if ($baselineRead.outcome -eq 'absent') { Add-CompanionWarning -Sink $WarningSink -Code 'pipeline-baseline-absent' -Detail $null } else { Add-CompanionWarning -Sink $WarningSink -Code 'pipeline-baseline-content-invalid' -Detail $null }
            }
        }
        else {
            $relation = Compare-SourceIdentity -Left (Get-ConsumptionSourceIdentity -Document $target) -Right (Get-ConsumptionSourceIdentity -Document $baseline)
            if ($relation.comparable -and $relation.order -lt 0) { return New-ConsumptionResult -OutcomeClass 'stale-target' -ConsumptionState 'none' -Payload $null -CacheDegraded $false -Detail 'target-precedes-baseline' }
        }

        try {
            $diff = Compare-Digests -Baseline $baseline -Target $target -AdapterConfig $AdapterConfig -WarningSink $WarningSink
            Assert-DiffSemantics -Diff $diff -Baseline $baseline -Target $target -AdapterConfig $AdapterConfig
            $payload = if ($DeliveryMode -ceq 'rawStdout') { New-ConsumePayload -DeliveryMode rawStdout -Diff $diff } else { New-ConsumePayload -DeliveryMode privateResult -Diff $diff -State $target -Context $Context }
        }
        catch {
            return New-ConsumptionResult -OutcomeClass 'compute' -ConsumptionState 'none' -Payload $null -CacheDegraded $false -Detail 'payload-or-diff-failed'
        }
        if ($DeliveryMode -ceq 'rawStdout') {
            try {
                $serializedPayload = & $SerializePayload $payload.RootElement
            }
            catch {
                return New-ConsumptionResult -OutcomeClass 'emit' -ConsumptionState 'none' -Payload $null -CacheDegraded $false -Detail 'payload-serialize-failed'
            }
            try {
                & $WriteStdout $serializedPayload
            }
            catch {
                return New-ConsumptionResult -OutcomeClass 'emit' -ConsumptionState 'none' -Payload $null -CacheDegraded $false -Detail 'stdout-write-failed'
            }
        }

        try {
            & $WriteBaseline $CompanionRoot $target
        }
        catch {
            # Untyped failures can only come from an injected seam (the production
            # writer always throws typed stages); temp-write is the least-asserting
            # stage claim for them.
            $stage = if ($_.Exception -is [CompanionStateWriteException]) { $_.Exception.Stage } else { 'temp-write' }
            $detail = switch ($stage) { 'serialize' { 'baseline-serialize-failed' } 'replace' { 'baseline-replace-failed' } default { 'baseline-temp-write-failed' } }
            Complete-ConsumePayload -Payload $payload -CacheDegraded $false -WarningSink $WarningSink

            return New-ConsumptionResult -OutcomeClass 'reset-write:not-consumed' -ConsumptionState 'notConsumed' -Payload $payload -CacheDegraded $false -Detail $detail
        }

        try {
            $fresh = & $ReadCurrent $CompanionRoot $AdapterConfig
        }
        catch {
            $fresh = $null
        }
        if ($null -eq $fresh -or $fresh.outcome -notin @('valid', 'absent', 'content-invalid', 'stale')) {
            # Fresh-validation machinery failure after baseline advancement: exactly
            # cache-target-invalid, never a pre-baseline compute class (7.3 step 4).
            Complete-ConsumePayload -Payload $payload -CacheDegraded $true -WarningSink $WarningSink

            return New-ConsumptionResult -OutcomeClass 'reset-write:consumed' -ConsumptionState 'consumed' -Payload $payload -CacheDegraded $true -Detail 'cache-target-invalid'
        }
        try {
            if ($fresh.outcome -ceq 'valid') {
                $cache = Compare-Digests -Baseline $target -Target $fresh.document -AdapterConfig $AdapterConfig -WarningSink $WarningSink
            }
            else {
                Add-CompanionWarning -Sink $WarningSink -Code 'consume-cache-fallback' -Detail $null
                $cache = New-EmptyDiff -Target $target
            }
        }
        catch {
            Complete-ConsumePayload -Payload $payload -CacheDegraded $true -WarningSink $WarningSink

            return New-ConsumptionResult -OutcomeClass 'reset-write:consumed' -ConsumptionState 'consumed' -Payload $payload -CacheDegraded $true -Detail 'cache-compare-failed'
        }
        try {
            & $WriteCache $CompanionRoot $cache
        }
        catch {
            $stage = if ($_.Exception -is [CompanionStateWriteException]) { $_.Exception.Stage } else { 'temp-write' }
            $detail = switch ($stage) { 'serialize' { 'cache-serialize-failed' } 'replace' { 'cache-replace-failed' } default { 'cache-temp-write-failed' } }
            Complete-ConsumePayload -Payload $payload -CacheDegraded $true -WarningSink $WarningSink

            return New-ConsumptionResult -OutcomeClass 'reset-write:consumed' -ConsumptionState 'consumed' -Payload $payload -CacheDegraded $true -Detail $detail
        }

        Complete-ConsumePayload -Payload $payload -CacheDegraded $false -WarningSink $WarningSink

        return New-ConsumptionResult -OutcomeClass 'success' -ConsumptionState 'consumed' -Payload $payload -CacheDegraded $false -Detail $null
    }
    finally {
        $lease.Dispose()
    }
}
