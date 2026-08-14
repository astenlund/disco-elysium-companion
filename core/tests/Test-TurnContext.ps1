#Requires -Version 7.5

[CmdletBinding()]
param(
    [Parameter()]
    [ValidateSet('All', 'DiagnosticProtocol', 'WrapperTerminal', 'WrapperRetry', 'WrapperDeliveryFailure', 'WrapperTransactionSelection', 'RefreshLimit', 'DuplicateSurfaceMatrix', 'TurnContextPairing', 'FreshnessRaceNewerConsumed', 'EnvelopeSerializeStatePreserved', 'EnvelopeProtocolRejection')]
    [string] $Only = 'All'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Import-Module (Join-Path $PSScriptRoot 'TestSupport.psm1') -Force
Import-Module (Join-Path $PSScriptRoot '../DigestDiff.psm1') -Force

$detail = Invoke-InCompanionModule { New-TurnContextDetail -Class 'busy' -Reason 'lock-timeout' -Atoms @{ timeoutSeconds = 10 } }
Assert-Equal -Actual $detail -Expected 'lock-timeout [timeoutSeconds=10]' -Message 'Turn-context details use the registry order and canonical integer spelling.'

Assert-ThrowsType -TypeName 'TurnContextProtocolException' -Action {
    Invoke-InCompanionModule { New-TurnContextDetail -Class 'busy' -Reason 'lock-timeout' -Atoms @{ timeoutSeconds = 0 } }
}

$successDiagnostic = '{"outcomeClass":"success","consumptionState":"consumed","lockStage":null,"sourceIdentity":{"domainId":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef","saveFile":"B.ntwtf.zip","savedAt":"2026-08-10T11:00:00.0000000Z"},"generationTimestamp":"2026-08-10T12:00:00.0000000Z","detail":null,"warnings":[]}'
$diagnostic = Invoke-InCompanionModule { param($Json) Read-TurnContextDiagnostic -Json $Json -ExpectedClass 'success' } @($successDiagnostic)
Assert-Equal -Actual $diagnostic.Materialized['consumptionState'] -Expected 'consumed' -Message 'A complete canonical success diagnostic is accepted.'

Assert-ThrowsType -TypeName 'TurnContextProtocolException' -Action {
    Invoke-InCompanionModule { param($Json) Read-TurnContextDiagnostic -Json $Json -ExpectedClass 'success' } @($successDiagnostic.Replace('"consumed"', '"none"'))
}

$invalidReasonDiagnostic = $successDiagnostic.Replace('"outcomeClass":"success"', '"outcomeClass":"config"').Replace('"consumptionState":"consumed"', '"consumptionState":"none"').Replace('"detail":null', '"detail":"unregistered-reason"').Replace('"sourceIdentity":{"domainId":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef","saveFile":"B.ntwtf.zip","savedAt":"2026-08-10T11:00:00.0000000Z"}', '"sourceIdentity":null').Replace('"generationTimestamp":"2026-08-10T12:00:00.0000000Z"', '"generationTimestamp":null')
Assert-ThrowsType -TypeName 'TurnContextProtocolException' -Action {
    Invoke-InCompanionModule { param($Json) Read-TurnContextDiagnostic -Json $Json -ExpectedClass 'config' } @($invalidReasonDiagnostic)
}

$attempt = [pscustomobject]@{ outcomeClass = 'reset-write:not-consumed'; consumptionState = 'notConsumed'; envelopeJson = '{}'; cacheDegraded = $false; diagnostic = [ordered]@{} }
Assert-ThrowsType -TypeName 'TurnContextProtocolException' -Action {
    Invoke-InCompanionModule { param($Value) Assert-TurnContextAttemptResult -Value $Value } @($attempt)
}
if ($Only -eq 'DuplicateSurfaceMatrix') {
    $duplicateDiagnostic = $successDiagnostic.Replace('"warnings":[]', '"warnings":[],"warnings":[]')
    Assert-ThrowsType -TypeName 'TurnContextProtocolException' -Action {
        Invoke-InCompanionModule { param($Json) Read-TurnContextDiagnostic -Json $Json -ExpectedClass 'success' } @($duplicateDiagnostic)
    }
    Assert-ThrowsType -TypeName 'TurnContextProtocolException' -Action {
        Invoke-InCompanionModule { Read-TurnContextEnvelope -Json '{"turnContextVersion":2,"turnContextVersion":2}' -TransportOnly }
    }
    Write-Output 'PASS: turn context'
    exit 0
}
if ($Only -eq 'DiagnosticProtocol') {
    Write-Output 'PASS: turn context'
    exit 0
}

$wrapperRoot = New-ScratchCompanionRoot -Prefix 'turn-context-wrapper'
$wrapperResult = Invoke-BoundedPwsh -Arguments @('-File', (Join-Path $PSScriptRoot '../Get-TurnContext.ps1'), '-CompanionRoot', $wrapperRoot) -WorkingDirectory $wrapperRoot
Assert-Equal -Actual $wrapperResult.ExitCode -Expected 1 -Message 'The executable wrapper reports an unresolved adapter as one terminal failure.'
Assert-Equal -Actual $wrapperResult.StdOut -Expected '' -Message 'Terminal wrapper failures never emit a turn-context payload.'
Assert-True -Condition $wrapperResult.StdErr.StartsWith('[turn-context:config] ', [StringComparison]::Ordinal) -Message 'Terminal wrapper failures use the typed protocol prefix.'
$terminalJson = $wrapperResult.StdErr.Substring('[turn-context:config] '.Length).TrimEnd("`r", "`n")
$terminal = Invoke-InCompanionModule { param($Json) Read-TurnContextDiagnostic -Json $Json -ExpectedClass config } @($terminalJson)
Assert-Equal -Actual $terminal.Materialized['detail'] -Expected 'adapter-resolution-failed' -Message 'Terminal transport carries the registry-valid config reason without free-form exception text.'
if ($Only -eq 'WrapperTerminal') {
    Write-Output 'PASS: turn context'
    exit 0
}

$wrapperHarness = Join-Path $PSScriptRoot 'Invoke-TurnContextWrapperHarness.ps1'
$retrySuccessRoot = New-ScratchCompanionRoot -Prefix 'turn-context-retry-success'
$retrySuccess = Invoke-BoundedPwsh -Arguments @('-File', $wrapperHarness, '-Scenario', 'retry-success', '-ScratchRoot', $retrySuccessRoot, '-StagedWrapperPath', (Join-Path $PSScriptRoot '../Get-TurnContext.ps1')) -WorkingDirectory $retrySuccessRoot
Assert-Equal -Actual $retrySuccess.ExitCode -Expected 0 -Message 'A valid not-consumed reset result authorizes the wrapper''s sole second attempt.'
Assert-OrdinalEqual -Actual $retrySuccess.StdOut -Expected '{"attempt":"B"}' -Message 'The second successful attempt is the only envelope the wrapper transports.'
Assert-Equal -Actual $retrySuccess.StdErr -Expected '' -Message 'A selected retry envelope has no terminal stderr record.'
Assert-Equal -Actual ([IO.File]::ReadAllText((Join-Path $retrySuccessRoot 'attempt-trace.txt')).Trim()) -Expected "1`n2" -Message 'The retry-success wrapper trace proves exactly two attempts.'

$retryTerminalRoot = New-ScratchCompanionRoot -Prefix 'turn-context-retry-terminal'
$retryTerminal = Invoke-BoundedPwsh -Arguments @('-File', $wrapperHarness, '-Scenario', 'retry-terminal', '-ScratchRoot', $retryTerminalRoot, '-StagedWrapperPath', (Join-Path $PSScriptRoot '../Get-TurnContext.ps1')) -WorkingDirectory $retryTerminalRoot
Assert-Equal -Actual $retryTerminal.ExitCode -Expected 1 -Message 'A terminal second attempt terminates the wrapper after the permitted retry.'
Assert-Equal -Actual $retryTerminal.StdOut -Expected '' -Message 'A terminal retry result emits no turn-context payload.'
Assert-True -Condition $retryTerminal.StdErr.StartsWith('[turn-context:freshness] ', [StringComparison]::Ordinal) -Message 'The second terminal outcome uses the typed terminal transport.'
Assert-Equal -Actual ([IO.File]::ReadAllText((Join-Path $retryTerminalRoot 'attempt-trace.txt')).Trim()) -Expected "1`n2" -Message 'The retry-terminal wrapper trace proves that no third attempt occurs.'
$degradedRoot = New-ScratchCompanionRoot -Prefix 'turn-context-degraded-select'
$degradedSelect = Invoke-BoundedPwsh -Arguments @('-File', $wrapperHarness, '-Scenario', 'degraded-select', '-ScratchRoot', $degradedRoot, '-StagedWrapperPath', (Join-Path $PSScriptRoot '../Get-TurnContext.ps1')) -WorkingDirectory $degradedRoot
Assert-Equal -Actual $degradedSelect.ExitCode -Expected 0 -Message 'A cache-degraded consumed reset is selected as a successful delivery.'
Assert-OrdinalEqual -Actual $degradedSelect.StdOut -Expected '{"attempt":"A"}' -Message 'The degraded consumed envelope is the one the wrapper transports.'
Assert-Equal -Actual ([IO.File]::ReadAllText((Join-Path $degradedRoot 'attempt-trace.txt')).Trim()) -Expected '1' -Message 'A reset-write:consumed result never authorizes a second consuming attempt.'

if ($Only -eq 'WrapperRetry') {
    Write-Output 'PASS: turn context'
    exit 0
}

# Section 11 row "Turn-context failure injection", delivery half (regression guard
# for the stdout [delivery] fix, so it runs under All): the wrapper's one stdout
# write fails after a consumed attempt (the harness swaps Console.Out for a writer
# over a disposed stream; a broken pipe is silently swallowed by .NET on Windows).
# The wrapper must report [delivery]/stdout-write-failed with the consumed state
# preserved and must not start another attempt.
$deliveryRoot = New-ScratchCompanionRoot -Prefix 'turn-context-delivery'
$delivery = Invoke-BoundedPwsh -Arguments @('-File', $wrapperHarness, '-Scenario', 'stdout-fail', '-ScratchRoot', $deliveryRoot, '-StagedWrapperPath', (Join-Path $PSScriptRoot '../Get-TurnContext.ps1')) -WorkingDirectory $deliveryRoot
Assert-Equal -Actual $delivery.ExitCode -Expected 1 -Message 'A failed envelope delivery is a terminal wrapper failure.'
Assert-True -Condition $delivery.StdErr.StartsWith('[turn-context:delivery] ', [StringComparison]::Ordinal) -Message 'A failed stdout write reports the delivery class.'
Assert-True -Condition $delivery.StdErr.Contains('"detail":"stdout-write-failed"', [StringComparison]::Ordinal) -Message 'The delivery diagnostic carries the stdout-write-failed reason.'
Assert-True -Condition $delivery.StdErr.Contains('"consumptionState":"consumed"', [StringComparison]::Ordinal) -Message 'The delivery diagnostic preserves the consumed baseline advancement.'
Assert-Equal -Actual ([IO.File]::ReadAllText((Join-Path $deliveryRoot 'attempt-trace.txt')).Trim()) -Expected '1' -Message 'A delivery failure authorizes no retry.'

# The real diagnostic validator admits the delivery class with the consumed state
# (the host trusts this consumptionState per the acquisition protocol).
$deliveryDiagnostic = Invoke-InCompanionModule {
    $diagnostic = New-TurnContextDiagnosticObject -Class 'delivery' -ConsumptionState 'consumed' -Detail (New-TurnContextDetail -Class delivery -Reason stdout-write-failed) -SourceIdentity $null -GenerationTimestamp $null -LockStage $null -OperationalWarnings (New-CompanionWarningSink -Profile TurnOperational)
    $json = ConvertTo-CompanionJson -InputObject $diagnostic -Budget config

    return (Read-TurnContextDiagnostic -Json $json -ExpectedClass delivery).Materialized['detail']
}
Assert-OrdinalEqual -Actual $deliveryDiagnostic -Expected 'stdout-write-failed' -Message 'Read-TurnContextDiagnostic admits the delivery/consumed diagnostic.'

if ($Only -eq 'WrapperDeliveryFailure') {
    Write-Output 'PASS: turn context'
    exit 0
}

$passRoot = New-ScratchCompanionRoot -Prefix 'turn-context-passes'
$passOutcome = Invoke-InCompanionModule {
    param($Root)
    $saveDirectory = Join-Path $Root 'saves'
    [IO.Directory]::CreateDirectory($saveDirectory) | Out-Null
    $save = Join-Path $saveDirectory 'A.ntwtf.zip'
    [IO.File]::WriteAllText($save, 'x', [Text.UTF8Encoding]::new($false, $true))
    $config = [AdapterConfig]::new()
    $config.SourceDomainId = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
    $config.SaveDirectory = $saveDirectory
    $config.SaveGlob = '*.ntwtf.zip'
    $config.AdapterDirectory = $Root
    $cycles = [Collections.Generic.List[int]]::new()
    $operations = @{
        GetSaveCandidates = { param($Unused) @([IO.FileInfo]::new($save)) }
        ReadCurrent = { param($Unused) [pscustomobject]@{ outcome = 'absent'; document = $null; reason = 'target-missing' } }
        ConfirmConfig = { param($Unused) }
        TestStable = { param($Save) $true }
        Cycle = { param($UnusedSave, $Sink) $cycles.Add(1); [CycleOutcome]::new($true, $true, $false, $true, $true, $null, 'stable', $false, $null, $Sink.Freeze()) }
    }
    $result = Invoke-TurnContextAttempt -CompanionRoot $Root -AdapterConfig $config -OperationalWarnings (New-CompanionWarningSink -Profile TurnOperational) -Operations $operations
    [pscustomobject]@{ result = $result; cycles = $cycles.Count }
} @($passRoot)
Assert-Equal -Actual $passOutcome.result.outcomeClass -Expected 'freshness' -Message 'Three failed target admissions terminate as freshness rather than consuming stale state.'
Assert-Equal -Actual $passOutcome.cycles -Expected 3 -Message 'An acquisition attempt performs at most three refresh cycles.'
$driftOutcome = Invoke-InCompanionModule {
    param($Root)
    $save = [IO.FileInfo]::new((Join-Path $Root 'saves/A.ntwtf.zip'))
    $config = [AdapterConfig]::new()
    $config.SourceDomainId = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
    $config.AdapterDirectory = $Root
    $calls = [Collections.Generic.List[string]]::new()
    $operations = @{
        GetSaveCandidates = { param($Unused) @($save) }
        ReadCurrent = { param($Unused) [pscustomobject]@{ outcome = 'absent'; document = $null; reason = 'target-missing' } }
        ConfirmConfig = { param($Unused) throw [AdapterConfigurationException]::new('changed') }
        TestStable = { param($Save) $true }
        Cycle = { param($UnusedSave, $Sink) $calls.Add('cycle'); [CycleOutcome]::new($true, $true, $false, $true, $true, $null, 'stable', $false, $null, $Sink.Freeze()) }
    }
    $result = Invoke-TurnContextAttempt -CompanionRoot $Root -AdapterConfig $config -OperationalWarnings (New-CompanionWarningSink -Profile TurnOperational) -Operations $operations
    [pscustomobject]@{ result = $result; calls = $calls.Count }
} @($passRoot)
Assert-Equal -Actual $driftOutcome.result.outcomeClass -Expected 'config' -Message 'A post-lock configuration receipt change is terminal configuration drift.'
Assert-Equal -Actual $driftOutcome.calls -Expected 0 -Message 'Receipt drift stops before the cycle can publish a digest.'

function Write-TurnContextPassGate {
    Write-Output 'PASS: turn context'
}

$turnContextDigestTemplate = '{"schemaVersion":2,"adapterVersion":2,"game":"example","generatedAt":"GEN","source":{"domainId":"DOM","saveFile":"FILE","savedAt":"SAVE","byteLength":1,"contentSha256":"abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd"},"session":{"day":1,"time":"08:09","location":"place","playtimeNote":null},"character":{"level":1,"xp":0,"unspentPoints":0,"money":{"amount":1.25,"minorUnits":125,"minorUnitsPerUnit":100,"currency":"real"},"vitals":[{"name":"health","value":1}],"skills":[{"name":"Logic","value":1,"group":"Intellect"}]},"objectives":[{"id":"TASK.example","title":"example","status":"active","acquired":{"day":1,"time":"08:09"},"resolved":null,"subobjectives":[]}],"inventory":{"owned":["item"],"equipped":["item"],"highlights":[]},"extra":{}}'
$turnContextDomain = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'

# The attempt-fixture setup (AdapterConfig plus one staged save at the canonical
# timestamp) is shared by every in-module attempt block below; the module-private
# [AdapterConfig] type forces construction inside module scope, so this helper
# builds the objects there and hands them back for each block to consume.
function New-TurnContextAttemptFixture {
    param([Parameter(Mandatory)] [string] $Root, [Parameter()] [string] $Game = 'example')

    return Invoke-InCompanionModule {
        param($Root, $Game, $Domain)
        $config = [AdapterConfig]::new()
        $config.SourceDomainId = $Domain
        $config.AdapterVersion = 2L
        $config.Game = $Game
        $config.SaveDirectory = Join-Path $Root 'saves'
        $config.SaveGlob = '*.ntwtf.zip'
        $config.AdapterDirectory = $Root
        $config.Validator = { param($Document) }
        [IO.Directory]::CreateDirectory($config.SaveDirectory) | Out-Null
        $savePath = Join-Path $config.SaveDirectory 'B.ntwtf.zip'
        [IO.File]::WriteAllText($savePath, 'x', [Text.UTF8Encoding]::new($false, $true))
        [IO.File]::SetLastWriteTimeUtc($savePath, [datetime]::Parse('2026-08-10T11:00:00.0000000Z', [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind))

        return [pscustomobject]@{ Config = $config; SavePath = $savePath }
    } @($Root, $Game, $turnContextDomain)
}

if ($Only -eq 'TurnContextPairing') {
    $pairingRoot = New-ScratchCompanionRoot -Prefix 'turn-context-pairing'
    $pairingFixture = New-TurnContextAttemptFixture -Root $pairingRoot
    $pairing = Invoke-InCompanionModule {
        param($Root, $Template, $Domain, $Config, $SavePath)
        $stateJson = $Template.Replace('GEN', '2026-08-10T12:00:00.0000000Z').Replace('DOM', $Domain).Replace('FILE', 'B.ntwtf.zip').Replace('SAVE', '2026-08-10T11:00:00.0000000Z')
        $stateDoc = Read-DigestDocument -Json $stateJson
        $diffDoc = New-EmptyDiff -Target $stateDoc
        $operations = @{
            GetSaveCandidates = { param($Unused) @([IO.FileInfo]::new($SavePath)) }
            ReadCurrent = { param($Unused) [pscustomobject]@{ outcome = 'valid'; document = $stateDoc; reason = $null } }
            ConfirmConfig = { param($Unused) }
            Consumption = { param($Floor, $Ctx, $Sink) $p = New-ConsumePayload -DeliveryMode privateResult -Diff $diffDoc -State $stateDoc -Context $Ctx; $p.Complete($false, $Sink.Freeze()); New-ConsumptionResult -OutcomeClass success -ConsumptionState consumed -Payload $p -CacheDegraded $false -Detail $null }
        }
        $res = Invoke-TurnContextAttempt -CompanionRoot $Root -AdapterConfig $Config -OperationalWarnings (New-CompanionWarningSink -Profile TurnOperational) -Operations $operations
        $envDoc = Read-TurnContextEnvelope -Json $res.envelopeJson -AdapterConfig $Config -ExpectedCacheDegraded $false
        $e = $envDoc.RootElement; $diff = $e.GetProperty('diff'); $st = $e.GetProperty('state'); $floor = $e.GetProperty('sourceFloor')
        $src = $st.GetProperty('source')
        [pscustomobject]@{
            outcomeClass = $res.outcomeClass
            topSet = ((($e.EnumerateObject() | ForEach-Object Name) | Sort-Object) -join ',')
            topAdapter = $e.GetProperty('adapterVersion').GetInt64()
            topGame = $e.GetProperty('game').GetString()
            diffAdapter = $diff.GetProperty('adapterVersion').GetInt64()
            stateAdapter = $st.GetProperty('adapterVersion').GetInt64()
            diffGame = $diff.GetProperty('game').GetString()
            stateGame = $st.GetProperty('game').GetString()
            diffGen = $diff.GetProperty('currentGeneratedAt').GetString()
            stateGen = $st.GetProperty('generatedAt').GetString()
            diffSourceJson = $diff.GetProperty('currentSource').ToString()
            stateSourceJson = $src.ToString()
            baselineReset = $e.GetProperty('baselineReset').GetBoolean()
            diffBaselineNull = ($diff.GetProperty('baselineGeneratedAt').ValueKind -eq [Text.Json.JsonValueKind]::Null)
            cacheDegraded = $e.GetProperty('cacheDegraded').GetBoolean()
            warningsCount = $e.GetProperty('warnings').GetArrayLength()
            floorFile = $floor.GetProperty('saveFile').GetString()
            floorSavedAt = $floor.GetProperty('savedAt').GetString()
            floorDomain = $floor.GetProperty('domainId').GetString()
            srcFile = $src.GetProperty('saveFile').GetString()
            srcSavedAt = $src.GetProperty('savedAt').GetString()
            srcDomain = $src.GetProperty('domainId').GetString()
        }
    } @($pairingRoot, $turnContextDigestTemplate, $turnContextDomain, $pairingFixture.Config, $pairingFixture.SavePath)
    Assert-Equal -Actual $pairing.outcomeClass -Expected 'success' -Message 'A fresh bridge attempt emits a producer-valid success envelope.'
    Assert-OrdinalEqual -Actual $pairing.topSet -Expected 'adapterVersion,baselineReset,cacheDegraded,diff,game,refresh,sourceFloor,state,turnContextVersion,warnings' -Message 'A successful bridge envelope carries exactly the 7.5 top-level field set.'
    Assert-Equal -Actual $pairing.diffAdapter -Expected $pairing.topAdapter -Message 'Nested diff adapter equals the envelope top-level adapter.'
    Assert-Equal -Actual $pairing.stateAdapter -Expected $pairing.topAdapter -Message 'Nested state adapter equals the envelope top-level adapter.'
    Assert-OrdinalEqual -Actual $pairing.diffGame -Expected $pairing.topGame -Message 'Nested diff game equals the envelope top-level game.'
    Assert-OrdinalEqual -Actual $pairing.stateGame -Expected $pairing.topGame -Message 'Nested state game equals the envelope top-level game.'
    Assert-OrdinalEqual -Actual $pairing.diffGen -Expected $pairing.stateGen -Message 'Diff target generation equals the state generation.'
    Assert-OrdinalEqual -Actual $pairing.diffSourceJson -Expected $pairing.stateSourceJson -Message 'Every diff source-receipt field equals the state receipt.'
    Assert-Equal -Actual $pairing.baselineReset -Expected $true -Message 'baselineReset reflects the diff null test.'
    Assert-Equal -Actual $pairing.diffBaselineNull -Expected $true -Message 'The produced empty diff has a null baseline.'
    Assert-False -Condition $pairing.cacheDegraded -Message 'A clean success carries cacheDegraded false.'
    Assert-Equal -Actual $pairing.warningsCount -Expected 0 -Message 'A fresh clean run carries no warnings.'
    Assert-OrdinalEqual -Actual $pairing.floorFile -Expected $pairing.srcFile -Message 'Source floor matches the emitted target identity file.'
    Assert-OrdinalEqual -Actual $pairing.floorSavedAt -Expected $pairing.srcSavedAt -Message 'Source floor matches the emitted target identity timestamp.'
    Assert-OrdinalEqual -Actual $pairing.floorDomain -Expected $pairing.srcDomain -Message 'Source floor matches the emitted target identity domain.'

    Write-TurnContextPassGate
    exit 0
}

if ($Only -eq 'FreshnessRaceNewerConsumed') {
    $publishedRoot = New-ScratchCompanionRoot -Prefix 'turn-context-race-published'
    $publishedFixture = New-TurnContextAttemptFixture -Root $publishedRoot
    $published = Invoke-InCompanionModule {
        param($Root, $Template, $Domain, $Config, $SavePath)
        $s1Json = $Template.Replace('GEN', '2026-08-10T12:00:00.0000000Z').Replace('DOM', $Domain).Replace('FILE', 'B.ntwtf.zip').Replace('SAVE', '2026-08-10T11:00:00.0000000Z')
        $s2Json = $Template.Replace('GEN', '2026-08-10T14:00:00.0000000Z').Replace('DOM', $Domain).Replace('FILE', 'S2.ntwtf.zip').Replace('SAVE', '2026-08-10T13:00:00.0000000Z')
        $s1Doc = Read-DigestDocument -Json $s1Json
        $s2Doc = Read-DigestDocument -Json $s2Json
        $diff2 = New-EmptyDiff -Target $s2Doc
        $operations = @{
            GetSaveCandidates = { param($Unused) @([IO.FileInfo]::new($SavePath)) }
            ReadCurrent = { param($Unused) [pscustomobject]@{ outcome = 'valid'; document = $s1Doc; reason = $null } }
            ConfirmConfig = { param($Unused) }
            Consumption = { param($Floor, $Ctx, $Sink) $p = New-ConsumePayload -DeliveryMode privateResult -Diff $diff2 -State $s2Doc -Context $Ctx; $p.Complete($false, $Sink.Freeze()); New-ConsumptionResult -OutcomeClass success -ConsumptionState consumed -Payload $p -CacheDegraded $false -Detail $null }
        }
        $res = Invoke-TurnContextAttempt -CompanionRoot $Root -AdapterConfig $Config -OperationalWarnings (New-CompanionWarningSink -Profile TurnOperational) -Operations $operations
        $envDoc = Read-TurnContextEnvelope -Json $res.envelopeJson -AdapterConfig $Config -ExpectedCacheDegraded $false
        $e = $envDoc.RootElement; $src = $e.GetProperty('state').GetProperty('source'); $floor = $e.GetProperty('sourceFloor')
        [pscustomobject]@{
            outcomeClass = $res.outcomeClass
            consumedFile = $src.GetProperty('saveFile').GetString()
            consumedSavedAt = $src.GetProperty('savedAt').GetString()
            floorFile = $floor.GetProperty('saveFile').GetString()
            floorSavedAt = $floor.GetProperty('savedAt').GetString()
        }
    } @($publishedRoot, $turnContextDigestTemplate, $turnContextDomain, $publishedFixture.Config, $publishedFixture.SavePath)
    Assert-Equal -Actual $published.outcomeClass -Expected 'success' -Message 'A serialized publish of a newer save is consumed in the same turn.'
    Assert-OrdinalEqual -Actual $published.consumedFile -Expected 'S2.ntwtf.zip' -Message 'Only the newer S2 reaches consumption.'
    Assert-OrdinalEqual -Actual $published.floorFile -Expected 'B.ntwtf.zip' -Message 'The floor stays pinned at the older S1 established before the race.'
    Assert-True -Condition ([datetime]::Parse($published.consumedSavedAt, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind) -gt [datetime]::Parse($published.floorSavedAt, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind)) -Message 'The consumed S2 sits above the S1 floor.'

    Write-TurnContextPassGate
    exit 0
}

# Section 11 row "Turn-context failure injection", envelope-serialize half
# (regression guard for the consumption-state preservation fix, so it runs under
# All): attempt-level envelope serialization failure returns [protocol] while
# PRESERVING the structured consumption state (the baseline may already have
# advanced), with no envelope and no wrapper retry authorization. The adapter
# config's game mismatch makes Convert-TurnContextPayloadToJson's self-validation
# throw after consumption.
$serializeRoot = New-ScratchCompanionRoot -Prefix 'turn-context-envelope-serialize'
$serializeFixture = New-TurnContextAttemptFixture -Root $serializeRoot -Game 'other'
$serialize = Invoke-InCompanionModule {
    param($Root, $Template, $Domain, $Config, $SavePath)
    $stateJson = $Template.Replace('GEN', '2026-08-10T12:00:00.0000000Z').Replace('DOM', $Domain).Replace('FILE', 'B.ntwtf.zip').Replace('SAVE', '2026-08-10T11:00:00.0000000Z')
    $stateDoc = Read-DigestDocument -Json $stateJson
    $rows = [Collections.Generic.List[object]]::new()
    foreach ($case in @(
            @{ outcome = 'success'; state = 'consumed'; degraded = $false; detail = $null },
            @{ outcome = 'reset-write:not-consumed'; state = 'notConsumed'; degraded = $false; detail = 'baseline-temp-write-failed' })) {
        $operations = @{
            GetSaveCandidates = { param($Unused) @([IO.FileInfo]::new($SavePath)) }
            ReadCurrent = { param($Unused) [pscustomobject]@{ outcome = 'valid'; document = $stateDoc; reason = $null } }
            ConfirmConfig = { param($Unused) }
            Consumption = { param($Floor, $Ctx, $Sink) $p = New-ConsumePayload -DeliveryMode privateResult -Diff (New-EmptyDiff -Target $stateDoc) -State $stateDoc -Context $Ctx; $p.Complete($case.degraded, $Sink.Freeze()); New-ConsumptionResult -OutcomeClass $case.outcome -ConsumptionState $case.state -Payload $p -CacheDegraded $case.degraded -Detail $case.detail }
        }
        $res = Invoke-TurnContextAttempt -CompanionRoot $Root -AdapterConfig $Config -OperationalWarnings (New-CompanionWarningSink -Profile TurnOperational) -Operations $operations
        [void] (Assert-TurnContextAttemptResult -Value $res)
        $rows.Add([pscustomobject]@{
                consumptionOutcome = $case.outcome
                outcomeClass = $res.outcomeClass
                consumptionState = $res.consumptionState
                envelopeJson = $res.envelopeJson
                cacheDegraded = $res.cacheDegraded
                diagnosticState = $res.diagnostic['consumptionState']
                diagnosticDetail = $res.diagnostic['detail']
            })
    }

    return @($rows)
} @($serializeRoot, $turnContextDigestTemplate, $turnContextDomain, $serializeFixture.Config, $serializeFixture.SavePath)
foreach ($row in $serialize) {
    Assert-Equal -Actual $row.outcomeClass -Expected 'protocol' -Message "Envelope serialization failure after '$($row.consumptionOutcome)' maps to the protocol class."
    Assert-True -Condition ($null -eq $row.envelopeJson -or $row.envelopeJson -eq '') -Message "Envelope serialization failure after '$($row.consumptionOutcome)' emits no envelope."
    Assert-False -Condition $row.cacheDegraded -Message "Envelope serialization failure after '$($row.consumptionOutcome)' does not fabricate cache degradation."
    Assert-OrdinalEqual -Actual $row.diagnosticDetail -Expected 'envelope-serialize-failed' -Message "Envelope serialization failure after '$($row.consumptionOutcome)' carries the registry serialize reason."
}
Assert-Equal -Actual $serialize[0].consumptionState -Expected 'consumed' -Message 'Serialization failure after a consumed consumption preserves consumed.'
Assert-Equal -Actual $serialize[0].diagnosticState -Expected 'consumed' -Message 'The diagnostic reports the preserved consumed state.'
Assert-Equal -Actual $serialize[1].consumptionState -Expected 'notConsumed' -Message 'Serialization failure after a notConsumed consumption preserves notConsumed.'
Assert-Equal -Actual $serialize[1].diagnosticState -Expected 'notConsumed' -Message 'The diagnostic reports the preserved notConsumed state.'

if ($Only -eq 'EnvelopeSerializeStatePreserved') {
    Write-TurnContextPassGate
    exit 0
}

if ($Only -eq 'EnvelopeProtocolRejection') {
    $protocol = Invoke-InCompanionModule {
        param($Template, $Domain)
        $stateJson = $Template.Replace('GEN', '2026-08-10T12:00:00.0000000Z').Replace('DOM', $Domain).Replace('FILE', 'B.ntwtf.zip').Replace('SAVE', '2026-08-10T11:00:00.0000000Z')
        $stateDoc = Read-DigestDocument -Json $stateJson
        $diffDoc = New-EmptyDiff -Target $stateDoc
        $floor = [ordered]@{ domainId = $Domain; saveFile = 'B.ntwtf.zip'; savedAt = '2026-08-10T11:00:00.0000000Z' }
        $refresh = [ordered]@{ attempted = $false; commitObserved = $false; attempts = 0 }
        $base = [ordered]@{ turnContextVersion = 2; adapterVersion = 2L; game = 'example'; sourceFloor = $floor; refresh = $refresh; warnings = @(); baselineReset = $true; cacheDegraded = $false; diff = $diffDoc.RootElement; state = $stateDoc.RootElement }
        function Convert-TestEnvelope([object] $Envelope) { ConvertTo-CompanionJson -InputObject $Envelope -Budget 'turn-context' }
        function Test-EnvelopeRejects([string] $Json) {
            try {
                [void] (Read-TurnContextEnvelope -Json $Json -TransportOnly)

                return $false
            }
            catch [TurnContextProtocolException] { return $true }
            catch { return $false }
        }
        $validJson = Convert-TestEnvelope $base
        $vVersion = [ordered]@{ turnContextVersion = 3; adapterVersion = 2L; game = 'example'; sourceFloor = $floor; refresh = $refresh; warnings = @(); baselineReset = $true; cacheDegraded = $false; diff = $diffDoc.RootElement; state = $stateDoc.RootElement }
        $vMissing = [ordered]@{ turnContextVersion = 2; adapterVersion = 2L; game = 'example'; sourceFloor = $floor; refresh = $refresh; warnings = @(); baselineReset = $true; cacheDegraded = $false; diff = $diffDoc.RootElement }
        $vInvariant = [ordered]@{ turnContextVersion = 2; adapterVersion = 2L; game = 'other'; sourceFloor = $floor; refresh = $refresh; warnings = @(); baselineReset = $true; cacheDegraded = $false; diff = $diffDoc.RootElement; state = $stateDoc.RootElement }
        $vBaseline = [ordered]@{ turnContextVersion = 2; adapterVersion = 2L; game = 'example'; sourceFloor = $floor; refresh = $refresh; warnings = @(); baselineReset = $false; cacheDegraded = $false; diff = $diffDoc.RootElement; state = $stateDoc.RootElement }
        [pscustomobject]@{
            validPasses = (-not (Test-EnvelopeRejects $validJson))
            version = (Test-EnvelopeRejects (Convert-TestEnvelope $vVersion))
            missingField = (Test-EnvelopeRejects (Convert-TestEnvelope $vMissing))
            crossField = (Test-EnvelopeRejects (Convert-TestEnvelope $vInvariant))
            baselineReset = (Test-EnvelopeRejects (Convert-TestEnvelope $vBaseline))
        }
    } @($turnContextDigestTemplate, $turnContextDomain)
    Assert-True -Condition $protocol.validPasses -Message 'A complete canonical envelope passes transport validation.'
    Assert-True -Condition $protocol.version -Message 'A wrong envelope version maps to the protocol exception.'
    Assert-True -Condition $protocol.missingField -Message 'A missing top-level field maps to the protocol exception.'
    Assert-True -Condition $protocol.crossField -Message 'A broken cross-field invariant maps to the protocol exception.'
    Assert-True -Condition $protocol.baselineReset -Message 'A baselineReset mismatch against the diff null test maps to the protocol exception.'

    Write-TurnContextPassGate
    exit 0
}

$consumeOutcomeRoot = New-ScratchCompanionRoot -Prefix 'turn-context-consume-outcome'
$consumeOutcomeFixture = New-TurnContextAttemptFixture -Root $consumeOutcomeRoot
$consumeOutcome = Invoke-InCompanionModule {
    param($Root, $Template, $Domain, $Config, $SavePath)
    $stateJson = $Template.Replace('GEN', '2026-08-10T12:00:00.0000000Z').Replace('DOM', $Domain).Replace('FILE', 'B.ntwtf.zip').Replace('SAVE', '2026-08-10T11:00:00.0000000Z')
    $stateDoc = Read-DigestDocument -Json $stateJson
    $expectedReason = @{ busy = 'lock-timeout'; lock = 'lock-open-failed'; 'stale-target' = 'target-precedes-baseline'; freshness = 'target-below-floor' }
    # The injected consumption results carry class-owned registry details; the
    # ConsumeResult constructor rejects anything else.
    $consumeDetail = @{ busy = 'consume-lock-busy'; lock = 'consume-lock-failed'; freshness = 'target-below-floor'; 'stale-target' = 'target-precedes-baseline' }
    $rows = [Collections.Generic.List[object]]::new()
    $registryChecks = [Collections.Generic.List[object]]::new()
    foreach ($outcome in @('busy', 'lock', 'freshness', 'stale-target')) {
        $operations = @{
            GetSaveCandidates = { param($Unused) @([IO.FileInfo]::new($SavePath)) }
            ReadCurrent = { param($Unused) [pscustomobject]@{ outcome = 'valid'; document = $stateDoc; reason = $null } }
            ConfirmConfig = { param($Unused) }
            Consumption = { param($Floor, $Ctx, $Sink) New-ConsumptionResult -OutcomeClass $outcome -ConsumptionState none -Payload $null -CacheDegraded $false -Detail $consumeDetail[$outcome] }
        }
        $res = Invoke-TurnContextAttempt -CompanionRoot $Root -AdapterConfig $Config -OperationalWarnings (New-CompanionWarningSink -Profile TurnOperational) -Operations $operations
        $rows.Add([pscustomobject]@{ outcome = $outcome; resultClass = $res.outcomeClass; detail = $res.diagnostic.detail; lockStage = $res.diagnostic.lockStage })

        # Prove the (class, reason, lockStage) combination is registry-valid through
        # the real diagnostic reader using a serializable minimal shape; a reason
        # absent from that class's registry (the old diff-compute-failed bug) throws.
        $lockJson = if ($outcome -in @('busy', 'lock')) { '"consume"' } else { 'null' }
        $diagJson = '{"outcomeClass":"' + $outcome + '","consumptionState":"none","lockStage":' + $lockJson + ',"sourceIdentity":null,"generationTimestamp":null,"detail":"' + $expectedReason[$outcome] + '","warnings":[]}'
        $round = if ($outcome -in @('busy', 'lock')) {
            Read-TurnContextDiagnostic -Json $diagJson -ExpectedClass $outcome -ExpectedLockStage 'consume'
        }
        else {
            Read-TurnContextDiagnostic -Json $diagJson -ExpectedClass $outcome
        }
        $registryChecks.Add($round.Materialized['outcomeClass'])
    }
    return [pscustomobject]@{ rows = @($rows); registry = @($registryChecks) }
} @($consumeOutcomeRoot, $turnContextDigestTemplate, $turnContextDomain, $consumeOutcomeFixture.Config, $consumeOutcomeFixture.SavePath)
$consumeOutcomeExpectedReason = @{ busy = 'lock-timeout'; lock = 'lock-open-failed'; 'stale-target' = 'target-precedes-baseline'; freshness = 'target-below-floor' }
foreach ($row in $consumeOutcome.rows) {
    Assert-Equal -Actual $row.resultClass -Expected $row.outcome -Message "A consumption '$($row.outcome)' outcome propagates its own class through the final pass."
    Assert-OrdinalEqual -Actual $row.detail -Expected $consumeOutcomeExpectedReason[$row.outcome] -Message "A '$($row.outcome)' final-pass diagnostic carries the registry-valid '$($consumeOutcomeExpectedReason[$row.outcome])' detail, not a compute-class reason."
}
Assert-True -Condition (@($consumeOutcome.rows | Where-Object { $_.outcome -in @('busy', 'lock') -and $_.lockStage -cne 'consume' }).Count -eq 0) -Message 'Busy and lock final-pass diagnostics carry the consume lock stage.'
Assert-Equal -Actual @($consumeOutcome.registry).Count -Expected 4 -Message 'Every consume outcome reason round-trips through Read-TurnContextDiagnostic.'

# Reset-write stage passthrough: the attempt's diagnostic detail is exactly the
# consumption detail, validated against the class-owned registry.
$resetDetailRoot = New-ScratchCompanionRoot -Prefix 'turn-context-reset-details'
$resetDetailFixture = New-TurnContextAttemptFixture -Root $resetDetailRoot
$resetDetails = Invoke-InCompanionModule {
    param($Root, $Template, $Domain, $Config, $SavePath)
    $stateJson = $Template.Replace('GEN', '2026-08-10T12:00:00.0000000Z').Replace('DOM', $Domain).Replace('FILE', 'B.ntwtf.zip').Replace('SAVE', '2026-08-10T11:00:00.0000000Z')
    $stateDoc = Read-DigestDocument -Json $stateJson
    $rows = [Collections.Generic.List[object]]::new()
    foreach ($case in @(
            @{ outcome = 'reset-write:not-consumed'; state = 'notConsumed'; degraded = $false; detail = 'baseline-serialize-failed' },
            @{ outcome = 'reset-write:not-consumed'; state = 'notConsumed'; degraded = $false; detail = 'baseline-replace-failed' },
            @{ outcome = 'reset-write:consumed'; state = 'consumed'; degraded = $true; detail = 'cache-compare-failed' },
            @{ outcome = 'reset-write:consumed'; state = 'consumed'; degraded = $true; detail = 'cache-serialize-failed' },
            @{ outcome = 'reset-write:consumed'; state = 'consumed'; degraded = $true; detail = 'cache-temp-write-failed' },
            @{ outcome = 'reset-write:consumed'; state = 'consumed'; degraded = $true; detail = 'cache-replace-failed' })) {
        $operations = @{
            GetSaveCandidates = { param($Unused) @([IO.FileInfo]::new($SavePath)) }
            ReadCurrent = { param($Unused) [pscustomobject]@{ outcome = 'valid'; document = $stateDoc; reason = $null } }
            ConfirmConfig = { param($Unused) }
            Consumption = { param($Floor, $Ctx, $Sink) $p = New-ConsumePayload -DeliveryMode privateResult -Diff (New-EmptyDiff -Target $stateDoc) -State $stateDoc -Context $Ctx; $p.Complete($case.degraded, $Sink.Freeze()); New-ConsumptionResult -OutcomeClass $case.outcome -ConsumptionState $case.state -Payload $p -CacheDegraded $case.degraded -Detail $case.detail }
        }
        $res = Invoke-TurnContextAttempt -CompanionRoot $Root -AdapterConfig $Config -OperationalWarnings (New-CompanionWarningSink -Profile TurnOperational) -Operations $operations
        $rows.Add([pscustomobject]@{ detail = $case.detail; class = $res.outcomeClass; diagnosticDetail = $res.diagnostic['detail'] })
    }

    return @($rows)
} @($resetDetailRoot, $turnContextDigestTemplate, $turnContextDomain, $resetDetailFixture.Config, $resetDetailFixture.SavePath)
foreach ($row in $resetDetails) {
    Assert-OrdinalEqual -Actual $row.diagnosticDetail -Expected $row.detail -Message "The '$($row.detail)' consumption detail passes through to the attempt diagnostic unchanged."
}

# The attempt's terminal freshness diagnostic carries the last observed target
# reason, not a hard-coded below-floor.
$freshnessThreadRoot = New-ScratchCompanionRoot -Prefix 'turn-context-freshness-thread'
$freshnessThreadFixture = New-TurnContextAttemptFixture -Root $freshnessThreadRoot
$freshnessThread = Invoke-InCompanionModule {
    param($Root, $Config, $SavePath)
    $operations = @{
        GetSaveCandidates = { param($Unused) @([IO.FileInfo]::new($SavePath)) }
        ReadCurrent = { param($Unused) [pscustomobject]@{ outcome = 'content-invalid'; document = $null; reason = 'target-invalid' } }
        ConfirmConfig = { param($Unused) }
        TestStable = { param($Save) $true }
        Cycle = { param($UnusedSave, $Sink) [CycleOutcome]::new($true, $true, $false, $true, $true, $null, 'stable', $false, $null, $Sink.Freeze()) }
    }

    return Invoke-TurnContextAttempt -CompanionRoot $Root -AdapterConfig $Config -OperationalWarnings (New-CompanionWarningSink -Profile TurnOperational) -Operations $operations
} @($freshnessThreadRoot, $freshnessThreadFixture.Config, $freshnessThreadFixture.SavePath)
Assert-Equal -Actual $freshnessThread.outcomeClass -Expected 'freshness' -Message 'Exhausted invalid-target passes terminate as freshness.'
Assert-OrdinalEqual -Actual $freshnessThread.diagnostic['detail'] -Expected 'target-invalid' -Message 'The terminal freshness diagnostic threads the observed target reason.'

# Section 11 adapter-validator infrastructure boundaries (attempt side): initial
# target, preflight target, and producer envelope.
$validatorInfraRoot = New-ScratchCompanionRoot -Prefix 'turn-context-validator-infra'
$validatorInfraFixture = New-TurnContextAttemptFixture -Root $validatorInfraRoot
$validatorInfra = Invoke-InCompanionModule {
    param($Root, $Template, $Domain, $Config, $SavePath)
    $stateJson = $Template.Replace('GEN', '2026-08-10T12:00:00.0000000Z').Replace('DOM', $Domain).Replace('FILE', 'B.ntwtf.zip').Replace('SAVE', '2026-08-10T11:00:00.0000000Z')
    $stateDoc = Read-DigestDocument -Json $stateJson
    $rows = [ordered]@{}

    # Initial target read (stage 3): terminal compute, no cycle, nothing consumed.
    $initialCycles = [Collections.Generic.List[int]]::new()
    $rows['initial'] = Invoke-TurnContextAttempt -CompanionRoot $Root -AdapterConfig $Config -OperationalWarnings (New-CompanionWarningSink -Profile TurnOperational) -Operations @{
        GetSaveCandidates = { param($Unused) @([IO.FileInfo]::new($SavePath)) }
        ReadCurrent = { param($Unused) [pscustomobject]@{ outcome = 'validator-infrastructure'; document = $null; reason = 'adapter-validator-infrastructure-failed' } }
        ConfirmConfig = { param($Unused) }
        Cycle = { param($UnusedSave, $Sink) $initialCycles.Add(1); [CycleOutcome]::new($true, $true, $false, $true, $true, $null, 'stable', $false, $null, $Sink.Freeze()) }
    }
    $rows['initialCycles'] = $initialCycles.Count

    # Preflight target read (post-refresh): first read absent forces the refresh,
    # the second read fails in validator infrastructure.
    $preflightReads = [Collections.Generic.List[int]]::new()
    $rows['preflight'] = Invoke-TurnContextAttempt -CompanionRoot $Root -AdapterConfig $Config -OperationalWarnings (New-CompanionWarningSink -Profile TurnOperational) -Operations @{
        GetSaveCandidates = { param($Unused) @([IO.FileInfo]::new($SavePath)) }
        ReadCurrent = { param($Unused) $preflightReads.Add(1); if ($preflightReads.Count -eq 1) { [pscustomobject]@{ outcome = 'absent'; document = $null; reason = 'target-missing' } } else { [pscustomobject]@{ outcome = 'validator-infrastructure'; document = $null; reason = 'adapter-validator-infrastructure-failed' } } }
        ConfirmConfig = { param($Unused) }
        TestStable = { param($Save) $true }
        Cycle = { param($UnusedSave, $Sink) [CycleOutcome]::new($true, $true, $false, $true, $true, $null, 'stable', $false, $null, $Sink.Freeze()) }
    }

    # Producer envelope validation: the reads and consumption bypass the validator,
    # so its first invocation happens inside Read-TurnContextEnvelope's producer
    # branch; an untyped throw there is protocol infrastructure with the consumed
    # state preserved.
    $Config.Validator = { param($Document) throw [InvalidOperationException]::new('validator machinery broke') }
    $rows['envelope'] = Invoke-TurnContextAttempt -CompanionRoot $Root -AdapterConfig $Config -OperationalWarnings (New-CompanionWarningSink -Profile TurnOperational) -Operations @{
        GetSaveCandidates = { param($Unused) @([IO.FileInfo]::new($SavePath)) }
        ReadCurrent = { param($Unused) [pscustomobject]@{ outcome = 'valid'; document = $stateDoc; reason = $null } }
        ConfirmConfig = { param($Unused) }
        Consumption = { param($Floor, $Ctx, $Sink) $p = New-ConsumePayload -DeliveryMode privateResult -Diff (New-EmptyDiff -Target $stateDoc) -State $stateDoc -Context $Ctx; $p.Complete($false, $Sink.Freeze()); New-ConsumptionResult -OutcomeClass success -ConsumptionState consumed -Payload $p -CacheDegraded $false -Detail $null }
    }

    return $rows
} @($validatorInfraRoot, $turnContextDigestTemplate, $turnContextDomain, $validatorInfraFixture.Config, $validatorInfraFixture.SavePath)
Assert-Equal -Actual $validatorInfra['initial'].outcomeClass -Expected 'compute' -Message 'Initial-target validator infrastructure failure is terminal compute.'
Assert-OrdinalEqual -Actual $validatorInfra['initial'].diagnostic['detail'] -Expected 'adapter-validator-infrastructure-failed' -Message 'The initial-target diagnostic carries the registry infrastructure reason.'
Assert-Equal -Actual $validatorInfra['initialCycles'] -Expected 0 -Message 'Initial-target validator infrastructure failure never starts a cycle.'
Assert-True -Condition ($null -ne $validatorInfra['initial'].diagnostic['sourceIdentity']) -Message 'The initial-target compute diagnostic carries the selected identity.'
Assert-True -Condition ($null -eq $validatorInfra['initial'].diagnostic['generationTimestamp']) -Message 'The initial-target compute diagnostic carries a null generation.'
Assert-Equal -Actual $validatorInfra['preflight'].outcomeClass -Expected 'compute' -Message 'Preflight-target validator infrastructure failure is terminal compute.'
Assert-OrdinalEqual -Actual $validatorInfra['preflight'].diagnostic['detail'] -Expected 'adapter-validator-infrastructure-failed' -Message 'The preflight diagnostic carries the registry infrastructure reason.'
Assert-Equal -Actual $validatorInfra['envelope'].outcomeClass -Expected 'protocol' -Message 'Producer-envelope validator infrastructure failure is protocol.'
Assert-Equal -Actual $validatorInfra['envelope'].consumptionState -Expected 'consumed' -Message 'Producer-envelope infrastructure failure preserves the consumed state.'
Assert-OrdinalEqual -Actual $validatorInfra['envelope'].diagnostic['detail'] -Expected 'adapter-validator-infrastructure-failed' -Message 'The producer-envelope diagnostic carries the registry infrastructure reason.'

# The compute-detail passthrough (the third sibling of the reset-write and freshness
# passthroughs): baseline-read-failed and adapter-validator-infrastructure-failed
# thread through unchanged; the internal payload-or-diff-failed literal maps to
# diff-compute-failed.
$computeDetailRoot = New-ScratchCompanionRoot -Prefix 'turn-context-compute-details'
$computeDetailFixture = New-TurnContextAttemptFixture -Root $computeDetailRoot
$computeDetails = Invoke-InCompanionModule {
    param($Root, $Template, $Domain, $Config, $SavePath)
    $stateJson = $Template.Replace('GEN', '2026-08-10T12:00:00.0000000Z').Replace('DOM', $Domain).Replace('FILE', 'B.ntwtf.zip').Replace('SAVE', '2026-08-10T11:00:00.0000000Z')
    $stateDoc = Read-DigestDocument -Json $stateJson
    $rows = [Collections.Generic.List[object]]::new()
    foreach ($case in @(
            @{ detail = 'baseline-read-failed'; expected = 'baseline-read-failed' },
            @{ detail = 'payload-or-diff-failed'; expected = 'diff-compute-failed' },
            @{ detail = 'adapter-validator-infrastructure-failed'; expected = 'adapter-validator-infrastructure-failed' })) {
        $operations = @{
            GetSaveCandidates = { param($Unused) @([IO.FileInfo]::new($SavePath)) }
            ReadCurrent = { param($Unused) [pscustomobject]@{ outcome = 'valid'; document = $stateDoc; reason = $null } }
            ConfirmConfig = { param($Unused) }
            Consumption = { param($Floor, $Ctx, $Sink) New-ConsumptionResult -OutcomeClass compute -ConsumptionState none -Payload $null -CacheDegraded $false -Detail $case.detail }
        }
        $res = Invoke-TurnContextAttempt -CompanionRoot $Root -AdapterConfig $Config -OperationalWarnings (New-CompanionWarningSink -Profile TurnOperational) -Operations $operations
        $rows.Add([pscustomobject]@{ detail = $case.detail; expected = $case.expected; class = $res.outcomeClass; diagnosticDetail = $res.diagnostic['detail'] })
    }

    return @($rows)
} @($computeDetailRoot, $turnContextDigestTemplate, $turnContextDomain, $computeDetailFixture.Config, $computeDetailFixture.SavePath)
foreach ($row in $computeDetails) {
    Assert-Equal -Actual $row.class -Expected 'compute' -Message "A '$($row.detail)' consumption result terminates as compute."
    Assert-OrdinalEqual -Actual $row.diagnosticDetail -Expected $row.expected -Message "The '$($row.detail)' consumption detail maps to '$($row.expected)' in the attempt diagnostic."
}

# Section 11 "Acquisition retry taxonomy": only retryable failures draw the extra
# passes inside the three-pass budget; permanent failures make one initial pass,
# including the post-lock stability gate's typed classes.
$retryTaxonomyRoot = New-ScratchCompanionRoot -Prefix 'turn-context-retry-taxonomy'
$retryTaxonomyFixture = New-TurnContextAttemptFixture -Root $retryTaxonomyRoot
$retryTaxonomy = Invoke-InCompanionModule {
    param($Root, $Template, $Domain, $Config, $SavePath)
    $stateJson = $Template.Replace('GEN', '2026-08-10T12:00:00.0000000Z').Replace('DOM', $Domain).Replace('FILE', 'B.ntwtf.zip').Replace('SAVE', '2026-08-10T11:00:00.0000000Z')
    $stateDoc = Read-DigestDocument -Json $stateJson
    $rows = [Collections.Generic.List[object]]::new()

    foreach ($case in @(
            @{ name = 'freshness'; detail = 'target-below-floor'; expectedCalls = 3; expectedClass = 'freshness' },
            @{ name = 'stale-target'; detail = 'target-precedes-baseline'; expectedCalls = 3; expectedClass = 'stale-target' },
            @{ name = 'busy'; detail = 'consume-lock-busy'; expectedCalls = 1; expectedClass = 'busy' })) {
        $consumptions = [Collections.Generic.List[int]]::new()
        $operations = @{
            GetSaveCandidates = { param($Unused) @([IO.FileInfo]::new($SavePath)) }
            ReadCurrent = { param($Unused) [pscustomobject]@{ outcome = 'valid'; document = $stateDoc; reason = $null } }
            ConfirmConfig = { param($Unused) }
            Consumption = { param($Floor, $Ctx, $Sink) $consumptions.Add(1); New-ConsumptionResult -OutcomeClass $case.name -ConsumptionState none -Payload $null -CacheDegraded $false -Detail $case.detail }
        }
        $res = Invoke-TurnContextAttempt -CompanionRoot $Root -AdapterConfig $Config -OperationalWarnings (New-CompanionWarningSink -Profile TurnOperational) -Operations $operations
        $rows.Add([pscustomobject]@{ name = $case.name; calls = $consumptions.Count; expectedCalls = $case.expectedCalls; class = $res.outcomeClass; expectedClass = $case.expectedClass })
    }

    foreach ($case in @(
            @{ name = 'cycle-retryable'; disposition = 'vanished'; retryable = $true; detail = 'source-vanished'; expectedCalls = 3 },
            @{ name = 'cycle-permanent'; disposition = 'unreadable'; retryable = $false; detail = 'source-unreadable'; expectedCalls = 1 })) {
        $cycles = [Collections.Generic.List[int]]::new()
        $operations = @{
            GetSaveCandidates = { param($Unused) @([IO.FileInfo]::new($SavePath)) }
            ReadCurrent = { param($Unused) [pscustomobject]@{ outcome = 'absent'; document = $null; reason = 'target-missing' } }
            ConfirmConfig = { param($Unused) }
            TestStable = { param($Save) $true }
            Cycle = { param($UnusedSave, $Sink) $cycles.Add(1); [CycleOutcome]::new($false, $false, $false, $false, $false, 'source', $case.disposition, $case.retryable, $case.detail, $Sink.Freeze()) }
        }
        $res = Invoke-TurnContextAttempt -CompanionRoot $Root -AdapterConfig $Config -OperationalWarnings (New-CompanionWarningSink -Profile TurnOperational) -Operations $operations
        $rows.Add([pscustomobject]@{ name = $case.name; calls = $cycles.Count; expectedCalls = $case.expectedCalls; class = $res.outcomeClass; expectedClass = 'refresh' })
    }

    return @($rows)
} @($retryTaxonomyRoot, $turnContextDigestTemplate, $turnContextDomain, $retryTaxonomyFixture.Config, $retryTaxonomyFixture.SavePath)
foreach ($row in $retryTaxonomy) {
    Assert-Equal -Actual $row.calls -Expected $row.expectedCalls -Message "The '$($row.name)' outcome drives exactly $($row.expectedCalls) pass(es) within the three-pass budget."
    Assert-Equal -Actual $row.class -Expected $row.expectedClass -Message "The '$($row.name)' outcome terminates as '$($row.expectedClass)'."
}

# Post-lock stability gate taxonomy: unstable and vanished retry within the budget,
# unreadable stops immediately, and the gate runs on the post-lock re-enumeration's
# selection with the floor raised, never lowered.
$stabilityRoot = New-ScratchCompanionRoot -Prefix 'turn-context-stability'
$stabilityFixture = New-TurnContextAttemptFixture -Root $stabilityRoot
$stabilityRows = Invoke-InCompanionModule {
    param($Root, $Config, $SavePath)
    $rows = [Collections.Generic.List[object]]::new()
    foreach ($case in @(
            @{ name = 'unstable'; gate = { param($Save) $false }; expectedCalls = 3; expectedClass = 'stability'; expectedDetail = 'stability-exhausted [attempts=3]' },
            @{ name = 'vanished'; gate = { param($Save) throw [SaveSourceException]::new('vanished', 'save-source-vanished', $null) }; expectedCalls = 3; expectedClass = 'source'; expectedDetail = 'source-vanished' },
            @{ name = 'unreadable'; gate = { param($Save) throw [SaveSourceException]::new('unreadable', 'save-source-unreadable', $null) }; expectedCalls = 1; expectedClass = 'source'; expectedDetail = 'source-unreadable' })) {
        $gates = [Collections.Generic.List[int]]::new()
        $cycles = [Collections.Generic.List[int]]::new()
        $gateProbe = $case.gate
        $operations = @{
            GetSaveCandidates = { param($Unused) @([IO.FileInfo]::new($SavePath)) }
            ReadCurrent = { param($Unused) [pscustomobject]@{ outcome = 'absent'; document = $null; reason = 'target-missing' } }
            ConfirmConfig = { param($Unused) }
            TestStable = { param($Save) $gates.Add(1); & $gateProbe $Save }
            Cycle = { param($UnusedSave, $Sink) $cycles.Add(1); [CycleOutcome]::new($true, $true, $false, $true, $true, $null, 'stable', $false, $null, $Sink.Freeze()) }
        }
        $res = Invoke-TurnContextAttempt -CompanionRoot $Root -AdapterConfig $Config -OperationalWarnings (New-CompanionWarningSink -Profile TurnOperational) -Operations $operations
        $rows.Add([pscustomobject]@{ name = $case.name; gateCalls = $gates.Count; cycleCalls = $cycles.Count; class = $res.outcomeClass; detail = $res.diagnostic['detail']; expectedCalls = $case.expectedCalls; expectedClass = $case.expectedClass; expectedDetail = $case.expectedDetail })
    }

    # The post-lock re-enumeration re-selects: a newer save appearing between the
    # pre-lock selection and the lock acquisition is the one the cycle processes,
    # and the floor rises to it.
    $newerPath = Join-Path (Split-Path $SavePath -Parent) 'C.ntwtf.zip'
    [IO.File]::WriteAllText($newerPath, 'y', [Text.UTF8Encoding]::new($false, $true))
    [IO.File]::SetLastWriteTimeUtc($newerPath, [datetime]::Parse('2026-08-10T13:00:00.0000000Z', [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind))
    $enumerations = [Collections.Generic.List[int]]::new()
    $cycledSaves = [Collections.Generic.List[string]]::new()
    $reselect = Invoke-TurnContextAttempt -CompanionRoot $Root -AdapterConfig $Config -OperationalWarnings (New-CompanionWarningSink -Profile TurnOperational) -Operations @{
        GetSaveCandidates = { param($Unused) $enumerations.Add(1); if ($enumerations.Count -eq 1) { @([IO.FileInfo]::new($SavePath)) } else { @([IO.FileInfo]::new($newerPath), [IO.FileInfo]::new($SavePath)) } }
        ReadCurrent = { param($Unused) [pscustomobject]@{ outcome = 'absent'; document = $null; reason = 'target-missing' } }
        ConfirmConfig = { param($Unused) }
        TestStable = { param($Save) $true }
        Cycle = { param($CycleSave, $Sink) $cycledSaves.Add($CycleSave.Name); [CycleOutcome]::new($true, $true, $false, $true, $true, $null, 'stable', $false, $null, $Sink.Freeze()) }
    }
    [IO.File]::Delete($newerPath)

    return [pscustomobject]@{ rows = @($rows); firstCycledSave = $cycledSaves[0]; reselectFloorFile = $reselect.diagnostic['sourceIdentity'] }
} @($stabilityRoot, $stabilityFixture.Config, $stabilityFixture.SavePath)
foreach ($row in $stabilityRows.rows) {
    Assert-Equal -Actual $row.gateCalls -Expected $row.expectedCalls -Message "The '$($row.name)' gate outcome draws exactly $($row.expectedCalls) gate pass(es)."
    Assert-Equal -Actual $row.cycleCalls -Expected 0 -Message "The '$($row.name)' gate outcome never reaches the cycle."
    Assert-Equal -Actual $row.class -Expected $row.expectedClass -Message "The '$($row.name)' gate outcome terminates as '$($row.expectedClass)'."
    Assert-OrdinalEqual -Actual $row.detail -Expected $row.expectedDetail -Message "The '$($row.name)' gate outcome carries '$($row.expectedDetail)'."
}
Assert-OrdinalEqual -Actual $stabilityRows.firstCycledSave -Expected 'C.ntwtf.zip' -Message 'The cycle processes the post-lock re-selected newer save.'
Assert-OrdinalEqual -Actual ([string] $stabilityRows.reselectFloorFile['saveFile']) -Expected 'C.ntwtf.zip' -Message 'The floor rises to the post-lock selection.'

# The remaining post-lock terminal exits: an empty re-enumeration is no-saves, a
# failing re-enumeration is non-retryable source/save-enumeration-failed, and an
# over-limit re-enumeration is non-retryable source/candidate-limit-exceeded (this
# is the first attempt-level pin of the candidate-limit terminal on either side of
# the lock).
$lockEnumRoot = New-ScratchCompanionRoot -Prefix 'turn-context-lock-enum'
$lockEnumFixture = New-TurnContextAttemptFixture -Root $lockEnumRoot
$lockEnum = Invoke-InCompanionModule {
    param($Root, $Config, $SavePath)
    $emptyCalls = [Collections.Generic.List[int]]::new()
    $empty = Invoke-TurnContextAttempt -CompanionRoot $Root -AdapterConfig $Config -OperationalWarnings (New-CompanionWarningSink -Profile TurnOperational) -Operations @{
        GetSaveCandidates = { param($Unused) $emptyCalls.Add(1); if ($emptyCalls.Count -eq 1) { @([IO.FileInfo]::new($SavePath)) } else { @() } }
        ReadCurrent = { param($Unused) [pscustomobject]@{ outcome = 'absent'; document = $null; reason = 'target-missing' } }
        ConfirmConfig = { param($Unused) }
        TestStable = { param($Save) $true }
        Cycle = { param($UnusedSave, $Sink) [CycleOutcome]::new($true, $true, $false, $true, $true, $null, 'stable', $false, $null, $Sink.Freeze()) }
    }
    $failCalls = [Collections.Generic.List[int]]::new()
    $failed = Invoke-TurnContextAttempt -CompanionRoot $Root -AdapterConfig $Config -OperationalWarnings (New-CompanionWarningSink -Profile TurnOperational) -Operations @{
        GetSaveCandidates = { param($Unused) $failCalls.Add(1); if ($failCalls.Count -eq 1) { @([IO.FileInfo]::new($SavePath)) } else { throw [IO.IOException]::new('enumeration broke') } }
        ReadCurrent = { param($Unused) [pscustomobject]@{ outcome = 'absent'; document = $null; reason = 'target-missing' } }
        ConfirmConfig = { param($Unused) }
        TestStable = { param($Save) $true }
        Cycle = { param($UnusedSave, $Sink) [CycleOutcome]::new($true, $true, $false, $true, $true, $null, 'stable', $false, $null, $Sink.Freeze()) }
    }

    $limitCalls = [Collections.Generic.List[int]]::new()
    $limited = Invoke-TurnContextAttempt -CompanionRoot $Root -AdapterConfig $Config -OperationalWarnings (New-CompanionWarningSink -Profile TurnOperational) -Operations @{
        GetSaveCandidates = { param($Unused) $limitCalls.Add(1); if ($limitCalls.Count -eq 1) { @([IO.FileInfo]::new($SavePath)) } else { throw [SaveCandidateLimitException]::new('save-candidate-limit-exceeded') } }
        ReadCurrent = { param($Unused) [pscustomobject]@{ outcome = 'absent'; document = $null; reason = 'target-missing' } }
        ConfirmConfig = { param($Unused) }
        TestStable = { param($Save) $true }
        Cycle = { param($UnusedSave, $Sink) [CycleOutcome]::new($true, $true, $false, $true, $true, $null, 'stable', $false, $null, $Sink.Freeze()) }
    }

    return [pscustomobject]@{ emptyClass = $empty.outcomeClass; emptyDetail = $empty.diagnostic['detail']; failedClass = $failed.outcomeClass; failedDetail = $failed.diagnostic['detail']; failedIdentityFile = [string] $failed.diagnostic['sourceIdentity']['saveFile']; limitClass = $limited.outcomeClass; limitDetail = $limited.diagnostic['detail']; limitIdentityFile = [string] $limited.diagnostic['sourceIdentity']['saveFile'] }
} @($lockEnumRoot, $lockEnumFixture.Config, $lockEnumFixture.SavePath)
Assert-Equal -Actual $lockEnum.emptyClass -Expected 'no-saves' -Message 'An empty post-lock re-enumeration terminates as no-saves.'
Assert-OrdinalEqual -Actual $lockEnum.emptyDetail -Expected 'no-matching-saves' -Message 'An empty post-lock re-enumeration carries no-matching-saves.'
Assert-Equal -Actual $lockEnum.failedClass -Expected 'source' -Message 'A failing post-lock re-enumeration is terminal source.'
Assert-OrdinalEqual -Actual $lockEnum.failedDetail -Expected 'save-enumeration-failed' -Message 'A failing post-lock re-enumeration carries save-enumeration-failed.'
Assert-OrdinalEqual -Actual $lockEnum.failedIdentityFile -Expected 'B.ntwtf.zip' -Message 'A failing post-lock re-enumeration carries the latched floor as provenance.'
Assert-Equal -Actual $lockEnum.limitClass -Expected 'source' -Message 'An over-limit post-lock re-enumeration is terminal source.'
Assert-OrdinalEqual -Actual $lockEnum.limitDetail -Expected 'candidate-limit-exceeded' -Message 'An over-limit post-lock re-enumeration carries candidate-limit-exceeded.'
Assert-OrdinalEqual -Actual $lockEnum.limitIdentityFile -Expected 'B.ntwtf.zip' -Message 'An over-limit post-lock re-enumeration carries the latched floor as provenance.'

# A populated sourceIdentity must serialize through the real writer and round-trip
# through the diagnostic reader: a bare [pscustomobject] sourceIdentity is not an
# IDictionary that ConvertTo-CompanionJson can write, and a null generation
# timestamp must render as JSON null (not ''), both of which failed before the
# New-TurnContextDiagnosticObject normalization (tracked bug turn-context-sourceidentity-kind).
$diagRoundTrip = Invoke-InCompanionModule {
    $sink = New-CompanionWarningSink -Profile TurnOperational
    $floor = [pscustomobject]@{ domainId = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'; saveFile = 'B.ntwtf.zip'; savedAt = [datetime]'2026-08-10T11:00:00.0000000Z' }
    $diag = New-TurnContextDiagnosticObject -Class busy -ConsumptionState none -Detail (New-TurnContextDetail -Class busy -Reason lock-timeout) -SourceIdentity $floor -GenerationTimestamp $null -LockStage consume -OperationalWarnings $sink
    $json = ConvertTo-CompanionJson -InputObject $diag -Budget config
    $parsed = Read-TurnContextDiagnostic -Json $json -ExpectedClass busy -ExpectedLockStage consume
    $id = $parsed.RootElement.GetProperty('sourceIdentity')
    return [pscustomobject]@{ generationNull = ($parsed.RootElement.GetProperty('generationTimestamp').ValueKind -eq [Text.Json.JsonValueKind]::Null); savedAt = $id.GetProperty('savedAt').GetString(); file = $id.GetProperty('saveFile').GetString() }
}
Assert-True -Condition $diagRoundTrip.generationNull -Message 'A diagnostic with no generation timestamp serializes that member as JSON null, not an empty string.'
Assert-OrdinalEqual -Actual $diagRoundTrip.savedAt -Expected '2026-08-10T11:00:00.0000000Z' -Message 'A populated sourceIdentity round-trips its canonical UTC savedAt through the real diagnostic writer and reader.'

# The success diagnostic is the one class whose detail must be JSON null; the same
# [AllowNull()] [string] coalescing that broke generationTimestamp and lockStage
# also turns -Detail $null into '', which Read-TurnContextDiagnostic rejects.
$successDetailNull = Invoke-InCompanionModule {
    $sink = New-CompanionWarningSink -Profile TurnOperational
    $floor = [pscustomobject]@{ domainId = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'; saveFile = 'B.ntwtf.zip'; savedAt = [datetime]'2026-08-10T11:00:00.0000000Z' }
    $diag = New-TurnContextDiagnosticObject -Class success -ConsumptionState consumed -Detail $null -SourceIdentity $floor -GenerationTimestamp '2026-08-10T12:00:00.0000000Z' -LockStage $null -OperationalWarnings $sink
    $json = ConvertTo-CompanionJson -InputObject $diag -Budget config
    $parsed = Read-TurnContextDiagnostic -Json $json -ExpectedClass success
    return ($parsed.RootElement.GetProperty('detail').ValueKind -eq [Text.Json.JsonValueKind]::Null)
}
Assert-True -Condition $successDetailNull -Message 'A success diagnostic serializes its null detail as JSON null and round-trips through the diagnostic reader.'

if ($Only -eq 'WrapperTransactionSelection') {
    # Section 11 host-transaction-selection through the REAL wrapper and core: a
    # genuine acquisition whose first attempt fails its baseline write one-shot
    # (reset-write:not-consumed) and drops a newer save at the failure point. The
    # wrapper's sole retry must consume the newer target, only attempt B's envelope
    # may reach stdout, and attempt A's envelope is discarded.
    $txRoot = New-ScratchCompanionRoot -Prefix 'turn-context-transaction'
    $txCore = Join-Path $txRoot 'core'
    $txSaves = Join-Path $txRoot 'saves'
    $txAdapter = Join-Path $txRoot 'adapters/stub'
    foreach ($txDir in @($txSaves, (Join-Path $txRoot '.tmp'))) { [void] [IO.Directory]::CreateDirectory($txDir) }
    Copy-CompanionCoreTree -Destination $txCore -EntryScripts @('Get-TurnContext.ps1')
    Install-StubAdapterRelease -AdapterDirectory $txAdapter
    $txConfig = New-StubAdapterCommandConfig -SaveDirectory $txSaves
    [IO.File]::WriteAllText((Join-Path $txAdapter 'adapter.json'), (Invoke-InCompanionModule { param($Config) ConvertTo-CompanionJson -InputObject $Config -Budget config } @(, $txConfig)), [Text.UTF8Encoding]::new($false, $true))

    $txSaveA = Join-Path $txSaves 's-a.zip'
    [IO.File]::WriteAllText($txSaveA, 'save-a', [Text.UTF8Encoding]::new($false, $true))
    [IO.File]::SetLastWriteTimeUtc($txSaveA, [DateTime]::UtcNow.AddMinutes(-5))

    # One-shot env-gated failure at the staged baseline-write call site: the first
    # consuming attempt records the marker, drops the newer save, and throws.
    $txConsumptionPath = Join-Path $txCore 'private/Consumption.ps1'
    $txConsumptionSource = [IO.File]::ReadAllText($txConsumptionPath, [Text.UTF8Encoding]::new($false, $true))
    $txAnchor = '            & $WriteBaseline $CompanionRoot $target'
    Assert-Equal -Actual ([regex]::Matches($txConsumptionSource, [regex]::Escape($txAnchor)).Count) -Expected 1 -Message 'Transaction fixture finds one baseline-write call site.'
    $txInjection = @(
        '            if (-not [string]::IsNullOrEmpty($env:COMPANION_TEST_BASELINE_FAIL_MARKER) -and -not [IO.File]::Exists($env:COMPANION_TEST_BASELINE_FAIL_MARKER)) {'
        '                [IO.File]::WriteAllText($env:COMPANION_TEST_BASELINE_FAIL_MARKER, ''failed'')'
        '                $injectedNewerSave = Join-Path $env:COMPANION_TEST_NEWER_SAVE_DIR ''s-b.zip'''
        '                [IO.File]::WriteAllText($injectedNewerSave, ''save-b'')'
        '                [IO.File]::SetLastWriteTimeUtc($injectedNewerSave, [IO.File]::GetLastWriteTimeUtc((Join-Path $env:COMPANION_TEST_NEWER_SAVE_DIR ''s-a.zip'')).AddMinutes(2))'
        '                throw [IO.IOException]::new(''injected baseline write failure'')'
        '            }'
    ) -join "`n"
    [IO.File]::WriteAllText($txConsumptionPath, $txConsumptionSource.Replace($txAnchor, "$txInjection`n$txAnchor", [StringComparison]::Ordinal), [Text.UTF8Encoding]::new($false, $true))

    $txMarker = Join-Path $txRoot '.tmp/baseline-fail-marker'
    $txResult = Invoke-BoundedPwsh -Arguments @('-File', (Join-Path $txCore 'Get-TurnContext.ps1')) -WorkingDirectory $txRoot -TimeoutMilliseconds 240000 -Environment @{
        COMPANION_TEST_BASELINE_FAIL_MARKER = $txMarker
        COMPANION_TEST_NEWER_SAVE_DIR = $txSaves
    }
    Assert-True -Condition ([IO.File]::Exists($txMarker)) -Message 'Attempt A genuinely reached and failed its baseline write.'
    Assert-Equal -Actual $txResult.ExitCode -Expected 0 -Message 'The wrapper transaction completes successfully on its sole retry.'
    Assert-Equal -Actual $txResult.StdErr -Expected '' -Message 'A selected retry envelope has no terminal stderr record.'
    $txEnvelope = Invoke-InCompanionModule { param($Json) Read-TurnContextEnvelope -Json $Json -TransportOnly } @($txResult.StdOut)
    $txState = $txEnvelope.RootElement.GetProperty('state')
    Assert-OrdinalEqual -Actual $txState.GetProperty('source').GetProperty('saveFile').GetString() -Expected 's-b.zip' -Message 'Only the newer save landed mid-transaction reaches stdout.'
    Assert-OrdinalEqual -Actual $txEnvelope.RootElement.GetProperty('sourceFloor').GetProperty('saveFile').GetString() -Expected 's-b.zip' -Message 'Attempt B re-establishes its floor at the newer save.'
    Assert-True -Condition $txEnvelope.RootElement.GetProperty('baselineReset').GetBoolean() -Message 'The consumed retry is a baseline reset (attempt A never advanced the baseline).'
    Assert-False -Condition $txEnvelope.RootElement.GetProperty('cacheDegraded').GetBoolean() -Message 'The consumed retry carries no cache degradation.'
    $txBaseline = Read-DigestDocument -Path (Join-Path $txRoot 'state/baseline.json')
    Assert-OrdinalEqual -Actual $txBaseline.RootElement.GetProperty('source').GetProperty('saveFile').GetString() -Expected 's-b.zip' -Message 'The transaction settles the baseline at the newer save.'

    # Cross-process decline: a competing process holds the real consume.lock, so the
    # fresh-target attempt declines busy at the consume stage and the wrapper
    # terminates without a retry (the one-shot patch is inert without its env vars).
    $txLock = [IO.FileStream]::new((Join-Path $txRoot 'state/consume.lock'), [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    try {
        $txBusy = Invoke-BoundedPwsh -Arguments @('-File', (Join-Path $txCore 'Get-TurnContext.ps1')) -WorkingDirectory $txRoot -TimeoutMilliseconds 240000
        Assert-Equal -Actual $txBusy.ExitCode -Expected 1 -Message 'A cross-process consume-lock hold declines the turn-context attempt.'
        Assert-Equal -Actual $txBusy.StdOut -Expected '' -Message 'A busy decline emits no envelope.'
        Assert-True -Condition $txBusy.StdErr.StartsWith('[turn-context:busy] ', [StringComparison]::Ordinal) -Message 'The cross-process decline reports the busy class.'
        Assert-True -Condition $txBusy.StdErr.Contains('"lockStage":"consume"', [StringComparison]::Ordinal) -Message 'The cross-process decline carries the consume lock stage.'
        Assert-True -Condition $txBusy.StdErr.Contains('lock-timeout', [StringComparison]::Ordinal) -Message 'The cross-process decline carries the lock-timeout reason.'
    }
    finally {
        $txLock.Dispose()
    }

    Write-Output 'PASS: turn context'
    exit 0
}

# The live wrapper is an entry script and must honor the migration entry fence
# before any configuration or state work: a maintenance sentinel without the exact
# bypass token blocks it with the fixed maintenance line, like every other entry.
$fenceRoot = New-ScratchCompanionRoot -Prefix 'turn-fence'
[void] [IO.Directory]::CreateDirectory((Join-Path $fenceRoot '.tmp'))
[IO.File]::WriteAllText((Join-Path $fenceRoot '.tmp/state-extraction-v2-maintenance.json'), '{"result":"maintenance","bypassToken":"' + ('a' * 64) + '"}', [Text.UTF8Encoding]::new($false))
$fencedRun = Invoke-BoundedPwsh -Arguments @('-File', (Join-Path (Split-Path $PSScriptRoot -Parent) 'Get-TurnContext.ps1'), '-CompanionRoot', $fenceRoot) -WorkingDirectory $fenceRoot
Assert-Equal -Actual $fencedRun.ExitCode -Expected 1 -Message 'A sentinel-fenced turn-context wrapper exits 1.'
Assert-OrdinalEqual -Actual $fencedRun.StdErr.Trim() -Expected '[maintenance] state extraction maintenance is active' -Message 'A sentinel-fenced turn-context wrapper emits the fixed maintenance line before any turn-context protocol output.'

Write-Output 'PASS: turn context'
