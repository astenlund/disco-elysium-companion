$script:TurnContextReasons = @{
    config = @('adapter-resolution-failed', 'adapter-config-invalid', 'adapter-release-corrupt', 'adapter-config-confirmation-failed', 'adapter-config-changed', 'companion-root-invalid')
    busy = @('lock-timeout')
    lock = @('lock-open-failed')
    'stale-target' = @('target-precedes-baseline')
    'no-saves' = @('no-matching-saves')
    stability = @('stability-exhausted')
    source = @('state-setup-failed', 'save-enumeration-failed', 'candidate-limit-exceeded', 'candidate-metadata-failed') + $script:SaveDigestCopyReasons
    dump = $script:SaveDigestDumpReasons
    digest = $script:SaveDigestDigestReasons
    refresh = @('current-commit-failed', 'cycle-outcome-invalid')
    freshness = @('target-missing', 'target-unreadable', 'target-invalid', 'target-schema-stale', 'target-adapter-stale', 'target-game-mismatch', 'target-domain-mismatch', 'target-identity-invalid', 'target-below-floor')
    compute = @('adapter-validator-infrastructure-failed', 'baseline-read-failed', 'diff-compatibility-failed', 'diff-compute-failed', 'diff-validation-failed', 'payload-build-failed')
    'reset-write:not-consumed' = @('baseline-serialize-failed', 'baseline-temp-write-failed', 'baseline-replace-failed')
    'reset-write:consumed' = @('cache-target-invalid', 'cache-compare-failed', 'cache-serialize-failed', 'cache-temp-write-failed', 'cache-replace-failed')
    protocol = @('attempt-result-invalid', 'adapter-validator-infrastructure-failed', 'envelope-serialize-failed', 'envelope-invalid')
    emit = @('payload-serialize-failed', 'stdout-write-failed')
    delivery = @('stdout-write-failed')
}
$script:TurnContextInternalReasons = @{
    'cycle-cache' = @('adapter-validator-infrastructure-failed', 'diff-compatibility-failed', 'diff-compute-failed', 'diff-validation-failed', 'cache-serialize-failed', 'cache-temp-write-failed', 'cache-replace-failed')
    'cycle-bookkeeping' = @('bookkeeping-serialize-failed', 'bookkeeping-temp-write-failed', 'bookkeeping-replace-failed')
}
$script:TurnContextCycleCommitReasons = @('current-read-failed', 'current-write-failed')

function Test-TurnContextReason {
    param([AllowNull()] $Reason, [Parameter(Mandatory)] [object[]] $Allowed)

    if ($Reason -isnot [string]) {
        return $false
    }
    foreach ($candidate in $Allowed) {
        if ([string]::Equals($Reason, $candidate, [StringComparison]::Ordinal)) {
            return $true
        }
    }

    return $false
}

function New-TurnContextDetail {
    param([Parameter(Mandatory)] [string] $Class, [Parameter(Mandatory)] [string] $Reason, [hashtable] $Atoms = @{})

    $reasons = if ($script:TurnContextReasons.ContainsKey($Class)) { $script:TurnContextReasons[$Class] } elseif ($script:TurnContextInternalReasons.ContainsKey($Class)) { $script:TurnContextInternalReasons[$Class] } else { $null }
    if ($null -eq $reasons -or -not (Test-TurnContextReason -Reason $Reason -Allowed $reasons)) { throw [TurnContextProtocolException]::new('Invalid turn-context detail.') }
    $allowedAtom = switch ($Reason) {
        'lock-timeout' { 'timeoutSeconds' }
        'command-timeout' { 'timeoutSeconds' }
        'stability-exhausted' { 'attempts' }
        'command-exit-nonzero' { 'exitCode' }
        'schema-version-mismatch' { @('expectedVersion', 'actualVersion') }
        'adapter-version-mismatch' { @('expectedVersion', 'actualVersion') }
        default { @() }
    }
    foreach ($name in $Atoms.Keys) {
        $value = $Atoms[$name]
        if ($name -notin $allowedAtom -or $value -isnot [int] -and $value -isnot [long] -or ($name -eq 'attempts' -and ($value -lt 0 -or $value -gt [int]::MaxValue)) -or ($name -eq 'timeoutSeconds' -and ($value -le 0 -or $value -gt [int]::MaxValue)) -or ($name -eq 'exitCode' -and ($value -lt [int]::MinValue -or $value -gt [int]::MaxValue))) { throw [TurnContextProtocolException]::new('Invalid turn-context detail atoms.') }
    }
    $order = @('attempts', 'timeoutSeconds', 'exitCode', 'expectedVersion', 'actualVersion')
    $parts = foreach ($name in $order) { if ($Atoms.ContainsKey($name)) { "$name=$($Atoms[$name])" } }
    $result = if (@($parts).Count -eq 0) { $Reason } else { "$Reason [$($parts -join ',')]" }
    if (@($result.EnumerateRunes()).Count -gt $script:TurnContextDetailScalarCap) { throw [TurnContextProtocolException]::new('Turn-context detail exceeds scalar cap.') }

    return $result
}

function Read-TurnContextEnvelope {
    [CmdletBinding(DefaultParameterSetName = 'Transport')]
    param([Parameter(Mandatory)] [string] $Json, [Parameter(Mandatory, ParameterSetName = 'Producer')] [AdapterConfig] $AdapterConfig, [Parameter(Mandatory, ParameterSetName = 'Producer')] [bool] $ExpectedCacheDegraded, [Parameter(Mandatory, ParameterSetName = 'Transport')] [switch] $TransportOnly)

    try {
        $document = Read-CompanionJson -Json $Json -Budget 'turn-context'
        $root = $document.RootElement
        Test-ExactFields $root @('turnContextVersion', 'adapterVersion', 'game', 'sourceFloor', 'refresh', 'warnings', 'baselineReset', 'cacheDegraded', 'diff', 'state')
        if ((Test-Integer (Get-Property $root turnContextVersion)) -ne 2) { throw [TurnContextProtocolException]::new('Turn-context envelope is invalid.') }
        $adapterVersion = Test-Integer (Get-Property $root adapterVersion)
        $game = Test-String (Get-Property $root game)
        $floor = Get-TurnContextIdentity -Element (Get-Property $root sourceFloor)
        $refresh = Get-Property $root refresh
        Test-ExactFields $refresh @('attempted', 'commitObserved', 'attempts')
        Test-Boolean (Get-Property $refresh attempted); Test-Boolean (Get-Property $refresh commitObserved)
        $refreshAttempts = Test-Integer (Get-Property $refresh attempts) $true
        if ($refreshAttempts -gt $script:TurnContextRefreshAttemptCap -or (Get-Property $refresh attempted).GetBoolean() -ne ($refreshAttempts -gt 0) -or ((Get-Property $refresh commitObserved).GetBoolean() -and -not (Get-Property $refresh attempted).GetBoolean())) { throw [TurnContextProtocolException]::new('Turn-context envelope is invalid.') }
        Test-Boolean (Get-Property $root baselineReset); Test-Boolean (Get-Property $root cacheDegraded)
        Assert-TurnContextWarnings -Element (Get-Property $root warnings) -OperationalOnly:$false
        $diff = Read-DiffDocument -Json (Get-Property $root diff).GetRawText()
        $state = Read-DigestDocument -Json (Get-Property $root state).GetRawText()
        $diffRoot = $diff.RootElement; $stateRoot = $state.RootElement
        if ($adapterVersion -ne $diffRoot.GetProperty('adapterVersion').GetInt64() -or $adapterVersion -ne $stateRoot.GetProperty('adapterVersion').GetInt64() -or -not [string]::Equals($game, $diffRoot.GetProperty('game').GetString(), [StringComparison]::Ordinal) -or -not [string]::Equals($game, $stateRoot.GetProperty('game').GetString(), [StringComparison]::Ordinal) -or -not [string]::Equals($diffRoot.GetProperty('currentGeneratedAt').GetString(), $stateRoot.GetProperty('generatedAt').GetString(), [StringComparison]::Ordinal)) { throw [TurnContextProtocolException]::new('Turn-context envelope is invalid.') }
        $source = $state.Materialized['source']
        $diffSource = $diff.Materialized['currentSource']
        foreach ($name in 'domainId', 'saveFile', 'savedAt') { if (-not [string]::Equals([string] $source[$name], [string] $diffSource[$name], [StringComparison]::Ordinal)) { throw [TurnContextProtocolException]::new('Turn-context envelope is invalid.') } }
        if ([long] $source['byteLength'] -ne [long] $diffSource['byteLength'] -or -not [string]::Equals([string] $source['contentSha256'], [string] $diffSource['contentSha256'], [StringComparison]::Ordinal) -or -not [string]::Equals([string] $source['domainId'], [string] $floor.domainId, [StringComparison]::Ordinal)) { throw [TurnContextProtocolException]::new('Turn-context envelope is invalid.') }
        $floorOrder = Compare-SourceIdentity -Left $source -Right $floor
        if (-not $floorOrder.comparable -or $floorOrder.order -lt 0 -or (Get-Property $root baselineReset).GetBoolean() -ne ($diffRoot.GetProperty('baselineGeneratedAt').ValueKind -eq [Text.Json.JsonValueKind]::Null)) { throw [TurnContextProtocolException]::new('Turn-context envelope is invalid.') }
        if ($PSCmdlet.ParameterSetName -ceq 'Producer') {
            Assert-AdapterDigestDocument -Document $state -AdapterConfig $AdapterConfig
            if ($adapterVersion -ne $AdapterConfig.AdapterVersion -or -not [string]::Equals($game, $AdapterConfig.Game, [StringComparison]::Ordinal) -or -not [string]::Equals($floor.domainId, $AdapterConfig.SourceDomainId, [StringComparison]::Ordinal) -or (Get-Property $root cacheDegraded).GetBoolean() -ne $ExpectedCacheDegraded) { throw [TurnContextProtocolException]::new('Turn-context envelope is invalid.') }
        }
        return $document
    }
    catch [TurnContextProtocolException] { throw }
    catch [AdapterValidatorInfrastructureException] { throw }
    catch { throw [TurnContextProtocolException]::new('Turn-context envelope is invalid.') }
}

function Get-TurnContextIdentity {
    param([Parameter(Mandatory)] [Text.Json.JsonElement] $Element)

    try {
        Test-SourceIdentityFields $Element

        return ConvertFrom-SourceIdentity -Element $Element
    }
    catch [TurnContextProtocolException] { throw }
    catch { throw [TurnContextProtocolException]::new('Invalid source identity.') }
}

function Assert-TurnContextWarnings {
    param([Parameter(Mandatory)] [Text.Json.JsonElement] $Element, [switch] $OperationalOnly)

    $legal = if ($OperationalOnly) { $script:CompanionWarningProfiles['TurnOperational'] } else { @($script:CompanionWarningProfiles['TurnAttempt']) + @($script:CompanionWarningProfiles['TurnOperational']) }
    try {
        Test-ElementKind $Element Array
        $previous = $null
        foreach ($warning in $Element.EnumerateArray()) {
            Test-ExactFields $warning @('code', 'detail')
            $code = Test-String (Get-Property $warning code)
            $detailElement = Get-Property $warning detail
            $detail = if ($detailElement.ValueKind -eq [Text.Json.JsonValueKind]::Null) { $null } else { Test-String $detailElement }
            if ($code -notin $legal -or ($code -eq 'pipeline-reaper-discovery-limit-exceeded' -and $detail -notin @('tmp', 'state')) -or ($code -eq 'diff-exclude-path-unused' -and ($null -eq $detail -or -not $detail.StartsWith('/', [StringComparison]::Ordinal))) -or ($code -notin @('pipeline-reaper-discovery-limit-exceeded', 'diff-exclude-path-unused') -and $null -ne $detail)) { throw [TurnContextProtocolException]::new('Invalid turn-context warnings.') }
            $key = $code + [char]0 + [string] $detail
            if ($null -ne $previous -and [string]::CompareOrdinal($previous, $key) -ge 0) { throw [TurnContextProtocolException]::new('Invalid turn-context warnings.') }
            $previous = $key
        }
    }
    catch [TurnContextProtocolException] { throw }
    catch { throw [TurnContextProtocolException]::new('Invalid turn-context warnings.') }
}

function Read-TurnContextDiagnostic {
    param([Parameter(Mandatory)] [string] $Json, [Parameter(Mandatory)] [string] $ExpectedClass, [AllowNull()] [string] $ExpectedLockStage)

    try {
        $bytes = [Text.UTF8Encoding]::new($false, $true).GetByteCount($Json)
        if ($bytes -gt 4096) { throw [TurnContextProtocolException]::new('Turn-context diagnostic exceeds byte cap.') }
        $document = Read-CompanionJson -Json $Json -Budget config
        $root = $document.RootElement
        Test-ExactFields $root @('outcomeClass', 'consumptionState', 'lockStage', 'sourceIdentity', 'generationTimestamp', 'detail', 'warnings')
        $class = Test-String (Get-Property $root outcomeClass)
        $consumption = Test-String (Get-Property $root consumptionState)
        if (-not [string]::Equals($class, $ExpectedClass, [StringComparison]::Ordinal) -or $class -notin (@($script:TurnContextReasons.Keys) + 'success') -or $consumption -notin @('none', 'notConsumed', 'consumed', 'unknown')) { throw [TurnContextProtocolException]::new('Invalid turn-context diagnostic.') }
        $lock = Get-Property $root lockStage
        $lockStage = if ($lock.ValueKind -eq [Text.Json.JsonValueKind]::Null) { $null } else { Test-String $lock }
        if (($class -in @('busy', 'lock')) -ne ($null -ne $lockStage) -or ($null -ne $lockStage -and $lockStage -notin @('cycle', 'consume')) -or ($PSBoundParameters.ContainsKey('ExpectedLockStage') -and -not [string]::Equals($lockStage, $ExpectedLockStage, [StringComparison]::Ordinal))) { throw [TurnContextProtocolException]::new('Invalid turn-context diagnostic.') }
        $source = Get-Property $root sourceIdentity; $generation = Get-Property $root generationTimestamp; $detailElement = Get-Property $root detail
        $detail = if ($detailElement.ValueKind -eq [Text.Json.JsonValueKind]::Null) { $null } else { Test-String $detailElement }
        if (($class -eq 'success' -and ($consumption -cne 'consumed' -or $null -ne $detail)) -or ($class -eq 'reset-write:not-consumed' -and $consumption -cne 'notConsumed') -or ($class -eq 'reset-write:consumed' -and $consumption -cne 'consumed') -or ($class -eq 'delivery' -and $consumption -cne 'consumed') -or ($class -notin @('success', 'reset-write:not-consumed', 'reset-write:consumed', 'protocol', 'delivery') -and $consumption -cne 'none') -or ($null -eq $detail -and $class -cne 'success')) { throw [TurnContextProtocolException]::new('Invalid turn-context diagnostic.') }
        if ($consumption -ceq 'unknown' -and ($class -cne 'protocol' -or $detail -cne 'attempt-result-invalid' -or $source.ValueKind -ne [Text.Json.JsonValueKind]::Null -or $generation.ValueKind -ne [Text.Json.JsonValueKind]::Null)) { throw [TurnContextProtocolException]::new('Invalid turn-context diagnostic.') }
        if ($null -ne $detail) {
            $reason = $detail.Split(' ', 2, [StringSplitOptions]::None)[0]
            if ($reason -notin $script:TurnContextReasons[$class]) { throw [TurnContextProtocolException]::new('Invalid turn-context diagnostic.') }
        }
        if ($source.ValueKind -ne [Text.Json.JsonValueKind]::Null) { [void] (Get-TurnContextIdentity -Element $source) }
        if ($generation.ValueKind -ne [Text.Json.JsonValueKind]::Null) { Test-Utc $generation }
        Assert-TurnContextWarnings -Element (Get-Property $root warnings) -OperationalOnly
        return $document
    }
    catch [TurnContextProtocolException] { throw }
    catch { throw [TurnContextProtocolException]::new('Turn-context diagnostic is invalid.') }
}

function Test-TurnContextAttemptInvariants {
    param([Parameter(Mandatory)] [string] $Class, [Parameter(Mandatory)] [string] $State, [AllowNull()] [string] $EnvelopeJson, [bool] $CacheDegraded)

    if (($Class -in @('success', 'reset-write:consumed')) -and ($State -cne 'consumed' -or [string]::IsNullOrEmpty($EnvelopeJson))) { return $false }
    if ($Class -ceq 'reset-write:not-consumed' -and ($State -cne 'notConsumed' -or [string]::IsNullOrEmpty($EnvelopeJson))) { return $false }
    if ($Class -ceq 'protocol' -and ($State -notin @('none', 'notConsumed', 'consumed') -or -not [string]::IsNullOrEmpty($EnvelopeJson))) { return $false }
    if ($Class -notin @('success', 'reset-write:consumed', 'reset-write:not-consumed', 'protocol') -and ($State -cne 'none' -or -not [string]::IsNullOrEmpty($EnvelopeJson))) { return $false }
    if ($CacheDegraded -ne ($Class -ceq 'reset-write:consumed')) { return $false }

    return $true
}

function New-TurnContextAttemptResult {
    param([Parameter(Mandatory)] [string] $OutcomeClass, [Parameter(Mandatory)] [string] $ConsumptionState, [AllowNull()] [string] $EnvelopeJson, [bool] $CacheDegraded, [Parameter(Mandatory)] $Diagnostic)

    if (-not (Test-TurnContextAttemptInvariants -Class $OutcomeClass -State $ConsumptionState -EnvelopeJson $EnvelopeJson -CacheDegraded $CacheDegraded)) { throw [TurnContextProtocolException]::new('Invalid attempt result.') }

    return [pscustomobject]@{ outcomeClass = $OutcomeClass; consumptionState = $ConsumptionState; envelopeJson = $EnvelopeJson; cacheDegraded = $CacheDegraded; diagnostic = $Diagnostic }
}

function Assert-TurnContextAttemptResult {
    param([Parameter(Mandatory)] $Value)

    try {
        $properties = @($Value.PSObject.Properties | ForEach-Object Name)
        $expected = @('outcomeClass', 'consumptionState', 'envelopeJson', 'cacheDegraded', 'diagnostic')
        if ($properties.Count -ne $expected.Count -or @($expected | Where-Object { $_ -notin $properties }).Count -ne 0) { throw [TurnContextProtocolException]::new('Invalid attempt result.') }
        $class = $Value.outcomeClass
        $state = $Value.consumptionState
        if ($class -isnot [string] -or $state -isnot [string] -or $Value.cacheDegraded -isnot [bool] -or ($null -ne $Value.envelopeJson -and $Value.envelopeJson -isnot [string])) { throw [TurnContextProtocolException]::new('Invalid attempt result.') }
        if (-not (Test-TurnContextAttemptInvariants -Class $class -State $state -EnvelopeJson $Value.envelopeJson -CacheDegraded $Value.cacheDegraded)) { throw [TurnContextProtocolException]::new('Invalid attempt result.') }
        $diagnosticJson = ConvertTo-CompanionJson -InputObject $Value.diagnostic -Budget config
        [void] (Read-TurnContextDiagnostic -Json $diagnosticJson -ExpectedClass $class)

        return $Value
    }
    catch [TurnContextProtocolException] { throw }
    catch { throw [TurnContextProtocolException]::new('Invalid attempt result.') }
}

function New-TurnContextDiagnosticObject {
    param([Parameter(Mandatory)] [string] $Class, [Parameter(Mandatory)] [string] $ConsumptionState, [AllowNull()] [string] $Detail, [AllowNull()] $SourceIdentity, [AllowNull()] [string] $GenerationTimestamp, [AllowNull()] [string] $LockStage, [Parameter(Mandatory)] [CompanionWarningSink] $OperationalWarnings)

    # The diagnostic's sourceIdentity must be serializable by ConvertTo-CompanionJson
    # (an IDictionary, never a bare [pscustomobject]) and must round-trip through
    # Read-TurnContextDiagnostic's Get-TurnContextIdentity, which requires savedAt as
    # a canonical UTC 'o' string. This mirrors the envelope's sourceFloor rendering.
    $identity = $null
    if ($null -ne $SourceIdentity) {
        $identity = ConvertTo-WalkIdentity -Source $SourceIdentity
    }

    # An absent generation timestamp must serialize as JSON null (a [AllowNull()]
    # [string] parameter coalesces $null to '' which the diagnostic validator's
    # Test-Utc rejects), mirroring the envelope's handling of null members. The lock
    # stage and the success class's null detail get the same normalization: a
    # non-busy/lock class must carry a null lockStage and a success diagnostic a
    # null detail, never an empty string, per Read-TurnContextDiagnostic.
    $generation = if ([string]::IsNullOrEmpty($GenerationTimestamp)) { $null } else { $GenerationTimestamp }
    $lock = if ([string]::IsNullOrEmpty($LockStage)) { $null } else { $LockStage }
    $detailValue = if ([string]::IsNullOrEmpty($Detail)) { $null } else { $Detail }

    return [ordered]@{ outcomeClass = $Class; consumptionState = $ConsumptionState; lockStage = $lock; sourceIdentity = $identity; generationTimestamp = $generation; detail = $detailValue; warnings = @($OperationalWarnings.Freeze() | ForEach-Object { [ordered]@{ code = $_.code; detail = $_.detail } }) }
}

function Convert-TurnContextPayloadToJson {
    param([Parameter(Mandatory)] [TurnContextPayloadCandidate] $Payload, [Parameter(Mandatory)] [AdapterConfig] $AdapterConfig, [Parameter(Mandatory)] [CompanionWarningSink] $OperationalWarnings)

    $warnings = [Collections.Generic.List[object]]::new()
    foreach ($warning in @($Payload.Warnings) + @($OperationalWarnings.Freeze())) { $warnings.Add([ordered]@{ code = $warning.code; detail = $warning.detail }) }
    # Assert-TurnContextWarnings requires strictly ascending ORDINAL (code, NUL, detail)
    # composite order, but Sort-Object is culture-aware. Sort on an explicit ordinal
    # composite key so the producer order provably matches the reader's requirement even
    # when a detail is punctuation-bearing.
    if ($warnings.Count -gt 1) {
        $orderedKeys = [string[]]@($warnings | ForEach-Object { [string]$_.code + [char]0 + [string]$_.detail })
        $orderedValues = [object[]]@($warnings)
        [Array]::Sort[string, object]($orderedKeys, $orderedValues, [StringComparer]::Ordinal)
        $orderedWarnings = $orderedValues
    }
    else {
        $orderedWarnings = @($warnings)
    }
    $envelope = [ordered]@{
        turnContextVersion = 2
        adapterVersion = $AdapterConfig.AdapterVersion
        game = $AdapterConfig.Game
        sourceFloor = ConvertTo-WalkIdentity -Source $Payload.Context.SourceFloor
        refresh = [ordered]@{ attempted = $Payload.Context.RefreshAttempted; commitObserved = $Payload.Context.RefreshCommitObserved; attempts = $Payload.Context.RefreshAttempts }
        warnings = $orderedWarnings
        baselineReset = $Payload.Diff.RootElement.GetProperty('baselineGeneratedAt').ValueKind -eq [Text.Json.JsonValueKind]::Null
        cacheDegraded = $Payload.CacheDegraded
        diff = $Payload.Diff.RootElement
        state = $Payload.State.RootElement
    }
    $json = ConvertTo-CompanionJson -InputObject $envelope -Budget 'turn-context'
    [void] (Read-TurnContextEnvelope -Json $json -AdapterConfig $AdapterConfig -ExpectedCacheDegraded $Payload.CacheDegraded)

    return $json
}

function Confirm-TurnContextAdapterConfig {
    param([Parameter(Mandatory)] [AdapterConfig] $AdapterConfig)

    $path = Join-Path $AdapterConfig.AdapterDirectory 'adapter.json'
    $bytes = [IO.File]::ReadAllBytes($path)
    $actual = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant()
    if (-not [string]::Equals($actual, $AdapterConfig.ConfigReceipt, [StringComparison]::Ordinal)) { throw [AdapterConfigurationException]::new('Adapter configuration changed.') }
}

function Merge-TurnContextCycleWarnings {
    param([Parameter(Mandatory)] [object] $Warnings, [Parameter(Mandatory)] [CompanionWarningSink] $AttemptWarnings, [Parameter(Mandatory)] [CompanionWarningSink] $OperationalWarnings)

    foreach ($warning in $Warnings) {
        if ($warning.code -in $script:CompanionWarningProfiles['TurnOperational']) {
            Add-CompanionWarning -Sink $OperationalWarnings -Code $warning.code -Detail $warning.detail
        }
        elseif ($warning.code -notin @('pipeline-baseline-absent', 'pipeline-baseline-content-invalid')) {
            Add-CompanionWarning -Sink $AttemptWarnings -Code $warning.code -Detail $warning.detail
        }
    }
}

function Resolve-TurnContextCycleOutcome {
    param([AllowNull()] $Outcome)

    try {
        if ($Outcome -isnot [CycleOutcome]) {
            throw [TurnContextProtocolException]::new('Invalid cycle outcome.')
        }
        Assert-CycleOutcome -Outcome $Outcome
        if ($Outcome.Completed) {
            return [pscustomobject]@{ action = 'continue'; outcomeClass = $null; detail = $null; retryable = $false; warningCode = $null }
        }

        switch ($Outcome.FailurePhase) {
            'source' {
                return [pscustomobject]@{ action = 'failure'; outcomeClass = 'source'; detail = New-TurnContextDetail -Class source -Reason $Outcome.Detail; retryable = $Outcome.Retryable; warningCode = $null }
            }
            'dump' {
                return [pscustomobject]@{ action = 'failure'; outcomeClass = 'dump'; detail = New-TurnContextDetail -Class dump -Reason $Outcome.Detail; retryable = $false; warningCode = $null }
            }
            'digest' {
                return [pscustomobject]@{ action = 'failure'; outcomeClass = 'digest'; detail = New-TurnContextDetail -Class digest -Reason $Outcome.Detail; retryable = $false; warningCode = $null }
            }
            'cache' {
                [void] (New-TurnContextDetail -Class 'cycle-cache' -Reason $Outcome.Detail)

                return [pscustomobject]@{ action = 'revalidate'; outcomeClass = $null; detail = $null; retryable = $false; warningCode = 'pipeline-cache-degraded' }
            }
            'bookkeeping' {
                [void] (New-TurnContextDetail -Class 'cycle-bookkeeping' -Reason $Outcome.Detail)

                return [pscustomobject]@{ action = 'revalidate'; outcomeClass = $null; detail = $null; retryable = $false; warningCode = 'pipeline-bookkeeping-degraded' }
            }
            'initialize' {
                return [pscustomobject]@{ action = 'failure'; outcomeClass = 'source'; detail = New-TurnContextDetail -Class source -Reason $Outcome.Detail; retryable = $false; warningCode = $null }
            }
            'commit' {
                if (-not (Test-TurnContextReason -Reason $Outcome.Detail -Allowed $script:TurnContextCycleCommitReasons)) {
                    throw [TurnContextProtocolException]::new('Invalid cycle outcome.')
                }

                return [pscustomobject]@{ action = 'failure'; outcomeClass = 'refresh'; detail = New-TurnContextDetail -Class refresh -Reason current-commit-failed; retryable = $false; warningCode = $null }
            }
            default {
                throw [TurnContextProtocolException]::new('Invalid cycle outcome.')
            }
        }
    }
    catch {
        return [pscustomobject]@{ action = 'failure'; outcomeClass = 'refresh'; detail = New-TurnContextDetail -Class refresh -Reason cycle-outcome-invalid; retryable = $false; warningCode = $null }
    }
}

function Invoke-TurnContextAttempt {
    param(
        [Parameter(Mandatory)] [string] $CompanionRoot,
        [Parameter(Mandatory)] [AdapterConfig] $AdapterConfig,
        [Parameter(Mandatory)] [CompanionWarningSink] $OperationalWarnings,
        [Parameter()] [hashtable] $Operations = @{}
    )

    # Terminal-result builder: -Reason builds the registry detail for -Class, a
    # precomputed -Detail passes through. Reads the enclosing attempt's
    # $OperationalWarnings via dynamic scope.
    function New-TurnContextTerminalResult {
        param([Parameter(Mandatory)] [string] $Class, [string] $ConsumptionState = 'none', [AllowNull()] [string] $Reason, [AllowNull()] [string] $Detail, [AllowNull()] $SourceIdentity, [AllowNull()] [string] $GenerationTimestamp, [AllowNull()] [string] $LockStage, [AllowNull()] [string] $EnvelopeJson, [bool] $CacheDegraded = $false)

        $detailValue = if ([string]::IsNullOrEmpty($Reason)) { $Detail } else { New-TurnContextDetail -Class $Class -Reason $Reason }

        return New-TurnContextAttemptResult -OutcomeClass $Class -ConsumptionState $ConsumptionState -EnvelopeJson $EnvelopeJson -CacheDegraded $CacheDegraded -Diagnostic (New-TurnContextDiagnosticObject -Class $Class -ConsumptionState $ConsumptionState -Detail $detailValue -SourceIdentity $SourceIdentity -GenerationTimestamp $GenerationTimestamp -LockStage $LockStage -OperationalWarnings $OperationalWarnings)
    }

    $attemptWarnings = New-CompanionWarningSink -Profile TurnAttempt
    $selected = $null
    $target = $null
    $floor = $null
    $refreshAttempts = 0
    $lastFreshnessReason = 'target-below-floor'
    $refreshCommitted = $false
    $cycleWarningCode = $null
    try {
        Initialize-CompanionStateDirectories -CompanionRoot $CompanionRoot
        Invoke-WorkFileReaper -CompanionRoot $CompanionRoot -WarningSink $OperationalWarnings
        for ($pass = 0; $pass -lt $script:TurnContextRefreshAttemptCap; $pass++) {
            try { $candidates = if ($Operations.ContainsKey('GetSaveCandidates')) { & $Operations.GetSaveCandidates $AdapterConfig } else { Get-SaveCandidates -SaveDirectory $AdapterConfig.SaveDirectory -SaveGlob $AdapterConfig.SaveGlob } }
            catch [SaveCandidateLimitException] { return New-TurnContextTerminalResult -Class source -Reason candidate-limit-exceeded }
            catch { return New-TurnContextTerminalResult -Class source -Reason save-enumeration-failed }
            if (@($candidates).Count -eq 0) { return New-TurnContextTerminalResult -Class 'no-saves' -Reason no-matching-saves }
            $selected = @($candidates)[0]
            $identity = New-SourceIdentity -DomainId $AdapterConfig.SourceDomainId -SaveFile $selected.Name -SavedAt $selected.LastWriteTimeUtc
            if ($null -eq $floor -or (Compare-SourceIdentity -Left $identity -Right $floor).order -gt 0) { $floor = $identity }
            $current = if ($Operations.ContainsKey('ReadCurrent')) { & $Operations.ReadCurrent $AdapterConfig } else { Read-CompanionCurrent -CompanionRoot $CompanionRoot -AdapterConfig $AdapterConfig }
            if ($current.outcome -ceq 'validator-infrastructure') { return New-TurnContextTerminalResult -Class compute -Reason adapter-validator-infrastructure-failed -SourceIdentity $floor }
            $fresh = $current.outcome -ceq 'valid' -and (Compare-SourceIdentity -Left $current.document.Materialized['source'] -Right $floor).order -ge 0
            if (-not $fresh) {
                if ($current.outcome -in @('absent', 'content-invalid', 'stale')) { Add-CompanionWarning -Sink $attemptWarnings -Code pipeline-current-self-healed -Detail $null }
                try { $cycleLock = Enter-CompanionCycleLock -CompanionRoot $CompanionRoot } catch [TimeoutException] { return New-TurnContextTerminalResult -Class busy -Reason lock-timeout -SourceIdentity $floor -LockStage cycle } catch { return New-TurnContextTerminalResult -Class lock -Reason lock-open-failed -SourceIdentity $floor -LockStage cycle }
                try {
                    try { if ($Operations.ContainsKey('ConfirmConfig')) { & $Operations.ConfirmConfig $AdapterConfig } else { Confirm-TurnContextAdapterConfig -AdapterConfig $AdapterConfig } }
                    catch [AdapterConfigurationException] { return New-TurnContextTerminalResult -Class config -Reason adapter-config-changed }
                    # 7.5 stage 3: re-enumerate and stability-gate after acquiring
                    # cycle.lock; the cycle processes the post-lock selection and the
                    # floor rises (never lowers) to it.
                    try { $lockedCandidates = if ($Operations.ContainsKey('GetSaveCandidates')) { & $Operations.GetSaveCandidates $AdapterConfig } else { Get-SaveCandidates -SaveDirectory $AdapterConfig.SaveDirectory -SaveGlob $AdapterConfig.SaveGlob } }
                    catch [SaveCandidateLimitException] { return New-TurnContextTerminalResult -Class source -Reason candidate-limit-exceeded -SourceIdentity $floor }
                    catch { return New-TurnContextTerminalResult -Class source -Reason save-enumeration-failed -SourceIdentity $floor }
                    if (@($lockedCandidates).Count -eq 0) { return New-TurnContextTerminalResult -Class 'no-saves' -Reason no-matching-saves }
                    $selected = @($lockedCandidates)[0]
                    $lockedIdentity = New-SourceIdentity -DomainId $AdapterConfig.SourceDomainId -SaveFile $selected.Name -SavedAt $selected.LastWriteTimeUtc
                    if ((Compare-SourceIdentity -Left $lockedIdentity -Right $floor).order -gt 0) { $floor = $lockedIdentity }
                    try { $stable = if ($Operations.ContainsKey('TestStable')) { & $Operations.TestStable $selected } else { Test-FileWriteStable -Path $selected.FullName } }
                    catch [SaveSourceException] {
                        if ($_.Exception.SourceDisposition -ceq 'vanished' -and $pass -lt ($script:TurnContextRefreshAttemptCap - 1)) { continue }
                        $sourceReason = if ($_.Exception.SourceDisposition -ceq 'vanished') { 'source-vanished' } else { 'source-unreadable' }

                        return New-TurnContextTerminalResult -Class source -Reason $sourceReason -SourceIdentity $floor
                    }
                    if (-not $stable) {
                        if ($pass -lt ($script:TurnContextRefreshAttemptCap - 1)) { continue }

                        return New-TurnContextTerminalResult -Class stability -Detail (New-TurnContextDetail -Class stability -Reason stability-exhausted -Atoms @{ attempts = $pass + 1 }) -SourceIdentity $floor
                    }
                    $cycleWarnings = New-CompanionWarningSink -Profile Cycle
                    Invoke-WorkFileReaper -CompanionRoot $CompanionRoot -WarningSink $cycleWarnings
                    $cycle = if ($Operations.ContainsKey('Cycle')) { & $Operations.Cycle $selected $cycleWarnings } else { Invoke-CompanionCycle -CompanionRoot $CompanionRoot -AdapterDirectory $AdapterConfig.AdapterDirectory -AdapterConfig $AdapterConfig -SourceSave $selected -WarningSink $cycleWarnings }
                    $cycleResolution = Resolve-TurnContextCycleOutcome -Outcome $cycle
                    if ($cycleResolution.detail -cne 'cycle-outcome-invalid') {
                        Merge-TurnContextCycleWarnings -Warnings $cycle.Warnings -AttemptWarnings $attemptWarnings -OperationalWarnings $OperationalWarnings
                    }
                    $refreshAttempts++
                    if ($cycle -is [CycleOutcome]) {
                        $refreshCommitted = $refreshCommitted -or $cycle.CurrentCommitted
                    }
                }
                finally { $cycleLock.Dispose() }
                if ($cycleResolution.action -ceq 'failure') {
                    if ($cycleResolution.retryable -and $pass -lt ($script:TurnContextRefreshAttemptCap - 1)) { continue }

                    return New-TurnContextTerminalResult -Class $cycleResolution.outcomeClass -Detail $cycleResolution.detail -SourceIdentity $floor
                }
                $cycleWarningCode = $cycleResolution.warningCode
            }
            $target = if ($fresh) { $current } elseif ($Operations.ContainsKey('ReadCurrent')) { & $Operations.ReadCurrent $AdapterConfig } else { Read-CompanionCurrent -CompanionRoot $CompanionRoot -AdapterConfig $AdapterConfig }
            if ($target.outcome -ceq 'validator-infrastructure') { return New-TurnContextTerminalResult -Class compute -Reason adapter-validator-infrastructure-failed -SourceIdentity $floor }
            if ($target.outcome -ne 'valid') {
                if ($null -ne $cycleWarningCode) { return New-TurnContextTerminalResult -Class freshness -Reason $target.reason -SourceIdentity $floor }
                $lastFreshnessReason = $target.reason

                continue
            }
            if ((Compare-SourceIdentity -Left $target.document.Materialized['source'] -Right $floor).order -lt 0) {
                if ($null -ne $cycleWarningCode) { return New-TurnContextTerminalResult -Class freshness -Reason target-below-floor -SourceIdentity $floor }
                $lastFreshnessReason = 'target-below-floor'

                continue
            }
            if ($null -ne $cycleWarningCode) {
                Add-CompanionWarning -Sink $attemptWarnings -Code $cycleWarningCode -Detail $null
            }
            $context = [TurnContextPayloadContext]::new($floor, $refreshAttempts -gt 0, $refreshCommitted, $refreshAttempts)
            $consume = if ($Operations.ContainsKey('Consumption')) { & $Operations.Consumption $floor $context $attemptWarnings } else { Invoke-CompanionConsumption -AdapterConfig $AdapterConfig -CompanionRoot $CompanionRoot -DeliveryMode privateResult -SourceFloor $floor -Context $context -WarningSink $attemptWarnings }
            if ($consume.payload -is [TurnContextPayloadCandidate]) {
                # An envelope serialization failure must not erase the consumption fact:
                # the baseline may already have advanced, so the protocol diagnostic
                # carries the structured consumption state instead of resetting to none.
                try { $json = Convert-TurnContextPayloadToJson -Payload $consume.payload -AdapterConfig $AdapterConfig -OperationalWarnings $OperationalWarnings }
                catch [AdapterValidatorInfrastructureException] { return New-TurnContextTerminalResult -Class protocol -ConsumptionState $consume.consumptionState -Reason adapter-validator-infrastructure-failed -SourceIdentity $floor }
                catch { return New-TurnContextTerminalResult -Class protocol -ConsumptionState $consume.consumptionState -Reason envelope-serialize-failed -SourceIdentity $floor }
                $generation = $target.document.RootElement.GetProperty('generatedAt').GetString()
                # Consumption reset-write details are registry literals; New-TurnContextDetail
                # re-validates them, so a non-registry detail throws into the protocol
                # catch-all instead of reaching the diagnostic. Success carries null detail.
                $resultDetail = if ($consume.outcomeClass -in @('reset-write:not-consumed', 'reset-write:consumed')) { New-TurnContextDetail -Class $consume.outcomeClass -Reason $consume.detail } else { $null }
                return New-TurnContextTerminalResult -Class $consume.outcomeClass -ConsumptionState $consume.consumptionState -Detail $resultDetail -SourceIdentity $floor -GenerationTimestamp $generation -EnvelopeJson $json -CacheDegraded $consume.cacheDegraded
            }
            if ($consume.outcomeClass -in @('freshness', 'stale-target') -and $pass -lt ($script:TurnContextRefreshAttemptCap - 1)) { continue }
            $consumptionDetail = switch ($consume.outcomeClass) {
                'busy' { New-TurnContextDetail -Class busy -Reason lock-timeout }
                'lock' { New-TurnContextDetail -Class lock -Reason lock-open-failed }
                'stale-target' { New-TurnContextDetail -Class 'stale-target' -Reason target-precedes-baseline }
                'freshness' { New-TurnContextDetail -Class freshness -Reason $consume.detail }
                default {
                    $computeReason = if ($consume.detail -ceq 'payload-or-diff-failed') { 'diff-compute-failed' } else { $consume.detail }
                    New-TurnContextDetail -Class compute -Reason $computeReason
                }
            }
            $consumptionLockStage = if ($consume.outcomeClass -in @('busy', 'lock')) { 'consume' } else { $null }
            return New-TurnContextTerminalResult -Class $consume.outcomeClass -Detail $consumptionDetail -SourceIdentity $floor -LockStage $consumptionLockStage
        }
        return New-TurnContextTerminalResult -Class freshness -Reason $lastFreshnessReason -SourceIdentity $floor
    }
    catch { return New-TurnContextTerminalResult -Class protocol -Reason envelope-invalid -SourceIdentity $floor }
}
