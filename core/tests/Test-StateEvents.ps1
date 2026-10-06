#Requires -Version 7.5

[CmdletBinding()]
param(
    [Parameter()]
    [ValidateSet('All', 'Constants', 'Arguments', 'Ownership', 'RecordKinds', 'RecordValidation', 'CanonicalTokens', 'Settlement', 'Consumer', 'CommitStates', 'Reconciliation', 'VersionChange', 'ReceiptIndependence')]
    [string] $Only = 'All'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Import-Module (Join-Path $PSScriptRoot 'TestSupport.psm1') -Force
Import-Module (Join-Path $PSScriptRoot '../DigestDiff.psm1') -Force -DisableNameChecking

$script:Principal = 'S-1-5-21-1000-1001-1002-1003'
$script:EntryScripts = @('Get-TurnContext.ps1', 'Get-Diff.ps1', 'Update-CompanionState.ps1', 'Find-LastEventfulSpan.ps1', 'Publish-StateEvent.ps1', 'Set-StateEventSettlement.ps1', 'Set-CompanionConsumer.ps1')
$script:Utf8 = [Text.UTF8Encoding]::new($false, $true)

function Test-Selected {
    param([Parameter(Mandatory)] [string] $Name)

    return $Only -ceq 'All' -or $Only -ceq $Name
}

# Asserts that an action throws an exception of the named type or of a type derived from it.
function Assert-ThrowsDerived {
    param([Parameter(Mandatory)] [string] $TypeName, [Parameter(Mandatory)] [scriptblock] $Action, [Parameter(Mandatory)] [string] $Message)

    try { & $Action }
    catch {
        for ($type = $_.Exception.GetType(); $null -ne $type; $type = $type.BaseType) { if ($type.Name -ceq $TypeName) { return } }
        throw [InvalidOperationException]::new("Assertion failed: $Message threw $($_.Exception.GetType().FullName), not a $TypeName.", $_.Exception)
    }

    throw [InvalidOperationException]::new("Assertion failed: $Message did not throw.")
}

function New-StateEventFixture {
    param([Parameter(Mandatory)] [string] $Prefix)

    return New-StagedStubAcquisitionRoot -Prefix $Prefix -EntryScripts $script:EntryScripts
}

function Invoke-CoreScript {
    param([Parameter(Mandatory)] $Fixture, [Parameter(Mandatory)] [string] $Name, [string[]] $Arguments = @(), [hashtable] $Environment = @{})

    return Invoke-BoundedPwsh -Arguments (@('-File', (Join-Path $Fixture.Core $Name)) + $Arguments) -WorkingDirectory $Fixture.Root -TimeoutMilliseconds 240000 -Environment $Environment
}

function Invoke-Publish {
    param([Parameter(Mandatory)] $Fixture, [switch] $RequireRecord, [string] $RepairOperationId, [hashtable] $Environment = @{})

    $arguments = @('-Principal', $script:Principal)
    if ($RequireRecord) { $arguments += '-RequireRecord' }
    if ($RepairOperationId) { $arguments += @('-Resync', '-RepairOperationId', $RepairOperationId) }

    return Invoke-CoreScript -Fixture $Fixture -Name 'Publish-StateEvent.ps1' -Arguments $arguments -Environment $Environment
}

function Invoke-Switch {
    param([Parameter(Mandatory)] $Fixture, [Parameter(Mandatory)] [string] $Owner, [string[]] $Switches = @(), [hashtable] $Environment = @{})

    return Invoke-CoreScript -Fixture $Fixture -Name 'Set-CompanionConsumer.ps1' -Arguments (@('-Owner', $Owner) + $Switches) -Environment $Environment
}

# Parses the one terminal line of an exit-1 result and validates it with the matching reader.
function Read-TerminalLine {
    param([Parameter(Mandatory)] $Result, [Parameter(Mandatory)] [ValidateSet('Publish', 'Settlement', 'Consumer', 'TurnContext')] [string] $Script)

    Assert-Equal -Actual $Result.ExitCode -Expected 1 -Message "A terminal result exits 1 ($($Result.StdErr))"
    Assert-True -Condition $Result.StdErr.EndsWith("`n", [StringComparison]::Ordinal) -Message 'A terminal record ends with one newline.'
    $line = $Result.StdErr.Substring(0, $Result.StdErr.Length - 1)
    Assert-True -Condition ($line.IndexOfAny([char[]] "`r`n") -lt 0) -Message "A terminal record is exactly one line: $($Result.StdErr)"
    $prefix = if ($Script -ceq 'TurnContext') { '[turn-context:' } else { '[state-event:' }
    Assert-True -Condition $line.StartsWith($prefix, [StringComparison]::Ordinal) -Message "The terminal record carries the $prefix prefix: $line"
    $end = $line.IndexOf('] ', [StringComparison]::Ordinal)
    $class = $line.Substring($prefix.Length, $end - $prefix.Length)
    $json = $line.Substring($end + 2)
    $document = if ($Script -ceq 'TurnContext') { Read-TurnContextDiagnostic -Json $json -ExpectedClass $class } else { Read-StateEventDiagnostic -Json $json -ExpectedClass $class -Script $Script }

    return [pscustomobject]@{ class = $class; detail = $document.Materialized['detail']; consumptionState = $document.Materialized['consumptionState']; diagnostic = $document.Materialized }
}

function Assert-Terminal {
    param([Parameter(Mandatory)] $Result, [Parameter(Mandatory)] [string] $Script, [Parameter(Mandatory)] [string] $Class, [Parameter(Mandatory)] [string] $Detail, [string] $ConsumptionState = 'none', [Parameter(Mandatory)] [string] $Message)

    try { $terminal = Read-TerminalLine -Result $Result -Script $Script }
    catch { throw [InvalidOperationException]::new("$Message`: $($_.Exception.Message)", $_.Exception) }
    Assert-OrdinalEqual -Actual $terminal.class -Expected $Class -Message "$Message (class)"
    Assert-OrdinalEqual -Actual ([string] $terminal.detail) -Expected $Detail -Message "$Message (detail)"
    Assert-OrdinalEqual -Actual $terminal.consumptionState -Expected $ConsumptionState -Message "$Message (consumption state)"
    Assert-Equal -Actual $Result.StdOut -Expected '' -Message "$Message (no stdout)"
}

function Read-Receipt {
    param([Parameter(Mandatory)] $Result, [Parameter(Mandatory)] [string] $Message)

    Assert-Equal -Actual $Result.ExitCode -Expected 0 -Message "$Message (exit 0; stderr $($Result.StdErr))"
    Assert-Equal -Actual $Result.StdErr -Expected '' -Message "$Message (empty stderr)"

    return (Read-StateEventReceipt -Json $Result.StdOut).Materialized
}

function Get-OutboxPath { param([Parameter(Mandatory)] $Fixture) return Join-Path $Fixture.State 'outbox' }

function Get-RecordNames {
    param([Parameter(Mandatory)] $Fixture)

    $outbox = Get-OutboxPath -Fixture $Fixture
    if (-not [IO.Directory]::Exists($outbox)) { return @() }

    return @([IO.Directory]::GetFiles($outbox, 'event-*.json') | ForEach-Object { [IO.Path]::GetFileName($_) } | Sort-Object -CaseSensitive)
}

function Get-RecordInfo {
    param([Parameter(Mandatory)] $Fixture, [Parameter(Mandatory)] [string] $Name)

    $bytes = [IO.File]::ReadAllBytes((Join-Path (Get-OutboxPath -Fixture $Fixture) $Name))
    $record = Read-StateEventRecord -Bytes $bytes

    return [pscustomobject]@{ name = $Name; bytes = $bytes; sha256 = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant(); logicalOutboxId = $record.logicalOutboxId; sequence = $record.sequence; kind = $record.kind; record = $record }
}

# Gives a parsed record, its diff and its state another adapter version: structurally valid,
# rejected only by producer-mode admission under the fixture configuration.
function Set-RecordAdapterVersion {
    param([Parameter(Mandatory)] [Text.Json.Nodes.JsonNode] $Node, [long] $Version = 1)

    foreach ($document in @($Node, $Node['diff'], $Node['state'])) { $document['adapterVersion'] = [Text.Json.Nodes.JsonValue]::Create($Version) }
}

function Invoke-Settle {
    param([Parameter(Mandatory)] $Fixture, [Parameter(Mandatory)] $Info, [string] $JournalId = 'journal-a', [string] $EventId, [string] $Sha256)

    $event = if ($EventId) { $EventId } else { "event-$($Info.sequence)" }
    $sha = if ($Sha256) { $Sha256 } else { $Info.sha256 }

    return Invoke-CoreScript -Fixture $Fixture -Name 'Set-StateEventSettlement.ps1' -Arguments @('-LogicalOutboxId', $Info.logicalOutboxId, '-RecordSha256', $sha, '-JournalId', $JournalId, '-EventId', $event)
}

function Read-Ledger {
    param([Parameter(Mandatory)] $Fixture)

    return (Read-CompanionJson -Path (Join-Path (Get-OutboxPath -Fixture $Fixture) 'ledger.json') -Budget config).Materialized
}

function Get-FileHashOrNull {
    param([Parameter(Mandatory)] [string] $Path)

    if (-not [IO.File]::Exists($Path)) { return $null }

    return [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([IO.File]::ReadAllBytes($Path)))
}

# The consumed state a failing caller must leave byte-identical: baseline, current, the
# diagnostic cache, the marker, and the complete outbox tree.
function Get-ConsumedStateFingerprint {
    param([Parameter(Mandatory)] $Fixture, [switch] $SkipMarker)

    $names = @('baseline.json', 'current.json', 'diff-since-last-read.json') + @(if (-not $SkipMarker) { 'consumer.json' })
    $files = foreach ($name in $names) { "$name=$(Get-FileHashOrNull -Path (Join-Path $Fixture.State $name))" }
    $outbox = Get-TreeFingerprint -Path (Get-OutboxPath -Fixture $Fixture) | ConvertTo-Json -Depth 5 -Compress

    return ($files -join ';') + ';' + $outbox
}

function Write-Marker {
    param([Parameter(Mandatory)] $Fixture, [Parameter(Mandatory)] [AllowEmptyString()] [string] $Json)

    [void] [IO.Directory]::CreateDirectory($Fixture.State)
    [IO.File]::WriteAllText((Join-Path $Fixture.State 'consumer.json'), $Json, $script:Utf8)
}

function Get-MarkerJson {
    param([Parameter(Mandatory)] [string] $Owner, [int] $Version = 1, [string] $Extra = '')

    return '{"consumerVersion":' + $Version + ',"owner":"' + $Owner + '","changedAt":"2026-10-05T12:00:00.0000000Z"' + $Extra + '}'
}

function Read-BaselineIdentity {
    param([Parameter(Mandatory)] $Fixture)

    $baseline = Read-DigestDocument -Path (Join-Path $Fixture.State 'baseline.json')

    return $baseline.RootElement.GetProperty('generatedAt').GetString() + '|' + $baseline.RootElement.GetProperty('source').GetRawText()
}

function Add-NewerSave {
    param([Parameter(Mandatory)] $Fixture, [Parameter(Mandatory)] [string] $Name, [int] $MinutesAfterFirst = 1)

    $path = Join-Path $Fixture.Saves $Name
    [IO.File]::WriteAllText($path, "save-$Name", $script:Utf8)
    [IO.File]::SetLastWriteTimeUtc($path, [IO.File]::GetLastWriteTimeUtc($Fixture.Save).AddMinutes($MinutesAfterFirst))
}

# Inserts an env-gated self-termination immediately before the one occurrence of an anchor
# line in the staged copy of a core file, so a fixture can stop the process at an exact
# write boundary without a seam in production code.
function Set-StagedKillPoint {
    param([Parameter(Mandatory)] $Fixture, [Parameter(Mandatory)] [string] $RelativePath, [Parameter(Mandatory)] [string] $Anchor, [Parameter(Mandatory)] [string] $Name)

    $path = Join-Path $Fixture.Core $RelativePath
    $source = [IO.File]::ReadAllText($path, $script:Utf8)
    # A checkout may carry either line ending, so the anchor and the injection take the
    # file's own.
    $eol = if ($source.Contains("`r`n")) { "`r`n" } else { "`n" }
    $Anchor = $Anchor.Replace("`r`n", "`n").Replace("`n", $eol)
    Assert-Equal -Actual ([regex]::Matches($source, [regex]::Escape($Anchor)).Count) -Expected 1 -Message "Kill point '$Name' finds exactly one anchor."
    $indent = $Anchor.Substring(0, $Anchor.Length - $Anchor.TrimStart().Length)
    $injection = "$indent" + 'if ($env:COMPANION_TEST_STATE_EVENT_KILL -ceq ''' + $Name + ''') { [Diagnostics.Process]::GetCurrentProcess().Kill() }' + $eol
    [IO.File]::WriteAllText($path, $source.Replace($Anchor, $injection + $Anchor, [StringComparison]::Ordinal), $script:Utf8)
}

function Invoke-Killed {
    param([Parameter(Mandatory)] [scriptblock] $Action, [Parameter(Mandatory)] [string] $Message)

    $result = & $Action
    Assert-True -Condition ($result.ExitCode -ne 0 -and $result.ExitCode -ne 1) -Message "$Message terminates the process abnormally (exit $($result.ExitCode))."
}

function New-RuntimeFixture {
    param([Parameter(Mandatory)] [string] $Prefix)

    $fixture = New-StateEventFixture -Prefix $Prefix
    $switch = Invoke-Switch -Fixture $fixture -Owner runtime
    Assert-Equal -Actual $switch.ExitCode -Expected 0 -Message "The fixture hands ownership to the runtime ($($switch.StdErr))."

    return $fixture
}

function Invoke-InModuleAttempt {
    param([Parameter(Mandatory)] $Fixture, [hashtable] $Seams = @{}, [switch] $RequireRecord, [string] $RepairOperationId)

    return Invoke-InCompanionModule {
        param($Root, $Seams, $RequireRecord, $RepairOperationId, $Principal)
        $config = Get-AdapterConfig -CompanionRoot $Root -Adapter stub -Profile Acquisition
        try {
            $operational = New-CompanionWarningSink -Profile TurnOperational
            $receipt = New-CompanionWarningSink -Profile StateEventReceipt
            $resync = -not [string]::IsNullOrEmpty($RepairOperationId)
            $result = Invoke-StateEventAttempt -CompanionRoot $Root -AdapterConfig $config -OperationalWarnings $operational -ReceiptWarnings $receipt -Principal $Principal -RequireRecord:$RequireRecord -Resync:$resync -RepairOperationId $(if ($resync) { $RepairOperationId } else { $null }) -ConsumptionSeams $Seams

            return [pscustomobject]@{ result = $result; receiptWarnings = @($receipt.Freeze() | ForEach-Object { $_.code }) }
        }
        finally { $config.Dispose() }
    } @($Fixture.Root, $Seams, [bool] $RequireRecord, $RepairOperationId, $script:Principal)
}

# ---------------------------------------------------------------------------------
if (Test-Selected 'Constants') {
    $constants = Invoke-InCompanionModule { [pscustomobject]@{ age = $script:StateEventTombstoneMaximumAge; count = $script:StateEventTombstoneMaximumCount; pending = $script:StateEventPendingLimit; quarantine = $script:StateEventQuarantineMaximumEntries; children = $script:StateEventChildLimit; sequence = $script:StateEventSequenceMaximum; budget = (Get-CompanionJsonBudget -Budget 'state-event'); turnBudget = (Get-CompanionJsonBudget -Budget 'turn-context') } }
    Assert-Equal -Actual $constants.age -Expected ([TimeSpan]::FromDays(180)) -Message 'Tombstones older than exactly 180 days are prunable.'
    Assert-Equal -Actual $constants.count -Expected 512 -Message 'The tombstone count bound is exactly 512.'
    Assert-Equal -Actual $constants.pending -Expected 16 -Message 'The pending record bound is exactly 16.'
    Assert-Equal -Actual $constants.quarantine -Expected 64 -Message 'The quarantine keeps at most 64 entries.'
    Assert-Equal -Actual $constants.children -Expected 1024 -Message 'Reconciliation enumerates at most 1,024 children.'
    Assert-Equal -Actual $constants.sequence -Expected 9007199254740991L -Message 'Sequences end at 2^53 - 1.'
    foreach ($name in 'MaxBytes', 'MaxTokens', 'MaxTextBytes') { Assert-Equal -Actual $constants.budget.$name -Expected $constants.turnBudget.$name -Message "The state-event budget's $name equals the turn-context profile's." }
}

# ---------------------------------------------------------------------------------
if (Test-Selected 'Arguments') {
    $fixture = New-RuntimeFixture -Prefix 'state-event-arguments'
    foreach ($case in @(
            @{ Name = 'missing principal'; Arguments = @() },
            @{ Name = 'empty principal'; Arguments = @('-Principal', '') },
            @{ Name = 'control character'; Arguments = @('-Principal', "a$([char]7)b") },
            @{ Name = 'too long'; Arguments = @('-Principal', ('p' * 129)) })) {
        Assert-Terminal -Result (Invoke-CoreScript -Fixture $fixture -Name 'Publish-StateEvent.ps1' -Arguments $case.Arguments) -Script Publish -Class config -Detail principal-invalid -Message "Publish rejects a $($case.Name)"
    }
    foreach ($case in @(
            @{ Name = 'resync without operation'; Arguments = @('-Principal', $script:Principal, '-Resync') },
            @{ Name = 'operation without resync'; Arguments = @('-Principal', $script:Principal, '-RepairOperationId', 'jr-1') },
            @{ Name = 'resync with require-record'; Arguments = @('-Principal', $script:Principal, '-Resync', '-RepairOperationId', 'jr-1', '-RequireRecord') },
            @{ Name = 'invalid operation token'; Arguments = @('-Principal', $script:Principal, '-Resync', '-RepairOperationId', "j$([char]0x85)r") })) {
        Assert-Terminal -Result (Invoke-CoreScript -Fixture $fixture -Name 'Publish-StateEvent.ps1' -Arguments $case.Arguments) -Script Publish -Class config -Detail repair-operation-invalid -Message "Publish rejects $($case.Name)"
    }
    # The entry fence resolves the root first, so a relative root that names no directory ends
    # at the fence; one that resolves to the fixture root passes it and is then rejected.
    Assert-Terminal -Result (Invoke-CoreScript -Fixture $fixture -Name 'Publish-StateEvent.ps1' -Arguments @('-Principal', $script:Principal, '-CompanionRoot', '.')) -Script Publish -Class config -Detail companion-root-invalid -Message 'Publish rejects a relative companion root'
    Assert-Terminal -Result (Invoke-CoreScript -Fixture $fixture -Name 'Set-StateEventSettlement.ps1' -Arguments @('-CompanionRoot', '.', '-LogicalOutboxId', ('0' * 32 + '-1'), '-RecordSha256', ('a' * 64), '-JournalId', 'j', '-EventId', 'e')) -Script Settlement -Class config -Detail companion-root-invalid -Message 'Settlement rejects a relative companion root'
    Assert-Terminal -Result (Invoke-CoreScript -Fixture $fixture -Name 'Set-CompanionConsumer.ps1' -Arguments @('-CompanionRoot', '.', '-Owner', 'bridge')) -Script Consumer -Class config -Detail companion-root-invalid -Message 'The switch rejects a relative companion root'
    foreach ($case in @(
            @{ Name = 'malformed identifier'; Arguments = @('-LogicalOutboxId', 'abc-1', '-RecordSha256', ('a' * 64), '-JournalId', 'j', '-EventId', 'e') },
            @{ Name = 'sequence zero'; Arguments = @('-LogicalOutboxId', ('0' * 32 + '-0'), '-RecordSha256', ('a' * 64), '-JournalId', 'j', '-EventId', 'e') },
            @{ Name = 'uppercase hash'; Arguments = @('-LogicalOutboxId', ('0' * 32 + '-1'), '-RecordSha256', ('A' * 64), '-JournalId', 'j', '-EventId', 'e') },
            @{ Name = 'identifier with a trailing line feed'; Arguments = @('-LogicalOutboxId', ('0' * 32 + "-1`n"), '-RecordSha256', ('a' * 64), '-JournalId', 'j', '-EventId', 'e') },
            @{ Name = 'hash with a trailing line feed'; Arguments = @('-LogicalOutboxId', ('0' * 32 + '-1'), '-RecordSha256', (('a' * 64) + "`n"), '-JournalId', 'j', '-EventId', 'e') },
            @{ Name = 'missing event'; Arguments = @('-LogicalOutboxId', ('0' * 32 + '-1'), '-RecordSha256', ('a' * 64), '-JournalId', 'j') })) {
        Assert-Terminal -Result (Invoke-CoreScript -Fixture $fixture -Name 'Set-StateEventSettlement.ps1' -Arguments $case.Arguments) -Script Settlement -Class config -Detail settlement-argument-invalid -Message "Settlement rejects a $($case.Name)"
    }
    foreach ($owner in @('', 'Bridge', 'other')) {
        $arguments = @(if ($owner) { '-Owner'; $owner })
        Assert-Terminal -Result (Invoke-CoreScript -Fixture $fixture -Name 'Set-CompanionConsumer.ps1' -Arguments $arguments) -Script Consumer -Class config -Detail owner-argument-invalid -Message "The switch rejects owner '$owner'"
    }
    foreach ($switches in @(@('-Owner', 'bridge', '-DeliveryConfirmed', '-AbandonUndelivered'), @('-Owner', 'runtime', '-DeliveryConfirmed'), @('-Owner', 'runtime', '-AbandonUndelivered'))) {
        Assert-Terminal -Result (Invoke-CoreScript -Fixture $fixture -Name 'Set-CompanionConsumer.ps1' -Arguments $switches) -Script Consumer -Class config -Detail release-switch-invalid -Message "The switch rejects $($switches -join ' ')"
    }
    [IO.File]::WriteAllText((Join-Path $fixture.Root '.tmp/state-extraction-v2-maintenance.json'), '{"result":"maintenance","bypassToken":"' + ('a' * 64) + '"}', [Text.UTF8Encoding]::new($false))
    foreach ($name in 'Publish-StateEvent.ps1', 'Set-StateEventSettlement.ps1', 'Set-CompanionConsumer.ps1') {
        $fenced = Invoke-CoreScript -Fixture $fixture -Name $name -Arguments @()
        Assert-Equal -Actual $fenced.ExitCode -Expected 1 -Message "$name is fenced by a maintenance sentinel."
        Assert-OrdinalEqual -Actual $fenced.StdErr.Trim() -Expected '[maintenance] state extraction maintenance is active' -Message "$name emits the fixed maintenance line."
    }

    # A corrupt validator package keeps its 7.5 configuration reason through the publisher, and
    # the refusal comes before any consumed state changes; other resolution failures stay
    # adapter-resolution-failed.
    $releaseFixture = New-RuntimeFixture -Prefix 'state-event-release-corrupt'
    $validatorPath = Join-Path $releaseFixture.Adapter 'releases/2/schema-2/adapters/stub/Validate-Digest.psm1'
    foreach ($case in @(
            @{ Name = 'a validator that cannot be imported'; Module = 'function Assert-AdapterDigestSemantics { ' },
            @{ Name = 'a validator missing its export'; Module = "function SomethingElse { }`nExport-ModuleMember -Function SomethingElse`n" },
            @{ Name = 'a validator with an extra export'; Module = "function Assert-AdapterDigestSemantics { param([Parameter(Mandatory)] [object] `$Document) }`nfunction Extra { }`nExport-ModuleMember -Function Assert-AdapterDigestSemantics, Extra`n" })) {
        [IO.File]::WriteAllText($validatorPath, $case.Module, $script:Utf8)
        $before = Get-ConsumedStateFingerprint -Fixture $releaseFixture
        Assert-Terminal -Result (Invoke-Publish -Fixture $releaseFixture) -Script Publish -Class config -Detail adapter-release-corrupt -Message "Publish with $($case.Name)"
        Assert-OrdinalEqual -Actual (Get-ConsumedStateFingerprint -Fixture $releaseFixture) -Expected $before -Message "A publish refused for $($case.Name) mutates nothing."
    }
    [IO.File]::WriteAllText((Join-Path $releaseFixture.Adapter 'adapter.json'), '{', $script:Utf8)
    Assert-Terminal -Result (Invoke-Publish -Fixture $releaseFixture) -Script Publish -Class config -Detail adapter-resolution-failed -Message 'Publish with an unparseable adapter.json'
}

# ---------------------------------------------------------------------------------
if (Test-Selected 'Ownership') {
    $markers = [ordered]@{
        absent = $null
        'valid-bridge' = (Get-MarkerJson -Owner bridge)
        'valid-runtime' = (Get-MarkerJson -Owner runtime)
        unparseable = '{"consumerVersion":1,'
        'zero-byte' = ''
        'extra-field' = (Get-MarkerJson -Owner runtime -Extra ',"note":"x"')
        'wrong-version' = (Get-MarkerJson -Owner runtime -Version 2)
        'unknown-owner' = (Get-MarkerJson -Owner agent)
        'held-open' = (Get-MarkerJson -Owner runtime)
    }
    foreach ($markerName in $markers.Keys) {
        foreach ($withRecord in $false, $true) {
            $fixture = New-StateEventFixture -Prefix 'state-event-ownership'
            # An older second save gives the walk a pair to evaluate.
            $olderSave = Join-Path $fixture.Saves 's-0.zip'
            [IO.File]::WriteAllText($olderSave, 'save-0', $script:Utf8)
            [IO.File]::SetLastWriteTimeUtc($olderSave, [IO.File]::GetLastWriteTimeUtc($fixture.Save).AddMinutes(-2))
            $oneShot = Invoke-CoreScript -Fixture $fixture -Name 'Update-CompanionState.ps1'
            Assert-Equal -Actual $oneShot.ExitCode -Expected 0 -Message "The ownership fixture publishes current state ($($oneShot.StdErr))."
            if ($withRecord) {
                Write-Marker -Fixture $fixture -Json (Get-MarkerJson -Owner runtime)
                [void] (Read-Receipt -Result (Invoke-Publish -Fixture $fixture -RequireRecord) -Message 'The ownership fixture commits one record')
            }
            $consumerPath = Join-Path $fixture.State 'consumer.json'
            if ($null -eq $markers[$markerName]) { if ([IO.File]::Exists($consumerPath)) { [IO.File]::Delete($consumerPath) } } else { Write-Marker -Fixture $fixture -Json $markers[$markerName] }
            $lock = if ($markerName -ceq 'held-open') { [IO.FileStream]::new($consumerPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::None) } else { $null }
            try {
                $bridgeReason = switch ($markerName) {
                    { $_ -cin @('absent', 'valid-bridge') } { if ($withRecord) { 'consumer-outbox-pending' } else { $null } }
                    'valid-runtime' { 'consumer-not-owner' }
                    'held-open' { 'consumer-owner-unreadable' }
                    default { 'consumer-owner-invalid' }
                }
                $runtimeReason = switch ($markerName) {
                    'valid-runtime' { $null }
                    { $_ -cin @('absent', 'valid-bridge') } { 'consumer-not-owner' }
                    'held-open' { 'consumer-owner-unreadable' }
                    default { 'consumer-owner-invalid' }
                }
                $label = "$markerName marker, $(if ($withRecord) { 'one record' } else { 'empty outbox' })"
                foreach ($nonConsuming in @(@{ Name = 'Get-Diff.ps1'; Arguments = @('-Peek') }, @{ Name = 'Update-CompanionState.ps1'; Arguments = @() }, @{ Name = 'Find-LastEventfulSpan.ps1'; Arguments = @() })) {
                    $run = Invoke-CoreScript -Fixture $fixture -Name $nonConsuming.Name -Arguments $nonConsuming.Arguments
                    Assert-Equal -Actual $run.ExitCode -Expected 0 -Message "$($nonConsuming.Name) $($nonConsuming.Arguments -join ' ') is not gated by ownership ($label; $($run.StdErr))."
                }
                if ($null -ne $runtimeReason) {
                    $before = Get-ConsumedStateFingerprint -Fixture $fixture -SkipMarker:($markerName -ceq 'held-open')
                    Assert-Terminal -Result (Invoke-Publish -Fixture $fixture) -Script Publish -Class config -Detail $runtimeReason -Message "Publish under $label"
                    Assert-OrdinalEqual -Actual (Get-ConsumedStateFingerprint -Fixture $fixture -SkipMarker:($markerName -ceq 'held-open')) -Expected $before -Message "A refused publish under $label mutates nothing."
                }
                if ($null -ne $bridgeReason) {
                    $before = Get-ConsumedStateFingerprint -Fixture $fixture -SkipMarker:($markerName -ceq 'held-open')
                    $getDiff = Invoke-CoreScript -Fixture $fixture -Name 'Get-Diff.ps1'
                    Assert-Equal -Actual $getDiff.ExitCode -Expected 1 -Message "Consuming Get-Diff fails under $label."
                    Assert-OrdinalEqual -Actual $getDiff.StdErr.Trim() -Expected "get-diff: [config] $bridgeReason" -Message "Consuming Get-Diff reports the ownership reason under $label."
                    Assert-Equal -Actual $getDiff.StdOut -Expected '' -Message "Consuming Get-Diff emits no payload under $label."
                    Assert-Terminal -Result (Invoke-CoreScript -Fixture $fixture -Name 'Get-TurnContext.ps1') -Script TurnContext -Class config -Detail $bridgeReason -Message "Get-TurnContext under $label"
                    Assert-OrdinalEqual -Actual (Get-ConsumedStateFingerprint -Fixture $fixture -SkipMarker:($markerName -ceq 'held-open')) -Expected $before -Message "A refused bridge read under $label mutates nothing."
                }
                if ($null -eq $runtimeReason) {
                    [void] (Read-Receipt -Result (Invoke-Publish -Fixture $fixture) -Message "Publish proceeds under $label")
                }
                if ($null -eq $bridgeReason) {
                    $turn = Invoke-CoreScript -Fixture $fixture -Name 'Get-TurnContext.ps1'
                    Assert-Equal -Actual $turn.ExitCode -Expected 0 -Message "Get-TurnContext proceeds under $label ($($turn.StdErr))."
                    $getDiff = Invoke-CoreScript -Fixture $fixture -Name 'Get-Diff.ps1'
                    Assert-Equal -Actual $getDiff.ExitCode -Expected 0 -Message "Consuming Get-Diff proceeds under $label ($($getDiff.StdErr))."
                }
            }
            finally {
                if ($null -ne $lock) { $lock.Dispose() }
            }
        }
    }

    # With current state stale, each refreshing wrapper's advisory preflight refuses a
    # non-owner before any refresh work: current state, the cache and the bookkeeping keep
    # their bytes, so no pipeline cycle ran.
    $refreshState = {
        param($Fixture)
        (@('current.json', 'diff-since-last-read.json', 'last-processed.json') | ForEach-Object { "$_=$(Get-FileHashOrNull -Path (Join-Path $Fixture.State $_))" }) -join ';'
    }
    foreach ($case in @(@{ Script = 'Publish'; Marker = $null }, @{ Script = 'Publish'; Marker = (Get-MarkerJson -Owner bridge) }, @{ Script = 'TurnContext'; Marker = (Get-MarkerJson -Owner runtime) })) {
        $staleFixture = New-StateEventFixture -Prefix 'state-event-ownership-stale'
        $oneShot = Invoke-CoreScript -Fixture $staleFixture -Name 'Update-CompanionState.ps1'
        Assert-Equal -Actual $oneShot.ExitCode -Expected 0 -Message "The stale-current fixture publishes current state ($($oneShot.StdErr))."
        if ($null -ne $case.Marker) { Write-Marker -Fixture $staleFixture -Json $case.Marker }
        Add-NewerSave -Fixture $staleFixture -Name 's-b.zip'
        $refreshBefore = & $refreshState $staleFixture
        $consumedBefore = Get-ConsumedStateFingerprint -Fixture $staleFixture
        $refused = if ($case.Script -ceq 'Publish') { Invoke-Publish -Fixture $staleFixture } else { Invoke-CoreScript -Fixture $staleFixture -Name 'Get-TurnContext.ps1' }
        Assert-Terminal -Result $refused -Script $case.Script -Class config -Detail consumer-not-owner -Message "A $($case.Script) preflight refusal with stale current state"
        Assert-OrdinalEqual -Actual (& $refreshState $staleFixture) -Expected $refreshBefore -Message "A $($case.Script) preflight refusal runs no refresh."
        Assert-OrdinalEqual -Actual (Get-ConsumedStateFingerprint -Fixture $staleFixture) -Expected $consumedBefore -Message "A $($case.Script) preflight refusal mutates no consumed state."
    }

    # An acquisition failure never masks the consumer reason: a non-owning publish with no
    # matching save still reports it.
    $noSaves = New-StateEventFixture -Prefix 'state-event-ownership-nosaves'
    foreach ($save in [IO.Directory]::GetFiles($noSaves.Saves)) { [IO.File]::Delete($save) }
    Assert-Terminal -Result (Invoke-Publish -Fixture $noSaves) -Script Publish -Class config -Detail consumer-not-owner -Message 'A non-owning publish with no matching save'

    # Consuming Get-Diff has no refresh to protect: a missing current state is reported before
    # any ownership result.
    $missingCurrent = New-StateEventFixture -Prefix 'state-event-ownership-getdiff'
    Write-Marker -Fixture $missingCurrent -Json (Get-MarkerJson -Owner runtime)
    $getDiff = Invoke-CoreScript -Fixture $missingCurrent -Name 'Get-Diff.ps1'
    Assert-Equal -Actual $getDiff.ExitCode -Expected 1 -Message 'Consuming Get-Diff fails with no current state under a runtime marker.'
    Assert-OrdinalEqual -Actual $getDiff.StdErr.Trim() -Expected 'get-diff: [missing-current] run-update-companion-state' -Message 'Consuming Get-Diff reports the missing current state before ownership.'

    # An attempt that runs past the preflight, as after a hand-over between preflight and lock,
    # may refresh but refuses at the locked check with the consumption state untouched.
    $overtaken = New-StateEventFixture -Prefix 'state-event-ownership-overtaken'
    $oneShot = Invoke-CoreScript -Fixture $overtaken -Name 'Update-CompanionState.ps1'
    Assert-Equal -Actual $oneShot.ExitCode -Expected 0 -Message "The overtaken-preflight fixture publishes current state ($($oneShot.StdErr))."
    Write-Marker -Fixture $overtaken -Json (Get-MarkerJson -Owner bridge)
    Add-NewerSave -Fixture $overtaken -Name 's-b.zip'
    $consumption = {
        param($Fixture)
        (@('baseline.json', 'consumer.json') | ForEach-Object { "$_=$(Get-FileHashOrNull -Path (Join-Path $Fixture.State $_))" }) -join ';'
    }
    $consumptionBefore = (& $consumption $overtaken) + ';' + (Get-TreeFingerprint -Path (Get-OutboxPath -Fixture $overtaken) | ConvertTo-Json -Depth 5 -Compress)
    $pastPreflight = Invoke-InModuleAttempt -Fixture $overtaken
    Assert-OrdinalEqual -Actual ([string] $pastPreflight.result.outcomeClass + '/' + [string] $pastPreflight.result.reason) -Expected 'config/consumer-not-owner' -Message 'An attempt past the preflight refuses at the locked check.'
    Assert-OrdinalEqual -Actual ((& $consumption $overtaken) + ';' + (Get-TreeFingerprint -Path (Get-OutboxPath -Fixture $overtaken) | ConvertTo-Json -Depth 5 -Compress)) -Expected $consumptionBefore -Message 'The locked refusal leaves baseline, marker, and outbox untouched.'
}

# ---------------------------------------------------------------------------------
if (Test-Selected 'RecordKinds') {
    $fixture = New-RuntimeFixture -Prefix 'state-event-kinds'
    $first = Read-Receipt -Result (Invoke-Publish -Fixture $fixture) -Message 'The first publish without a baseline commits'
    Assert-OrdinalEqual -Actual $first['outcome'] -Expected 'committed' -Message 'An absent baseline commits a record.'
    Assert-OrdinalEqual -Actual $first['kind'] -Expected 'consumed' -Message 'An absent baseline commits a consumed record.'
    Assert-Equal -Actual $first['schemaVersion'] -Expected 2L -Message 'A receipt reports the running schema version.'
    Assert-Equal -Actual $first['adapterVersion'] -Expected 2L -Message 'A receipt reports the held adapter version.'
    Assert-OrdinalEqual -Actual $first['game'] -Expected 'stubgame' -Message 'A receipt reports the held game.'
    Assert-True -Condition $first['baselineApplied'] -Message 'The commit applied the baseline.'
    $firstInfo = Get-RecordInfo -Fixture $fixture -Name @(Get-RecordNames -Fixture $fixture)[0]
    Assert-True -Condition $firstInfo.record.document.RootElement.GetProperty('baselineReset').GetBoolean() -Message 'An absent baseline is a baseline reset.'
    Assert-True -Condition ($firstInfo.record.document.RootElement.GetProperty('baseline').ValueKind -eq [Text.Json.JsonValueKind]::Null) -Message 'An absent baseline records a null baseline identity.'

    $unchanged = Read-Receipt -Result (Invoke-Publish -Fixture $fixture) -Message 'An unchanged target'
    Assert-OrdinalEqual -Actual $unchanged['outcome'] -Expected 'unchanged' -Message 'An unchanged target reports unchanged.'
    Assert-Equal -Actual @(Get-RecordNames -Fixture $fixture).Count -Expected 1 -Message 'An unchanged target writes no record.'
    Assert-OrdinalEqual -Actual ([string] $unchanged['target']['generatedAt']) -Expected $first['target']['generatedAt'] -Message 'An unchanged receipt names the baseline target.'

    $baselinePath = Join-Path $fixture.State 'baseline.json'
    $baselineBytes = [IO.File]::ReadAllBytes($baselinePath)
    $baselineTime = [IO.File]::GetLastWriteTimeUtc($baselinePath)
    $snapshot = Read-Receipt -Result (Invoke-Publish -Fixture $fixture -RequireRecord) -Message 'A required record on an unchanged target'
    Assert-OrdinalEqual -Actual $snapshot['kind'] -Expected 'snapshot' -Message 'A required record on an unchanged target is a snapshot.'
    Assert-True -Condition ([Linq.Enumerable]::SequenceEqual[byte]($baselineBytes, [IO.File]::ReadAllBytes($baselinePath))) -Message 'A snapshot leaves the baseline bytes unchanged.'
    Assert-Equal -Actual ([IO.File]::GetLastWriteTimeUtc($baselinePath)) -Expected $baselineTime -Message 'A snapshot leaves the baseline write time unchanged.'

    # With a record pending, reconciliation restores a damaged baseline from it; settle both
    # so the content-invalid baseline reaches the publish itself.
    foreach ($name in @(Get-RecordNames -Fixture $fixture)) { [void] (Read-StateEventSettlementResult -Json (Invoke-Settle -Fixture $fixture -Info (Get-RecordInfo -Fixture $fixture -Name $name)).StdOut) }
    $restoreFixture = New-RuntimeFixture -Prefix 'state-event-kinds-restore'
    [void] (Read-Receipt -Result (Invoke-Publish -Fixture $restoreFixture) -Message 'Restore fixture record')
    $restorePath = Join-Path $restoreFixture.State 'baseline.json'
    $restoreBytes = [IO.File]::ReadAllBytes($restorePath)
    [IO.File]::WriteAllText($restorePath, '{"not":"a digest"}', $script:Utf8)
    $restored = Read-Receipt -Result (Invoke-Publish -Fixture $restoreFixture) -Message 'A damaged baseline beside a pending record'
    Assert-OrdinalEqual -Actual $restored['outcome'] -Expected 'unchanged' -Message 'Reconciliation restores a damaged baseline from the pending record.'
    Assert-True -Condition ([Linq.Enumerable]::SequenceEqual[byte]($restoreBytes, [IO.File]::ReadAllBytes($restorePath))) -Message 'The restored baseline is the record state.'
    [IO.File]::WriteAllText($baselinePath, '{"not":"a digest"}', $script:Utf8)
    $invalidBaseline = Read-Receipt -Result (Invoke-Publish -Fixture $fixture) -Message 'A content-invalid baseline'
    Assert-OrdinalEqual -Actual $invalidBaseline['kind'] -Expected 'consumed' -Message 'A content-invalid baseline commits a consumed record.'
    $invalidInfo = Get-RecordInfo -Fixture $fixture -Name @(Get-RecordNames -Fixture $fixture)[-1]
    Assert-True -Condition $invalidInfo.record.document.RootElement.GetProperty('baselineReset').GetBoolean() -Message 'A content-invalid baseline is a baseline reset.'

    Add-NewerSave -Fixture $fixture -Name 's-b.zip'
    $changed = Read-Receipt -Result (Invoke-Publish -Fixture $fixture) -Message 'A changed target'
    Assert-OrdinalEqual -Actual $changed['kind'] -Expected 'consumed' -Message 'A changed target commits a consumed record.'
    $changedInfo = Get-RecordInfo -Fixture $fixture -Name @(Get-RecordNames -Fixture $fixture)[-1]
    Assert-False -Condition $changedInfo.record.document.RootElement.GetProperty('baselineReset').GetBoolean() -Message 'A changed target with a valid baseline is not a reset.'
    Assert-OrdinalEqual -Actual $changedInfo.record.state.RootElement.GetProperty('source').GetProperty('saveFile').GetString() -Expected 's-b.zip' -Message 'The changed record targets the newer save.'

    $resync = Read-Receipt -Result (Invoke-Publish -Fixture $fixture -RepairOperationId 'jr-kinds') -Message 'A resync'
    Assert-OrdinalEqual -Actual $resync['kind'] -Expected 'resync' -Message 'A resync commits a resync record.'
    $replayPending = Read-Receipt -Result (Invoke-Publish -Fixture $fixture -RepairOperationId 'jr-kinds') -Message 'A repeated resync while pending'
    Assert-OrdinalEqual -Actual $replayPending['outcome'] -Expected 'replayed' -Message 'A repeated resync while its record is pending is replayed.'
    Assert-OrdinalEqual -Actual $replayPending['logicalOutboxId'] -Expected $resync['logicalOutboxId'] -Message 'A replay names the original record.'
    foreach ($name in Get-RecordNames -Fixture $fixture) {
        $info = Get-RecordInfo -Fixture $fixture -Name $name
        Invoke-InCompanionModule {
            param($Root, $Bytes, $Sequence)
            $config = Get-AdapterConfig -CompanionRoot $Root -Adapter stub -Profile Acquisition
            try { [void] (Read-StateEventRecord -Bytes $Bytes -Mode Producer -AdapterConfig $config -ExpectedSequence $Sequence) } finally { $config.Dispose() }
        } @($fixture.Root, $info.bytes, $info.sequence)
        $settlement = Invoke-Settle -Fixture $fixture -Info $info
        Assert-Equal -Actual $settlement.ExitCode -Expected 0 -Message "Settling $name succeeds ($($settlement.StdErr))."
        [void] (Read-StateEventSettlementResult -Json $settlement.StdOut)
    }
    $replaySettled = Read-Receipt -Result (Invoke-Publish -Fixture $fixture -RepairOperationId 'jr-kinds') -Message 'A repeated resync after settlement'
    Assert-OrdinalEqual -Actual $replaySettled['outcome'] -Expected 'replayed' -Message 'A repeated resync after its tombstone is written is replayed.'
    Assert-Equal -Actual @(Get-RecordNames -Fixture $fixture).Count -Expected 0 -Message 'Settled records leave the outbox.'

    $current = Read-DigestDocument -Path (Join-Path $fixture.State 'current.json')
    $newer = $current.RootElement.GetRawText().Replace($current.RootElement.GetProperty('source').GetProperty('savedAt').GetString(), [DateTime]::UtcNow.AddHours(1).ToString('o', [Globalization.CultureInfo]::InvariantCulture))
    [IO.File]::WriteAllText($baselinePath, $newer, $script:Utf8)
    foreach ($mode in @(@{ Name = 'plain' }, @{ Name = 'require-record'; RequireRecord = $true }, @{ Name = 'resync'; Op = 'jr-stale' })) {
        $before = Get-ConsumedStateFingerprint -Fixture $fixture
        $stale = if ($mode.ContainsKey('Op')) { Invoke-Publish -Fixture $fixture -RepairOperationId $mode.Op } elseif ($mode.ContainsKey('RequireRecord')) { Invoke-Publish -Fixture $fixture -RequireRecord } else { Invoke-Publish -Fixture $fixture }
        Assert-Terminal -Result $stale -Script Publish -Class stale-target -Detail target-precedes-baseline -Message "A target older than the baseline in $($mode.Name) mode"
        Assert-OrdinalEqual -Actual (Get-ConsumedStateFingerprint -Fixture $fixture) -Expected $before -Message "A stale target in $($mode.Name) mode mutates nothing."
    }
}

# ---------------------------------------------------------------------------------
if (Test-Selected 'RecordValidation') {
    $fixture = New-RuntimeFixture -Prefix 'state-event-validation'
    [void] (Read-Receipt -Result (Invoke-Publish -Fixture $fixture) -Message 'The validation fixture commits a consumed record')
    [void] (Read-Receipt -Result (Invoke-Publish -Fixture $fixture -RequireRecord) -Message 'The validation fixture commits a snapshot')
    $names = @(Get-RecordNames -Fixture $fixture)
    $consumed = Get-RecordInfo -Fixture $fixture -Name $names[0]
    $snapshot = Get-RecordInfo -Fixture $fixture -Name $names[1]
    $reject = {
        param([string] $Json, [string] $Message, [long] $Sequence = 0)
        Assert-ThrowsDerived -TypeName 'CompanionContentException' -Action { [void] (Read-StateEventRecord -Json $Json -ExpectedSequence $Sequence) } -Message $Message
    }
    $mutate = {
        param([byte[]] $Bytes, [scriptblock] $Change)
        $node = [Text.Json.Nodes.JsonNode]::Parse($script:Utf8.GetString($Bytes))
        & $Change $node
        $node.ToJsonString()
    }
    foreach ($field in 'stateEventVersion', 'logicalOutboxId', 'incarnationId', 'sequence', 'kind', 'createdAt', 'principal', 'repairOperationId', 'adapterVersion', 'game', 'baseline', 'sourceFloor', 'refresh', 'warnings', 'baselineReset', 'diff', 'state') {
        & $reject (& $mutate $consumed.bytes { param($Node) [void] $Node.AsObject().Remove($field) }.GetNewClosure()) "Removing $field"
        & $reject (& $mutate $consumed.bytes { param($Node) $Node[$field] = [Text.Json.Nodes.JsonValue]::Create(@{ wrong = 1 }.Count + 0.5) }.GetNewClosure()) "Mistyping $field"
    }
    & $reject (& $mutate $consumed.bytes { param($Node) $Node['extra'] = [Text.Json.Nodes.JsonValue]::Create(1) }) 'An extra root field'
    & $reject (& $mutate $consumed.bytes { param($Node) $Node['stateEventVersion'] = [Text.Json.Nodes.JsonValue]::Create(2) }) 'Another record version'
    & $reject (& $mutate $consumed.bytes { param($Node) $Node['logicalOutboxId'] = [Text.Json.Nodes.JsonValue]::Create(('f' * 32) + '-1') }) 'A logical identifier from another incarnation'
    # The identifier is recomposed from the malformed incarnation, so only the incarnation
    # grammar can reject the record.
    & $reject (& $mutate $consumed.bytes { param($Node) $incarnation = $Node['incarnationId'].GetValue[string]() + "`n"; $Node['incarnationId'] = [Text.Json.Nodes.JsonValue]::Create($incarnation); $Node['logicalOutboxId'] = [Text.Json.Nodes.JsonValue]::Create($incarnation + '-' + $Node['sequence'].GetValue[long]()) }) 'An incarnation with a trailing line feed'
    $hex = 'a' * 32
    Assert-True -Condition (Test-StateEventLogicalOutboxIdText -Value "$hex-1") -Message 'A canonical logical identifier passes its grammar.'
    foreach ($text in "$hex-1`n", "$hex`n-1") { Assert-False -Condition (Test-StateEventLogicalOutboxIdText -Value $text) -Message 'A logical identifier with a line feed fails its grammar.' }
    Assert-True -Condition (Test-StateEventSha256Text -Value ('a' * 64)) -Message 'A lowercase SHA-256 passes its grammar.'
    foreach ($text in (('a' * 64) + "`n"), ('A' * 64)) { Assert-False -Condition (Test-StateEventSha256Text -Value $text) -Message 'A SHA-256 with a line feed or an uppercase digit fails its grammar.' }
    & $reject (& $mutate $consumed.bytes { param($Node) $Node['kind'] = [Text.Json.Nodes.JsonValue]::Create('other') }) 'An unknown kind'
    & $reject (& $mutate $consumed.bytes { param($Node) $Node['repairOperationId'] = [Text.Json.Nodes.JsonValue]::Create('jr-x') }) 'A repair operation on a consumed record'
    & $reject (& $mutate $consumed.bytes { param($Node) $Node['baselineReset'] = [Text.Json.Nodes.JsonValue]::Create($false) }) 'A reset flag that disagrees with the baseline'
    & $reject (& $mutate $consumed.bytes { param($Node) $Node['kind'] = [Text.Json.Nodes.JsonValue]::Create('resync') }) 'A resync without a repair operation'
    & $reject (& $mutate $consumed.bytes { param($Node) $Node['kind'] = [Text.Json.Nodes.JsonValue]::Create('snapshot') }) 'A snapshot without a baseline identity'
    & $reject (& $mutate $snapshot.bytes { param($Node) $Node['kind'] = [Text.Json.Nodes.JsonValue]::Create('consumed') }) 'A consumed record whose baseline equals its target'
    & $reject (& $mutate $snapshot.bytes { param($Node) $Node['kind'] = [Text.Json.Nodes.JsonValue]::Create('resync'); $Node['repairOperationId'] = [Text.Json.Nodes.JsonValue]::Create('jr-x') }) 'A resync with a baseline identity'
    & $reject (& $mutate $consumed.bytes { param($Node) $Node['warnings'] = [Text.Json.Nodes.JsonNode]::Parse('[{"code":"consume-cache-fallback","detail":null}]') }) 'A record carrying the cache fallback warning'
    & $reject (& $mutate $consumed.bytes { param($Node) $Node['principal'] = [Text.Json.Nodes.JsonValue]::Create("p$([char]0x9F)") }) 'A principal with a C1 control character'
    & $reject (& $mutate $consumed.bytes { param($Node) $Node['sourceFloor']['savedAt'] = [Text.Json.Nodes.JsonValue]::Create('2099-01-01T00:00:00.0000000Z') }) 'A state below its source floor'
    & $reject $script:Utf8.GetString($consumed.bytes) 'A sequence that disagrees with the file name' 99
    $duplicate = $script:Utf8.GetString($consumed.bytes).Replace('{"stateEventVersion":1,', '{"stateEventVersion":1,"stateEventVersion":1,')
    & $reject $duplicate 'A duplicate property name'
    Assert-ThrowsDerived -TypeName 'CompanionContentException' -Action { [void] (Read-StateEventRecord -Bytes ([byte[]] @(0xEF, 0xBB, 0xBF) + $consumed.bytes)) } -Message 'A byte order mark'
    $deep = '{"a":' * 70 + '1' + '}' * 70
    Assert-ThrowsDerived -TypeName 'CompanionContentException' -Action { [void] (Read-StateEventRecord -Json $deep) } -Message 'Depth 70'
    [void] (Read-StateEventRecord -Bytes $consumed.bytes -ExpectedSequence $consumed.sequence)
    [void] (Read-StateEventRecord -Bytes $snapshot.bytes -ExpectedSequence $snapshot.sequence)

    # Producer mode admits the record under the held configuration; a miscased mode is refused
    # at binding instead of silently validating structurally.
    $foreign = & $mutate $consumed.bytes { param($Node) Set-RecordAdapterVersion -Node $Node }
    $config = Get-AdapterConfig -CompanionRoot $fixture.Root -Adapter stub -Profile Acquisition
    try {
        [void] (Read-StateEventRecord -Json $foreign -Mode Structural -AdapterConfig $config)
        Assert-ThrowsDerived -TypeName 'AdapterDigestValidationException' -Action { [void] (Read-StateEventRecord -Json $foreign -Mode Producer -AdapterConfig $config) } -Message 'Producer mode under another adapter version'
        foreach ($mode in 'producer', 'PRODUCER', 'structural') { Assert-ThrowsDerived -TypeName 'ParameterBindingException' -Action { [void] (Read-StateEventRecord -Json $foreign -Mode $mode -AdapterConfig $config) } -Message "The miscased mode $mode" }
    }
    finally { $config.Dispose() }
    Assert-ThrowsDerived -TypeName 'ArgumentException' -Action { [void] (Read-StateEventRecord -Json $foreign -Mode Producer) } -Message 'Producer mode without an adapter configuration'
}

# ---------------------------------------------------------------------------------
if (Test-Selected 'CanonicalTokens') {
    # Every closed-token parameter of the 7.6 code is case-sensitive, so a miscased token is
    # refused at binding rather than reaching a case-sensitive branch it then misses.
    $tokens = $null
    $parseErrors = $null
    $ast = [Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot '../private/StateEvents.ps1'), [ref] $tokens, [ref] $parseErrors)
    Assert-Equal -Actual $parseErrors.Count -Expected 0 -Message 'StateEvents.ps1 parses.'
    $sets = @($ast.FindAll({ param($Node) $Node -is [Management.Automation.Language.AttributeAst] -and $Node.TypeName.Name -ceq 'ValidateSet' }, $true))
    Assert-True -Condition ($sets.Count -gt 0) -Message 'StateEvents.ps1 declares closed-token parameters.'
    foreach ($set in $sets) {
        $ignoreCase = @($set.NamedArguments | Where-Object { $_.ArgumentName -ceq 'IgnoreCase' })
        Assert-True -Condition ($ignoreCase.Count -eq 1 -and $ignoreCase[0].Argument.Extent.Text -ceq '$false') -Message "The closed-token set at line $($set.Extent.StartLineNumber) is case-sensitive."
    }
    $tokenFixture = New-StateEventFixture -Prefix 'state-event-canonical'
    Assert-ThrowsDerived -TypeName 'ParameterBindingException' -Action { [void] (Get-CompanionOwnershipFailure -CompanionRoot $tokenFixture.Root -Role Runtime) } -Message 'A miscased ownership role'
    Assert-OrdinalEqual -Actual ([string] (Get-CompanionOwnershipFailure -CompanionRoot $tokenFixture.Root -Role runtime)) -Expected 'consumer-not-owner' -Message 'The canonical runtime role on a root without a marker'

    # The diagnostic reader admits only canonical class tokens, and the settlement and consumer
    # scripts' protocol failure only with consumption state unknown.
    $diagnostic = {
        param([string] $Class, [string] $State, [string] $Detail)
        ConvertTo-CompanionJson -InputObject ([ordered]@{ outcomeClass = $Class; consumptionState = $State; lockStage = $null; sourceIdentity = $null; generationTimestamp = $null; detail = $Detail; warnings = @() }) -Budget config
    }
    foreach ($case in @(
            @{ Script = 'Settlement'; Class = 'config'; State = 'none'; Detail = 'consumer-not-owner' },
            @{ Script = 'Consumer'; Class = 'config'; State = 'none'; Detail = 'owner-argument-invalid' },
            @{ Script = 'Settlement'; Class = 'protocol'; State = 'unknown'; Detail = 'attempt-result-invalid' },
            @{ Script = 'Consumer'; Class = 'protocol'; State = 'unknown'; Detail = 'attempt-result-invalid' },
            @{ Script = 'Publish'; Class = 'protocol'; State = 'unknown'; Detail = 'attempt-result-invalid' })) {
        [void] (Read-StateEventDiagnostic -Json (& $diagnostic $case.Class $case.State $case.Detail) -ExpectedClass $case.Class -Script $case.Script)
    }
    foreach ($case in @(
            @{ Script = 'Settlement'; Class = 'CONFIG'; State = 'none'; Detail = 'consumer-not-owner' },
            @{ Script = 'Consumer'; Class = 'Config'; State = 'none'; Detail = 'owner-argument-invalid' },
            @{ Script = 'Settlement'; Class = 'Busy'; State = 'none'; Detail = 'lock-timeout' },
            @{ Script = 'Consumer'; Class = 'Compute'; State = 'none'; Detail = 'baseline-read-failed' },
            @{ Script = 'Settlement'; Class = 'Delivery'; State = 'none'; Detail = 'stdout-write-failed' },
            @{ Script = 'Settlement'; Class = 'Protocol'; State = 'unknown'; Detail = 'attempt-result-invalid' },
            @{ Script = 'Settlement'; Class = 'protocol'; State = 'none'; Detail = 'attempt-result-invalid' },
            @{ Script = 'Consumer'; Class = 'protocol'; State = 'none'; Detail = 'attempt-result-invalid' },
            @{ Script = 'Consumer'; Class = 'protocol'; State = 'notConsumed'; Detail = 'attempt-result-invalid' })) {
        Assert-ThrowsDerived -TypeName 'TurnContextProtocolException' -Action { [void] (Read-StateEventDiagnostic -Json (& $diagnostic $case.Class $case.State $case.Detail) -ExpectedClass $case.Class -Script $case.Script) } -Message "The $($case.Script) diagnostic $($case.Class)/$($case.State)"
    }
    Assert-ThrowsDerived -TypeName 'TurnContextProtocolException' -Action { [void] (Format-StateEventDiagnosticLine -Script Settlement -Diagnostic ([ordered]@{ outcomeClass = 'Config'; consumptionState = 'none'; lockStage = $null; sourceIdentity = $null; generationTimestamp = $null; detail = 'consumer-not-owner'; warnings = @() })) } -Message 'Formatting a miscased class'
}

# ---------------------------------------------------------------------------------
if (Test-Selected 'Settlement') {
    $fixture = New-RuntimeFixture -Prefix 'state-event-settlement'
    [void] (Read-Receipt -Result (Invoke-Publish -Fixture $fixture) -Message 'Settlement fixture record one')
    [void] (Read-Receipt -Result (Invoke-Publish -Fixture $fixture -RequireRecord) -Message 'Settlement fixture record two')
    $names = @(Get-RecordNames -Fixture $fixture)
    $one = Get-RecordInfo -Fixture $fixture -Name $names[0]
    $two = Get-RecordInfo -Fixture $fixture -Name $names[1]
    Assert-Terminal -Result (Invoke-Settle -Fixture $fixture -Info $two) -Script Settlement -Class settlement -Detail settlement-out-of-order -Message 'A later record while an earlier one is pending'
    Assert-Terminal -Result (Invoke-Settle -Fixture $fixture -Info $one -Sha256 ('0' * 64)) -Script Settlement -Class settlement -Detail settlement-hash-mismatch -Message 'A pending record with another hash'
    $settled = Invoke-Settle -Fixture $fixture -Info $one
    Assert-Equal -Actual $settled.ExitCode -Expected 0 -Message "The earliest pending record settles ($($settled.StdErr))."
    Assert-OrdinalEqual -Actual (Read-StateEventSettlementResult -Json $settled.StdOut).Materialized['outcome'] -Expected 'settled' -Message 'A settlement reports settled.'
    Assert-False -Condition ([IO.File]::Exists((Join-Path (Get-OutboxPath -Fixture $fixture) $one.name))) -Message 'A settled record file is deleted.'
    $again = Invoke-Settle -Fixture $fixture -Info $one
    Assert-OrdinalEqual -Actual (Read-StateEventSettlementResult -Json $again.StdOut).Materialized['outcome'] -Expected 'already-settled' -Message 'An identical repeat reports already-settled.'
    Assert-Terminal -Result (Invoke-Settle -Fixture $fixture -Info $one -EventId 'event-other') -Script Settlement -Class settlement -Detail settlement-conflict -Message 'A repeat naming another event'
    Assert-Equal -Actual (Invoke-Settle -Fixture $fixture -Info $two).ExitCode -Expected 0 -Message 'The later record settles once the earlier one has.'
    $unknown = [pscustomobject]@{ logicalOutboxId = ($one.logicalOutboxId.Split('-')[0] + '-99'); sha256 = ('a' * 64); sequence = 99 }
    Assert-Terminal -Result (Invoke-Settle -Fixture $fixture -Info $unknown) -Script Settlement -Class settlement -Detail settlement-unknown -Message 'A record the outbox never held'
    Assert-Equal -Actual @((Read-Ledger -Fixture $fixture)['settled']).Count -Expected 2 -Message 'Two settlements leave two tombstones.'

    # A record a -Resync quarantined answers settlement-quarantined for its exact bytes, whether
    # its identity could be trusted (another adapter version) or not (nested content the core
    # rejects); under another hash the trusted tombstone conflicts and the untrusted one is unknown.
    foreach ($case in @(@{ Name = 'trusted'; Other = 'settlement-conflict' }, @{ Name = 'untrusted'; Other = 'settlement-unknown' })) {
        $quarantineFixture = New-RuntimeFixture -Prefix "state-event-settlement-$($case.Name)"
        [void] (Read-Receipt -Result (Invoke-Publish -Fixture $quarantineFixture) -Message "The $($case.Name) quarantine fixture record")
        $original = Get-RecordInfo -Fixture $quarantineFixture -Name @(Get-RecordNames -Fixture $quarantineFixture)[0]
        $node = [Text.Json.Nodes.JsonNode]::Parse($script:Utf8.GetString($original.bytes))
        if ($case.Name -ceq 'trusted') { Set-RecordAdapterVersion -Node $node }
        else { $node['diff']['character']['xpDelta'] = [Text.Json.Nodes.JsonValue]::Create('many') }
        $rejectedBytes = $script:Utf8.GetBytes($node.ToJsonString())
        [IO.File]::WriteAllBytes((Join-Path (Get-OutboxPath -Fixture $quarantineFixture) $original.name), $rejectedBytes)
        [void] (Read-Receipt -Result (Invoke-Publish -Fixture $quarantineFixture -RepairOperationId "jr-$($case.Name)") -Message "The $($case.Name) quarantining resync")
        $tombstone = @((Read-Ledger -Fixture $quarantineFixture)['settled'] | Where-Object { $_['sequence'] -eq $original.sequence })
        Assert-OrdinalEqual -Actual $tombstone[0]['outcome'] -Expected 'quarantined' -Message "The $($case.Name) record is tombstoned quarantined."
        Assert-Equal -Actual ($null -eq $tombstone[0]['logicalOutboxId']) -Expected ($case.Name -ceq 'untrusted') -Message "The $($case.Name) tombstone carries a logical identifier exactly when its bytes could be trusted."
        $rejectedSha = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($rejectedBytes)).ToLowerInvariant()
        Assert-Terminal -Result (Invoke-Settle -Fixture $quarantineFixture -Info $original -Sha256 $rejectedSha) -Script Settlement -Class settlement -Detail settlement-quarantined -Message "A record quarantined with a $($case.Name) identity"
        Assert-Terminal -Result (Invoke-Settle -Fixture $quarantineFixture -Info $original) -Script Settlement -Class settlement -Detail $case.Other -Message "A $($case.Name) quarantined tombstone under another hash"
    }

    # A crash between the tombstone write and the file delete is completed by the next operation.
    Set-StagedKillPoint -Fixture $fixture -RelativePath 'private/StateEvents.ps1' -Anchor ("            try { & `$DeleteRecord (Join-Path (Get-StateEventOutboxPath -CompanionRoot `$CompanionRoot) `$entry.name) }`n            catch { Add-CompanionWarning") -Name 'settlement-before-delete'
    [void] (Read-Receipt -Result (Invoke-Publish -Fixture $fixture -RequireRecord) -Message 'Settlement crash fixture record')
    $three = Get-RecordInfo -Fixture $fixture -Name @(Get-RecordNames -Fixture $fixture)[0]
    Invoke-Killed -Action { Invoke-CoreScript -Fixture $fixture -Name 'Set-StateEventSettlement.ps1' -Arguments @('-LogicalOutboxId', $three.logicalOutboxId, '-RecordSha256', $three.sha256, '-JournalId', 'journal-a', '-EventId', 'event-3') -Environment @{ COMPANION_TEST_STATE_EVENT_KILL = 'settlement-before-delete' } } -Message 'Settlement killed before its delete'
    Assert-True -Condition ([IO.File]::Exists((Join-Path (Get-OutboxPath -Fixture $fixture) $three.name))) -Message 'The killed settlement leaves its record file.'
    $unchangedAfterCrash = Read-Receipt -Result (Invoke-Publish -Fixture $fixture) -Message 'The operation after a killed settlement'
    Assert-OrdinalEqual -Actual $unchangedAfterCrash['outcome'] -Expected 'unchanged' -Message 'The tombstoned record is never pending again.'
    Assert-Equal -Actual @(Get-RecordNames -Fixture $fixture).Count -Expected 0 -Message 'The next operation deletes the tombstoned file.'
    Assert-Equal -Actual @((Read-Ledger -Fixture $fixture)['settled'] | Where-Object { $_['sequence'] -eq $three.sequence }).Count -Expected 1 -Message 'Exactly one tombstone names the settled sequence.'

    # Settling the newest record after a failed apply first applies the baseline.
    $applyFixture = New-RuntimeFixture -Prefix 'state-event-settlement-apply'
    $deferred = Invoke-InModuleAttempt -Fixture $applyFixture -Seams @{ WriteBaseline = { param($Root, $Document) throw [IO.IOException]::new('injected apply failure') } }
    Assert-OrdinalEqual -Actual $deferred.result.stateEventOutcome -Expected 'committed' -Message 'A failed apply still commits.'
    Assert-False -Condition $deferred.result.baselineApplied -Message 'A failed apply reports baselineApplied false.'
    Assert-False -Condition ([IO.File]::Exists((Join-Path $applyFixture.State 'baseline.json'))) -Message 'The failed apply left no baseline.'
    $pending = Get-RecordInfo -Fixture $applyFixture -Name @(Get-RecordNames -Fixture $applyFixture)[0]
    Assert-Equal -Actual (Invoke-Settle -Fixture $applyFixture -Info $pending).ExitCode -Expected 0 -Message 'The newest record settles after a failed apply.'
    $recordState = $pending.record.state.RootElement
    Assert-OrdinalEqual -Actual (Read-BaselineIdentity -Fixture $applyFixture) -Expected ($recordState.GetProperty('generatedAt').GetString() + '|' + $recordState.GetProperty('source').GetRawText()) -Message 'Settlement reconciliation applied the record before retiring it.'
}

# ---------------------------------------------------------------------------------
if (Test-Selected 'Consumer') {
    $fixture = New-StateEventFixture -Prefix 'state-event-switch'
    $result = { param($Run) (Read-CompanionConsumerResult -Json $Run.StdOut).Materialized }
    $bridgeNoop = & $result (Invoke-Switch -Fixture $fixture -Owner bridge)
    Assert-False -Condition $bridgeNoop['changed'] -Message 'A bridge request on a root that is not releasing writes nothing.'
    Assert-OrdinalEqual -Actual $bridgeNoop['previousOwner'] -Expected 'absent' -Message 'A root without a marker reports previousOwner absent.'
    Assert-False -Condition ([IO.File]::Exists((Join-Path $fixture.State 'consumer.json'))) -Message 'A no-op bridge request creates no marker.'
    $bridgeSwitchNoop = & $result (Invoke-Switch -Fixture $fixture -Owner bridge -Switches @('-AbandonUndelivered'))
    Assert-False -Condition ($bridgeSwitchNoop['changed'] -or $bridgeSwitchNoop['baselineRemoved']) -Message 'An abandon on a root that is not releasing and has no baseline writes nothing.'
    $handOver = & $result (Invoke-Switch -Fixture $fixture -Owner runtime)
    Assert-True -Condition $handOver['changed'] -Message 'A hand-over writes the runtime marker.'
    Assert-OrdinalEqual -Actual (Read-CompanionConsumerMarker -CompanionRoot $fixture.Root).owner -Expected 'runtime' -Message 'The hand-over marker names the runtime.'
    $repeated = & $result (Invoke-Switch -Fixture $fixture -Owner runtime)
    Assert-False -Condition $repeated['changed'] -Message 'A repeated hand-over writes nothing.'
    Assert-OrdinalEqual -Actual $repeated['previousOwner'] -Expected 'runtime' -Message 'A repeated hand-over reports previousOwner runtime.'
    Assert-Terminal -Result (Invoke-Switch -Fixture $fixture -Owner bridge) -Script Consumer -Class config -Detail release-decision-required -Message 'A release without a decision'
    [void] (Read-Receipt -Result (Invoke-Publish -Fixture $fixture) -Message 'The switch fixture commits a record')
    Assert-Terminal -Result (Invoke-Switch -Fixture $fixture -Owner bridge -Switches @('-DeliveryConfirmed')) -Script Consumer -Class config -Detail release-pending-records -Message 'A confirmed release with a pending record'
    $info = Get-RecordInfo -Fixture $fixture -Name @(Get-RecordNames -Fixture $fixture)[0]
    [void] (Invoke-Settle -Fixture $fixture -Info $info)
    $confirmed = & $result (Invoke-Switch -Fixture $fixture -Owner bridge -Switches @('-DeliveryConfirmed'))
    Assert-True -Condition ($confirmed['changed'] -and -not $confirmed['baselineRemoved']) -Message 'A confirmed release writes the bridge marker and keeps the baseline.'
    Assert-True -Condition ([IO.File]::Exists((Join-Path $fixture.State 'baseline.json'))) -Message 'A confirmed release keeps the baseline.'
    Assert-OrdinalEqual -Actual $confirmed['previousOwner'] -Expected 'runtime' -Message 'A release reports previousOwner runtime.'
    $released = & $result (Invoke-Switch -Fixture $fixture -Owner bridge -Switches @('-DeliveryConfirmed'))
    Assert-False -Condition $released['changed'] -Message 'A repeated release on a released root writes nothing.'
    Assert-OrdinalEqual -Actual $released['previousOwner'] -Expected 'bridge' -Message 'A released root reports previousOwner bridge.'
    $reHandOver = & $result (Invoke-Switch -Fixture $fixture -Owner runtime)
    Assert-True -Condition $reHandOver['changed'] -Message 'A hand-over after a release writes the runtime marker.'
    Assert-OrdinalEqual -Actual $reHandOver['previousOwner'] -Expected 'bridge' -Message 'A hand-over after a supported release reports previousOwner bridge.'
    Write-Marker -Fixture $fixture -Json '{broken'
    $repaired = & $result (Invoke-Switch -Fixture $fixture -Owner runtime)
    Assert-True -Condition $repaired['changed'] -Message 'A hand-over repairs a content-invalid marker.'
    Assert-OrdinalEqual -Actual $repaired['previousOwner'] -Expected 'invalid' -Message 'A content-invalid marker reports previousOwner invalid.'
    Write-Marker -Fixture $fixture -Json ''
    $emptyRepaired = & $result (Invoke-Switch -Fixture $fixture -Owner runtime)
    Assert-True -Condition $emptyRepaired['changed'] -Message 'A hand-over repairs a zero-byte marker.'
    Assert-OrdinalEqual -Actual $emptyRepaired['previousOwner'] -Expected 'invalid' -Message 'A zero-byte marker is content-invalid, not unreadable.'

    # A settled event the runtime never delivered, then a root that is not releasing: an
    # absent marker (deleted by hand) or a bridge marker, an empty outbox, and a baseline.
    foreach ($markerState in 'absent', 'bridge') {
        $settledFixture = New-RuntimeFixture -Prefix 'state-event-abandon-settled'
        [void] (Read-Receipt -Result (Invoke-Publish -Fixture $settledFixture) -Message "Settled fixture record under a $markerState marker")
        [void] (Invoke-Settle -Fixture $settledFixture -Info (Get-RecordInfo -Fixture $settledFixture -Name @(Get-RecordNames -Fixture $settledFixture)[0]))
        switch ($markerState) {
            'absent' { [IO.File]::Delete((Join-Path $settledFixture.State 'consumer.json')) }
            'bridge' { Write-Marker -Fixture $settledFixture -Json (Get-MarkerJson -Owner bridge) }
        }
        $markerBefore = Get-FileHashOrNull -Path (Join-Path $settledFixture.State 'consumer.json')
        $ledgerBefore = Get-FileHashOrNull -Path (Join-Path (Get-OutboxPath -Fixture $settledFixture) 'ledger.json')
        foreach ($switches in @(@('-DeliveryConfirmed'), @())) {
            $untouched = & $result (Invoke-Switch -Fixture $settledFixture -Owner bridge -Switches $switches)
            Assert-False -Condition ($untouched['changed'] -or $untouched['baselineRemoved']) -Message "A bridge request '$($switches -join ' ')' under a $markerState marker changes nothing."
            Assert-True -Condition ([IO.File]::Exists((Join-Path $settledFixture.State 'baseline.json'))) -Message "A bridge request '$($switches -join ' ')' under a $markerState marker keeps the baseline."
        }
        $forced = & $result (Invoke-Switch -Fixture $settledFixture -Owner bridge -Switches @('-AbandonUndelivered'))
        Assert-True -Condition (-not $forced['changed'] -and $forced['baselineRemoved'] -and $forced['abandonedCount'] -eq 0) -Message "A forced abandon under a $markerState marker removes the baseline and abandons nothing."
        Assert-False -Condition ([IO.File]::Exists((Join-Path $settledFixture.State 'baseline.json'))) -Message "No baseline remains after a forced abandon under a $markerState marker."
        Assert-Equal -Actual (Get-FileHashOrNull -Path (Join-Path $settledFixture.State 'consumer.json')) -Expected $markerBefore -Message "A forced abandon under a $markerState marker writes no marker."
        Assert-Equal -Actual (Get-FileHashOrNull -Path (Join-Path (Get-OutboxPath -Fixture $settledFixture) 'ledger.json')) -Expected $ledgerBefore -Message "A forced abandon under a $markerState marker writes no ledger entry."
        $again = & $result (Invoke-Switch -Fixture $settledFixture -Owner bridge -Switches @('-AbandonUndelivered'))
        Assert-False -Condition $again['baselineRemoved'] -Message "A repeated forced abandon under a $markerState marker reports baselineRemoved false."
        $settledReset = Invoke-CoreScript -Fixture $settledFixture -Name 'Get-TurnContext.ps1'
        Assert-True -Condition (Read-TurnContextEnvelope -Json $settledReset.StdOut -TransportOnly).RootElement.GetProperty('baselineReset').GetBoolean() -Message "The next bridge read after a forced abandon under a $markerState marker reports a baseline reset."
    }

    # Abandon with one valid and one invalid pending record.
    $abandonFixture = New-RuntimeFixture -Prefix 'state-event-abandon'
    [void] (Read-Receipt -Result (Invoke-Publish -Fixture $abandonFixture) -Message 'Abandon fixture valid record')
    $invalidBytes = $script:Utf8.GetBytes('{"broken":true}')
    [IO.File]::WriteAllBytes((Join-Path (Get-OutboxPath -Fixture $abandonFixture) 'event-0000000000000002.json'), $invalidBytes)
    $abandoned = & $result (Invoke-Switch -Fixture $abandonFixture -Owner bridge -Switches @('-AbandonUndelivered'))
    Assert-True -Condition ($abandoned['changed'] -and $abandoned['baselineRemoved']) -Message 'An abandon release removes the baseline and writes the marker.'
    Assert-Equal -Actual $abandoned['abandonedCount'] -Expected 1L -Message 'One valid record is abandoned.'
    $ledger = Read-Ledger -Fixture $abandonFixture
    Assert-Equal -Actual @($ledger['settled'] | Where-Object { $_['outcome'] -ceq 'abandoned' }).Count -Expected 1 -Message 'The release writes one abandoned tombstone.'
    Assert-Equal -Actual @($ledger['settled'] | Where-Object { $_['outcome'] -ceq 'quarantined' }).Count -Expected 1 -Message 'The release writes one quarantined tombstone.'
    $quarantined = @([IO.Directory]::GetFiles((Join-Path (Get-OutboxPath -Fixture $abandonFixture) 'quarantine')))
    Assert-Equal -Actual $quarantined.Count -Expected 1 -Message 'The invalid record moves to the quarantine.'
    Assert-True -Condition ([Linq.Enumerable]::SequenceEqual[byte]($invalidBytes, [IO.File]::ReadAllBytes($quarantined[0]))) -Message 'The quarantine keeps the invalid record bytes exactly.'
    Assert-Equal -Actual @(Get-RecordNames -Fixture $abandonFixture).Count -Expected 0 -Message 'No record file remains.'
    Assert-False -Condition ([IO.File]::Exists((Join-Path $abandonFixture.State 'baseline.json'))) -Message 'No baseline remains.'
    Assert-OrdinalEqual -Actual (Read-CompanionConsumerMarker -CompanionRoot $abandonFixture.Root).owner -Expected 'bridge' -Message 'The marker names the bridge.'
    $reset = Invoke-CoreScript -Fixture $abandonFixture -Name 'Get-TurnContext.ps1'
    Assert-True -Condition (Read-TurnContextEnvelope -Json $reset.StdOut -TransportOnly).RootElement.GetProperty('baselineReset').GetBoolean() -Message 'The next bridge read reports a baseline reset.'

    # Killing an abandon release after each of its writes, from each marker state.
    $killPoints = [ordered]@{
        'abandon-after-baseline' = @{ Path = 'private/StateEvents.ps1'; Anchor = '    $releasingByRecord = $pendingNames.Count -gt 0' }
        'abandon-after-tombstones' = @{ Path = 'private/StateEvents.ps1'; Anchor = '                try { & $DeleteRecord (Join-Path (Get-StateEventOutboxPath -CompanionRoot $CompanionRoot) $entry.name) }' }
        'abandon-before-marker' = @{ Path = 'private/StateEvents.ps1'; Anchor = "        if (-not (& `$tryWriteMarker 'bridge')) { return & `$failure outbox outbox-write-failed }`n`n        return & `$done `$true `$pending.Count" }
    }
    foreach ($markerState in 'runtime', 'absent', 'bridge') {
        foreach ($killPoint in $killPoints.Keys) {
            $killFixture = New-RuntimeFixture -Prefix 'state-event-abandon-kill'
            [void] (Read-Receipt -Result (Invoke-Publish -Fixture $killFixture) -Message 'Kill fixture record')
            switch ($markerState) {
                'absent' { [IO.File]::Delete((Join-Path $killFixture.State 'consumer.json')) }
                'bridge' { Write-Marker -Fixture $killFixture -Json (Get-MarkerJson -Owner bridge) }
            }
            Set-StagedKillPoint -Fixture $killFixture -RelativePath $killPoints[$killPoint].Path -Anchor $killPoints[$killPoint].Anchor -Name $killPoint
            Invoke-Killed -Action { Invoke-Switch -Fixture $killFixture -Owner bridge -Switches @('-AbandonUndelivered') -Environment @{ COMPANION_TEST_STATE_EVENT_KILL = $killPoint } } -Message "An abandon release killed at $killPoint under a $markerState marker"
            $rerun = Invoke-Switch -Fixture $killFixture -Owner bridge -Switches @('-AbandonUndelivered')
            Assert-Equal -Actual $rerun.ExitCode -Expected 0 -Message "The rerun after $killPoint under a $markerState marker succeeds ($($rerun.StdErr))."
            Assert-Equal -Actual @(Get-RecordNames -Fixture $killFixture).Count -Expected 0 -Message "No record remains after $killPoint under a $markerState marker."
            Assert-False -Condition ([IO.File]::Exists((Join-Path $killFixture.State 'baseline.json'))) -Message "No baseline remains after $killPoint under a $markerState marker."
            $resetRead = Invoke-CoreScript -Fixture $killFixture -Name 'Get-TurnContext.ps1'
            Assert-Equal -Actual $resetRead.ExitCode -Expected 0 -Message "The bridge reads after $killPoint under a $markerState marker ($($resetRead.StdErr))."
            Assert-True -Condition (Read-TurnContextEnvelope -Json $resetRead.StdOut -TransportOnly).RootElement.GetProperty('baselineReset').GetBoolean() -Message "The bridge read after $killPoint under a $markerState marker reports a reset."
        }
    }

    # An all-invalid outbox under an absent and a bridge marker, killed after the quarantine fence.
    foreach ($markerState in 'absent', 'bridge') {
        $fenceFixture = New-RuntimeFixture -Prefix 'state-event-fence-kill'
        [void] (Read-Receipt -Result (Invoke-Publish -Fixture $fenceFixture) -Message 'Fence fixture applies a baseline')
        [void] (Invoke-Settle -Fixture $fenceFixture -Info (Get-RecordInfo -Fixture $fenceFixture -Name @(Get-RecordNames -Fixture $fenceFixture)[0]))
        [IO.File]::WriteAllBytes((Join-Path (Get-OutboxPath -Fixture $fenceFixture) 'event-0000000000000002.json'), $invalidBytes)
        if ($markerState -ceq 'absent') { [IO.File]::Delete((Join-Path $fenceFixture.State 'consumer.json')) } else { Write-Marker -Fixture $fenceFixture -Json (Get-MarkerJson -Owner bridge) }
        Set-StagedKillPoint -Fixture $fenceFixture -RelativePath 'private/StateEvents.ps1' -Anchor '    foreach ($entry in $Entries) { Move-StateEventRecordToQuarantine -OutboxPath $outbox -Name $entry.name -WarningSink $OperationalWarnings }' -Name 'after-fence'
        Invoke-Killed -Action { Invoke-Switch -Fixture $fenceFixture -Owner bridge -Switches @('-AbandonUndelivered') -Environment @{ COMPANION_TEST_STATE_EVENT_KILL = 'after-fence' } } -Message "An abandon release killed after its fence under a $markerState marker"
        $rerun = Invoke-Switch -Fixture $fenceFixture -Owner bridge -Switches @('-AbandonUndelivered')
        Assert-Equal -Actual $rerun.ExitCode -Expected 0 -Message "The rerun after the fence kill under a $markerState marker succeeds ($($rerun.StdErr))."
        Assert-False -Condition ([IO.File]::Exists((Join-Path $fenceFixture.State 'baseline.json'))) -Message "The fence kill under a $markerState marker leaves no baseline."
        $resetRead = Invoke-CoreScript -Fixture $fenceFixture -Name 'Get-TurnContext.ps1'
        Assert-True -Condition (Read-TurnContextEnvelope -Json $resetRead.StdOut -TransportOnly).RootElement.GetProperty('baselineReset').GetBoolean() -Message "The bridge read after the fence kill under a $markerState marker reports a reset."
    }
}

# ---------------------------------------------------------------------------------
if (Test-Selected 'CommitStates') {
    foreach ($case in @(
            @{ Name = 'serialization'; Seams = @{ SerializeRecord = { param($Record) throw [InvalidOperationException]::new('injected') } }; Reason = 'record-serialize-failed' },
            @{ Name = 'temp write'; Seams = @{ CommitRecord = { param($Path, $Bytes) throw [CompanionStateWriteException]::new('temp-write', [IO.IOException]::new('injected')) } }; Reason = 'record-temp-write-failed' },
            @{ Name = 'commit move'; Seams = @{ CommitRecord = { param($Path, $Bytes) throw [CompanionStateWriteException]::new('replace', [IO.IOException]::new('injected')) } }; Reason = 'record-commit-failed' })) {
        $fixture = New-RuntimeFixture -Prefix 'state-event-commit-fault'
        [void] (Read-Receipt -Result (Invoke-Publish -Fixture $fixture) -Message 'Commit fault fixture baseline')
        [void] (Invoke-Settle -Fixture $fixture -Info (Get-RecordInfo -Fixture $fixture -Name @(Get-RecordNames -Fixture $fixture)[0]))
        Add-NewerSave -Fixture $fixture -Name 's-b.zip'
        $before = Get-FileHashOrNull -Path (Join-Path $fixture.State 'baseline.json')
        $attempt = Invoke-InModuleAttempt -Fixture $fixture -Seams $case.Seams
        Assert-OrdinalEqual -Actual $attempt.result.outcomeClass -Expected 'outbox-write:not-consumed' -Message "A $($case.Name) fault is not consumed."
        Assert-OrdinalEqual -Actual $attempt.result.reason -Expected $case.Reason -Message "A $($case.Name) fault names its stage."
        Assert-OrdinalEqual -Actual $attempt.result.consumptionState -Expected 'notConsumed' -Message "A $($case.Name) fault reports notConsumed."
        Assert-Equal -Actual @(Get-RecordNames -Fixture $fixture).Count -Expected 0 -Message "A $($case.Name) fault leaves no record."
        Assert-Equal -Actual (Get-FileHashOrNull -Path (Join-Path $fixture.State 'baseline.json')) -Expected $before -Message "A $($case.Name) fault leaves the old baseline."
        Assert-Equal -Actual @([IO.Directory]::GetFiles((Get-OutboxPath -Fixture $fixture), '*.tmp')).Count -Expected 0 -Message "A $($case.Name) fault leaves no temp record."
    }

    # The create-only writer never replaces an existing target.
    $existingRoot = New-ScratchCompanionRoot -Prefix 'state-event-create-only'
    $existing = Join-Path $existingRoot 'event-0000000000000001.json'
    [IO.File]::WriteAllText($existing, 'original', $script:Utf8)
    $originalBytes = [IO.File]::ReadAllBytes($existing)
    Assert-ThrowsType -TypeName 'CompanionStateWriteException' -Action { Invoke-InCompanionModule { param($Path) Write-CompanionStateBytes -Path $Path -Bytes ([byte[]] @(1, 2, 3)) -CreateOnly } @($existing) }
    Assert-True -Condition ([Linq.Enumerable]::SequenceEqual[byte]($originalBytes, [IO.File]::ReadAllBytes($existing))) -Message 'A create-only commit onto an existing name leaves the file byte-identical.'
    Assert-Equal -Actual @([IO.Directory]::GetFiles($existingRoot, '*.tmp')).Count -Expected 0 -Message 'A refused create-only commit removes its temp.'

    # Apply and cache phase faults after the commit point.
    $applyFixture = New-RuntimeFixture -Prefix 'state-event-apply-fault'
    $applyFault = Invoke-InModuleAttempt -Fixture $applyFixture -Seams @{ WriteBaseline = { param($Root, $Document) throw [IO.IOException]::new('injected') } }
    Assert-OrdinalEqual -Actual $applyFault.result.stateEventOutcome -Expected 'committed' -Message 'An apply fault keeps the commit.'
    Assert-False -Condition $applyFault.result.baselineApplied -Message 'An apply fault reports baselineApplied false.'
    Assert-True -Condition $applyFault.result.cacheDegraded -Message 'An apply fault skips the cache with cacheDegraded true.'
    Assert-True -Condition ($applyFault.receiptWarnings -ccontains 'outbox-apply-deferred') -Message 'An apply fault adds outbox-apply-deferred.'
    $record = Get-RecordInfo -Fixture $applyFixture -Name @(Get-RecordNames -Fixture $applyFixture)[0]
    $next = Read-Receipt -Result (Invoke-Publish -Fixture $applyFixture) -Message 'The publish after an apply fault'
    Assert-OrdinalEqual -Actual $next['outcome'] -Expected 'unchanged' -Message 'The next publish completes the apply and finds nothing new.'
    Assert-Equal -Actual @(Get-RecordNames -Fixture $applyFixture).Count -Expected 1 -Message 'The next publish writes no second record for the first transition.'
    Assert-OrdinalEqual -Actual (Read-BaselineIdentity -Fixture $applyFixture) -Expected ($record.record.state.RootElement.GetProperty('generatedAt').GetString() + '|' + $record.record.state.RootElement.GetProperty('source').GetRawText()) -Message 'Reconciliation rewrote the baseline from the pending record.'
    foreach ($cacheCase in @(@{ Name = 'comparison'; Seams = @{ CompareCache = { param($Baseline, $Target, $Config) throw [InvalidOperationException]::new('injected') } } }, @{ Name = 'write'; Seams = @{ WriteCache = { param($Root, $Document) throw [IO.IOException]::new('injected') } } })) {
        $cacheFixture = New-RuntimeFixture -Prefix 'state-event-cache-fault'
        $cacheFault = Invoke-InModuleAttempt -Fixture $cacheFixture -Seams $cacheCase.Seams
        Assert-OrdinalEqual -Actual $cacheFault.result.stateEventOutcome -Expected 'committed' -Message "A cache $($cacheCase.Name) fault keeps the commit."
        Assert-True -Condition ($cacheFault.result.baselineApplied -and $cacheFault.result.cacheDegraded) -Message "A cache $($cacheCase.Name) fault applies the baseline and reports cacheDegraded."
    }

    # A child killed between commit and apply recovers through reconciliation.
    $killFixture = New-RuntimeFixture -Prefix 'state-event-commit-kill'
    Set-StagedKillPoint -Fixture $killFixture -RelativePath 'private/StateEvents.ps1' -Anchor '        & $AfterCommit $recordPath' -Name 'after-commit'
    Invoke-Killed -Action { Invoke-Publish -Fixture $killFixture -Environment @{ COMPANION_TEST_STATE_EVENT_KILL = 'after-commit' } } -Message 'A publish killed after its commit move'
    Assert-Equal -Actual @(Get-RecordNames -Fixture $killFixture).Count -Expected 1 -Message 'The killed publish leaves its committed record.'
    Assert-False -Condition ([IO.File]::Exists((Join-Path $killFixture.State 'baseline.json'))) -Message 'The killed publish never applied the baseline.'
    $recovered = Read-Receipt -Result (Invoke-Publish -Fixture $killFixture) -Message 'The publish after a kill between commit and apply'
    Assert-OrdinalEqual -Actual $recovered['outcome'] -Expected 'unchanged' -Message 'The recovery publish reports unchanged after applying the record.'
    Assert-Equal -Actual @(Get-RecordNames -Fixture $killFixture).Count -Expected 1 -Message 'Recovery commits no second record.'

    # The transaction retries exactly once after a not-consumed write failure.
    foreach ($failures in 1, 2) {
        $retryFixture = New-RuntimeFixture -Prefix 'state-event-retry'
        $retryPath = Join-Path $retryFixture.Core 'private/StateEvents.ps1'
        $anchor = '        try { & $CommitRecord $recordPath $bytes }'
        $source = [IO.File]::ReadAllText($retryPath, $script:Utf8)
        Assert-Equal -Actual ([regex]::Matches($source, [regex]::Escape($anchor)).Count) -Expected 1 -Message 'The retry fixture finds one commit call.'
        $injected = '        try { [IO.File]::AppendAllText($env:COMPANION_TEST_COMMIT_TRACE, "attempt`n"); if (@([IO.File]::ReadAllLines($env:COMPANION_TEST_COMMIT_TRACE)).Count -le [int] $env:COMPANION_TEST_COMMIT_FAILURES) { throw [IO.IOException]::new(''injected commit failure'') }; & $CommitRecord $recordPath $bytes }'
        [IO.File]::WriteAllText($retryPath, $source.Replace($anchor, $injected, [StringComparison]::Ordinal), $script:Utf8)
        $trace = Join-Path $retryFixture.Root '.tmp/commit-trace.txt'
        $run = Invoke-Publish -Fixture $retryFixture -Environment @{ COMPANION_TEST_COMMIT_TRACE = $trace; COMPANION_TEST_COMMIT_FAILURES = [string] $failures }
        Assert-Equal -Actual @([IO.File]::ReadAllLines($trace)).Count -Expected 2 -Message "With $failures failing commits the transaction makes exactly two consuming attempts."
        if ($failures -eq 1) {
            Assert-OrdinalEqual -Actual (Read-Receipt -Result $run -Message 'The retried commit')['outcome'] -Expected 'committed' -Message 'One not-consumed failure is absorbed by the single retry.'
            Assert-Equal -Actual @(Get-RecordNames -Fixture $retryFixture).Count -Expected 1 -Message 'The retry commits one record.'
        }
        else {
            Assert-Terminal -Result $run -Script Publish -Class 'outbox-write:not-consumed' -Detail record-temp-write-failed -ConsumptionState notConsumed -Message 'A second not-consumed failure'
            Assert-Equal -Actual @(Get-RecordNames -Fixture $retryFixture).Count -Expected 0 -Message 'Two failed commits leave no record.'
        }
    }

    # The seventeenth pending publish is refused with no mutation.
    $fullFixture = New-RuntimeFixture -Prefix 'state-event-full'
    for ($index = 0; $index -lt 16; $index++) { [void] (Read-Receipt -Result (Invoke-Publish -Fixture $fullFixture -RequireRecord) -Message "Pending record $($index + 1)") }
    $before = Get-ConsumedStateFingerprint -Fixture $fullFixture
    Assert-Terminal -Result (Invoke-Publish -Fixture $fullFixture -RequireRecord) -Script Publish -Class outbox -Detail outbox-full -Message 'The seventeenth pending publish'
    Assert-OrdinalEqual -Actual (Get-ConsumedStateFingerprint -Fixture $fullFixture) -Expected $before -Message 'A full outbox mutates nothing.'
    # A repair must commit its resync before it can drain, so -Resync is exempt from the bound.
    $resync = Read-Receipt -Result (Invoke-Publish -Fixture $fullFixture -RepairOperationId 'jr-full') -Message 'A resync at the pending bound'
    Assert-OrdinalEqual -Actual $resync['kind'] -Expected 'resync' -Message 'The resync at the pending bound commits a resync record.'
    Assert-Equal -Actual @(Get-RecordNames -Fixture $fullFixture).Count -Expected 17 -Message 'The resync is the seventeenth pending record.'
    $replay = Read-Receipt -Result (Invoke-Publish -Fixture $fullFixture -RepairOperationId 'jr-full') -Message 'A repeated resync at the pending bound'
    Assert-OrdinalEqual -Actual $replay['outcome'] -Expected 'replayed' -Message 'A repeated resync replays instead of adding a record.'
    Assert-Terminal -Result (Invoke-Publish -Fixture $fullFixture -RequireRecord) -Script Publish -Class outbox -Detail outbox-full -Message 'An ordinary publish beside the resync'
}

# ---------------------------------------------------------------------------------
if (Test-Selected 'Reconciliation') {
    $fixture = New-RuntimeFixture -Prefix 'state-event-guards'
    [void] (Read-Receipt -Result (Invoke-Publish -Fixture $fixture) -Message 'Guard fixture record one')
    $one = Get-RecordInfo -Fixture $fixture -Name @(Get-RecordNames -Fixture $fixture)[0]
    $issued = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    [void] $issued.Add($one.logicalOutboxId)
    $held = [IO.FileStream]::new((Join-Path (Get-OutboxPath -Fixture $fixture) $one.name), [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    try {
        Assert-Equal -Actual (Invoke-Settle -Fixture $fixture -Info $one).ExitCode -Expected 0 -Message 'A settlement whose delete fails still settles.'
        Assert-True -Condition ([IO.File]::Exists((Join-Path (Get-OutboxPath -Fixture $fixture) $one.name))) -Message 'The undeletable record file remains.'
        Add-NewerSave -Fixture $fixture -Name 's-b.zip'
        $two = Read-Receipt -Result (Invoke-Publish -Fixture $fixture) -Message 'A publish beside a tombstoned undeletable record'
        Assert-Equal -Actual $two['sequence'] -Expected 2L -Message 'The tombstoned record is never pending: the next record is sequence 2.'
        [void] $issued.Add($two['logicalOutboxId'])
        $twoInfo = Get-RecordInfo -Fixture $fixture -Name 'event-0000000000000002.json'
        Assert-Equal -Actual (Invoke-Settle -Fixture $fixture -Info $twoInfo).ExitCode -Expected 0 -Message 'The newer record settles.'
        # Prune under small bounds: the tombstone of the surviving file is kept.
        Invoke-InCompanionModule {
            param($Root)
            $script:StateEventTombstoneMaximumCount = 0
            $script:StateEventTombstoneMaximumAge = [TimeSpan]::Zero
            try {
                $sink = New-CompanionWarningSink -Profile TurnOperational
                $reconciled = Invoke-StateEventReconciliation -CompanionRoot $Root -Mode Normal -OperationalWarnings $sink
                Write-StateEventLedger -CompanionRoot $Root -Ledger $reconciled.ledger -ExistingRecordSequences $reconciled.recordSequences
            }
            finally {
                $script:StateEventTombstoneMaximumCount = 512
                $script:StateEventTombstoneMaximumAge = [TimeSpan]::FromDays(180)
            }
        } @($fixture.Root)
        $kept = @((Read-Ledger -Fixture $fixture)['settled'])
        Assert-Equal -Actual @($kept | Where-Object { $_['sequence'] -eq 1 }).Count -Expected 1 -Message 'A tombstone whose record file still exists survives pruning.'
        Assert-Equal -Actual @($kept | Where-Object { $_['sequence'] -eq 2 }).Count -Expected 0 -Message 'A tombstone without a file is pruned under the small bounds.'
        Assert-Equal -Actual (Read-Ledger -Fixture $fixture)['highWaterSequence'] -Expected 2L -Message 'Pruning never lowers the high water.'
        $baselineBefore = Read-BaselineIdentity -Fixture $fixture
        $oldIncarnation = (Read-Ledger -Fixture $fixture)['incarnationId']
        [IO.File]::Delete((Join-Path (Get-OutboxPath -Fixture $fixture) 'ledger.json'))
        $afterRebuild = Read-Receipt -Result (Invoke-Publish -Fixture $fixture) -Message 'A publish after the ledger was deleted'
        Assert-True -Condition (@($afterRebuild['warnings'] | Where-Object { $_['code'] -ceq 'outbox-ledger-rebuilt' }).Count -eq 1) -Message 'A rebuild beside a surviving record warns outbox-ledger-rebuilt.'
        $newIncarnation = (Read-Ledger -Fixture $fixture)['incarnationId']
        Assert-True -Condition ($newIncarnation -cne $oldIncarnation) -Message 'A rebuilt ledger gets a fresh incarnation.'
        Assert-OrdinalEqual -Actual (Read-BaselineIdentity -Fixture $fixture) -Expected $baselineBefore -Message 'The revived record is superseded and never written over the newer baseline.'
        Assert-Equal -Actual (Invoke-Settle -Fixture $fixture -Info $one).ExitCode -Expected 0 -Message 'The revived record settles again.'
    }
    finally {
        $held.Dispose()
    }
    $third = Read-Receipt -Result (Invoke-Publish -Fixture $fixture -RequireRecord) -Message 'The first commit after the rebuild'
    Assert-False -Condition $issued.Contains($third['logicalOutboxId']) -Message 'The first identifier after a rebuild was never issued before.'
    Assert-True -Condition $third['logicalOutboxId'].StartsWith($newIncarnation, [StringComparison]::Ordinal) -Message 'New records carry the new incarnation.'
    # A zero-byte ledger was read completely and fails to parse, so it is rebuilt as
    # content-invalid rather than refused as unreadable.
    [IO.File]::WriteAllBytes((Join-Path (Get-OutboxPath -Fixture $fixture) 'ledger.json'), [byte[]] @())
    $afterEmptyLedger = Read-Receipt -Result (Invoke-Publish -Fixture $fixture) -Message 'A publish after the ledger was truncated to zero bytes'
    Assert-True -Condition (@($afterEmptyLedger['warnings'] | Where-Object { $_['code'] -ceq 'outbox-ledger-rebuilt' }).Count -eq 1) -Message 'A zero-byte ledger is rebuilt with outbox-ledger-rebuilt.'
    Assert-True -Condition ((Read-Ledger -Fixture $fixture)['incarnationId'] -cne $newIncarnation) -Message 'The ledger rebuilt from zero bytes gets a fresh incarnation.'

    # A ledger outside its exact grammars is content-invalid and rebuilt rather than trusted:
    # an uppercase tombstone hash, then an incarnation with a trailing line feed, whose rebuild
    # gives the next record an identifier that settles.
    $grammarFixture = New-RuntimeFixture -Prefix 'state-event-ledger-grammar'
    [void] (Read-Receipt -Result (Invoke-Publish -Fixture $grammarFixture) -Message 'The ledger grammar fixture record')
    Assert-Equal -Actual (Invoke-Settle -Fixture $grammarFixture -Info (Get-RecordInfo -Fixture $grammarFixture -Name @(Get-RecordNames -Fixture $grammarFixture)[0])).ExitCode -Expected 0 -Message 'The ledger grammar fixture settles its record.'
    $grammarLedger = Join-Path (Get-OutboxPath -Fixture $grammarFixture) 'ledger.json'
    foreach ($case in @(
            @{ Name = 'an uppercase tombstone hash'; Change = { param($Node) $Node['settled'][0]['recordSha256'] = [Text.Json.Nodes.JsonValue]::Create($Node['settled'][0]['recordSha256'].GetValue[string]().ToUpperInvariant()) } },
            @{ Name = 'an incarnation with a trailing line feed'; Change = { param($Node) $Node['incarnationId'] = [Text.Json.Nodes.JsonValue]::Create($Node['incarnationId'].GetValue[string]() + "`n") } })) {
        $node = [Text.Json.Nodes.JsonNode]::Parse([IO.File]::ReadAllText($grammarLedger, $script:Utf8))
        & $case.Change $node
        [IO.File]::WriteAllText($grammarLedger, $node.ToJsonString(), $script:Utf8)
        Assert-OrdinalEqual -Actual (Read-StateEventLedger -CompanionRoot $grammarFixture.Root).outcome -Expected 'content-invalid' -Message "A ledger with $($case.Name) is content-invalid."
        $rebuilt = Read-Receipt -Result (Invoke-Publish -Fixture $grammarFixture -RequireRecord) -Message "A publish beside a ledger with $($case.Name)"
        Assert-True -Condition (@($rebuilt['warnings'] | Where-Object { $_['code'] -ceq 'outbox-ledger-rebuilt' }).Count -eq 1) -Message "A ledger with $($case.Name) is rebuilt with outbox-ledger-rebuilt."
        Assert-True -Condition (Test-StateEventLogicalOutboxIdText -Value $rebuilt['logicalOutboxId']) -Message "The record committed after rebuilding a ledger with $($case.Name) has a canonical identifier."
        $grammarRecord = Get-RecordInfo -Fixture $grammarFixture -Name ('event-{0:D16}.json' -f $rebuilt['sequence'])
        Assert-Equal -Actual (Invoke-Settle -Fixture $grammarFixture -Info $grammarRecord).ExitCode -Expected 0 -Message "The record committed after rebuilding a ledger with $($case.Name) settles."
    }

    # A repair killed between its fencing ledger write and the quarantine move.
    $fenceFixture = New-RuntimeFixture -Prefix 'state-event-repair-fence'
    [void] (Read-Receipt -Result (Invoke-Publish -Fixture $fenceFixture) -Message 'Repair fence fixture record')
    [IO.File]::WriteAllBytes((Join-Path (Get-OutboxPath -Fixture $fenceFixture) 'event-0000000000000002.json'), $script:Utf8.GetBytes('{"broken":true}'))
    Set-StagedKillPoint -Fixture $fenceFixture -RelativePath 'private/StateEvents.ps1' -Anchor '    foreach ($entry in $Entries) { Move-StateEventRecordToQuarantine -OutboxPath $outbox -Name $entry.name -WarningSink $OperationalWarnings }' -Name 'repair-after-fence'
    Invoke-Killed -Action { Invoke-Publish -Fixture $fenceFixture -RepairOperationId 'jr-fence' -Environment @{ COMPANION_TEST_STATE_EVENT_KILL = 'repair-after-fence' } } -Message 'A resync killed after its fence'
    Assert-True -Condition ([IO.File]::Exists((Join-Path (Get-OutboxPath -Fixture $fenceFixture) 'event-0000000000000002.json'))) -Message 'The killed repair leaves the fenced file in place.'
    $resumed = Read-Receipt -Result (Invoke-Publish -Fixture $fenceFixture -RepairOperationId 'jr-fence') -Message 'The resync after the fence kill'
    Assert-False -Condition ([IO.File]::Exists((Join-Path (Get-OutboxPath -Fixture $fenceFixture) 'event-0000000000000002.json'))) -Message 'The next reconciliation completes the quarantine move.'
    Assert-True -Condition ($resumed['sequence'] -gt 2) -Message 'The fenced sequence is never reissued.'

    # A zero-byte record is invalid content, not an unreadable outbox: an ordinary publish
    # refuses it with outbox-record-invalid, and both repairs quarantine it under the SHA-256
    # of zero bytes.
    $emptySha = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([byte[]] @())).ToLowerInvariant()
    foreach ($repair in 'resync', 'abandon') {
        $emptyFixture = New-RuntimeFixture -Prefix "state-event-empty-$repair"
        [void] (Read-Receipt -Result (Invoke-Publish -Fixture $emptyFixture) -Message "The $repair empty-record fixture record")
        $emptyOne = Get-RecordInfo -Fixture $emptyFixture -Name @(Get-RecordNames -Fixture $emptyFixture)[0]
        $emptyPath = Join-Path (Get-OutboxPath -Fixture $emptyFixture) 'event-0000000000000002.json'
        [IO.File]::WriteAllBytes($emptyPath, [byte[]] @())
        $before = Get-ConsumedStateFingerprint -Fixture $emptyFixture
        Assert-Terminal -Result (Invoke-Publish -Fixture $emptyFixture) -Script Publish -Class outbox -Detail outbox-record-invalid -Message "An ordinary publish beside a zero-byte record ($repair)"
        Assert-OrdinalEqual -Actual (Get-ConsumedStateFingerprint -Fixture $emptyFixture) -Expected $before -Message "The refused publish beside a zero-byte record mutates nothing ($repair)."
        if ($repair -ceq 'resync') {
            [void] (Read-Receipt -Result (Invoke-Publish -Fixture $emptyFixture -RepairOperationId 'jr-empty') -Message 'A resync beside a zero-byte record')
        }
        else {
            $abandon = Invoke-Switch -Fixture $emptyFixture -Owner bridge -Switches @('-AbandonUndelivered')
            Assert-Equal -Actual $abandon.ExitCode -Expected 0 -Message "An abandon release beside a zero-byte record completes ($($abandon.StdErr))."
            Assert-OrdinalEqual -Actual (Read-CompanionConsumerMarker -CompanionRoot $emptyFixture.Root).owner -Expected 'bridge' -Message 'The abandon release beside a zero-byte record names the bridge.'
        }
        $emptyTombstone = @((Read-Ledger -Fixture $emptyFixture)['settled'] | Where-Object { $_['sequence'] -eq 2 })
        Assert-Equal -Actual $emptyTombstone.Count -Expected 1 -Message "The $repair writes one tombstone for the zero-byte record."
        Assert-OrdinalEqual -Actual $emptyTombstone[0]['outcome'] -Expected 'quarantined' -Message "The $repair quarantines the zero-byte record."
        Assert-OrdinalEqual -Actual $emptyTombstone[0]['recordSha256'] -Expected $emptySha -Message "The $repair tombstones the zero-byte record under the SHA-256 of zero bytes."
        Assert-False -Condition ([IO.File]::Exists($emptyPath)) -Message "The $repair moves the zero-byte record out of the outbox."
        $emptyQuarantine = @([IO.Directory]::GetFiles((Join-Path (Get-OutboxPath -Fixture $emptyFixture) 'quarantine')))
        Assert-Equal -Actual $emptyQuarantine.Count -Expected 1 -Message "The $repair keeps one quarantine entry."
        Assert-Equal -Actual ([IO.FileInfo]::new($emptyQuarantine[0]).Length) -Expected 0L -Message "The $repair quarantine entry keeps the zero bytes."
        if ($repair -ceq 'resync') {
            $emptyIdentity = [pscustomobject]@{ logicalOutboxId = ($emptyOne.logicalOutboxId.Split('-')[0] + '-2'); sha256 = $emptySha; sequence = 2 }
            Assert-Terminal -Result (Invoke-Settle -Fixture $emptyFixture -Info $emptyIdentity) -Script Settlement -Class settlement -Detail settlement-quarantined -Message 'A settlement naming the zero-byte record'
        }
    }

    # An oversized record is quarantined under the SHA-256 of all its bytes, not of the prefix
    # the validator retains. A record one byte over the budget is retained whole and one two
    # bytes over is not, so the pair brackets the point where prefix and file part. Both are
    # spaces, so the retained prefix of the longer record is exactly the shorter record.
    $maxBytes = Invoke-InCompanionModule { (Get-CompanionJsonBudget -Budget 'state-event').MaxBytes }
    $largeFixture = New-RuntimeFixture -Prefix 'state-event-oversized'
    [void] (Read-Receipt -Result (Invoke-Publish -Fixture $largeFixture) -Message 'The oversized-record fixture record')
    $largeOne = Get-RecordInfo -Fixture $largeFixture -Name @(Get-RecordNames -Fixture $largeFixture)[0]
    $largeHashes = @{}
    foreach ($size in @{ Sequence = 2; Length = $maxBytes + 1 }, @{ Sequence = 3; Length = $maxBytes + 2 }) {
        $largeBytes = [byte[]]::new($size.Length)
        [Array]::Fill($largeBytes, [byte] 0x20)
        [IO.File]::WriteAllBytes((Join-Path (Get-OutboxPath -Fixture $largeFixture) ('event-{0:D16}.json' -f $size.Sequence)), $largeBytes)
        $largeHashes[$size.Sequence] = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($largeBytes)).ToLowerInvariant()
    }
    [void] (Read-Receipt -Result (Invoke-Publish -Fixture $largeFixture -RepairOperationId 'jr-oversized') -Message 'A resync beside two oversized records')
    foreach ($sequence in 2, 3) {
        $largeTombstone = @((Read-Ledger -Fixture $largeFixture)['settled'] | Where-Object { $_['sequence'] -eq $sequence })
        Assert-OrdinalEqual -Actual $largeTombstone[0]['outcome'] -Expected 'quarantined' -Message "Oversized record $sequence is quarantined."
        Assert-OrdinalEqual -Actual $largeTombstone[0]['recordSha256'] -Expected $largeHashes[$sequence] -Message "The quarantine tombstone of record $sequence carries the SHA-256 of all its bytes."
        $largeIdentity = [pscustomobject]@{ logicalOutboxId = ($largeOne.logicalOutboxId.Split('-')[0] + "-$sequence"); sha256 = $largeHashes[$sequence]; sequence = $sequence }
        Assert-Terminal -Result (Invoke-Settle -Fixture $largeFixture -Info $largeIdentity) -Script Settlement -Class settlement -Detail settlement-quarantined -Message "A settlement naming the full hash of oversized record $sequence"
    }
    $prefixIdentity = [pscustomobject]@{ logicalOutboxId = ($largeOne.logicalOutboxId.Split('-')[0] + '-3'); sha256 = $largeHashes[2]; sequence = 3 }
    Assert-Terminal -Result (Invoke-Settle -Fixture $largeFixture -Info $prefixIdentity) -Script Settlement -Class settlement -Detail settlement-unknown -Message 'A settlement naming only the retained prefix of an oversized record'

    # Equal-source records: a revived record beside a later digest stays superseded, and an
    # outstanding apply after a backwards clock step is still applied.
    $equalFixture = New-RuntimeFixture -Prefix 'state-event-equal-source'
    [void] (Read-Receipt -Result (Invoke-Publish -Fixture $equalFixture) -Message 'Equal-source record one')
    $first = Get-RecordInfo -Fixture $equalFixture -Name @(Get-RecordNames -Fixture $equalFixture)[0]
    $currentPath = Join-Path $equalFixture.State 'current.json'
    $current = Read-DigestDocument -Path $currentPath
    $earlier = [DateTime]::Parse($current.RootElement.GetProperty('generatedAt').GetString(), [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind).AddDays(-1).ToString('o', [Globalization.CultureInfo]::InvariantCulture)
    [IO.File]::WriteAllText($currentPath, $current.RootElement.GetRawText().Replace($current.RootElement.GetProperty('generatedAt').GetString(), $earlier), $script:Utf8)
    $deferred = Invoke-InModuleAttempt -Fixture $equalFixture -Seams @{ WriteBaseline = { param($Root, $Document) throw [IO.IOException]::new('injected') } }
    Assert-OrdinalEqual -Actual $deferred.result.kind -Expected 'consumed' -Message 'An equal-source digest with another generation is a consumed transition.'
    Assert-False -Condition $deferred.result.baselineApplied -Message 'The equal-source apply was deferred.'
    [void] (Invoke-Settle -Fixture $equalFixture -Info $first)
    $outstanding = Invoke-InModuleAttempt -Fixture $equalFixture
    Assert-OrdinalEqual -Actual $outstanding.result.stateEventOutcome -Expected 'unchanged' -Message 'The publish after the deferred equal-source apply finds nothing new.'
    Assert-True -Condition (Read-BaselineIdentity -Fixture $equalFixture).StartsWith($earlier + '|', [StringComparison]::Ordinal) -Message 'An outstanding equal-source record is applied even though its generation is earlier.'
}

# ---------------------------------------------------------------------------------
if (Test-Selected 'VersionChange') {
    foreach ($case in @(
            @{ Name = 'schema'; Field = 'schemaVersion'; Value = 1; Structural = $true },
            @{ Name = 'adapter'; Field = 'adapterVersion'; Value = 1; Structural = $false })) {
        $fixture = New-RuntimeFixture -Prefix 'state-event-version'
        [void] (Read-Receipt -Result (Invoke-Publish -Fixture $fixture) -Message 'Version fixture record')
        $info = Get-RecordInfo -Fixture $fixture -Name @(Get-RecordNames -Fixture $fixture)[0]
        [void] (Invoke-Settle -Fixture $fixture -Info $info)
        $node = [Text.Json.Nodes.JsonNode]::Parse($script:Utf8.GetString($info.bytes))
        $node['sequence'] = [Text.Json.Nodes.JsonValue]::Create(2)
        $node['logicalOutboxId'] = [Text.Json.Nodes.JsonValue]::Create($node['incarnationId'].GetValue[string]() + '-2')
        $node['diff'][$case.Field] = [Text.Json.Nodes.JsonValue]::Create($case.Value)
        $node['state'][$case.Field] = [Text.Json.Nodes.JsonValue]::Create($case.Value)
        if ($case.Field -ceq 'adapterVersion') { $node['adapterVersion'] = [Text.Json.Nodes.JsonValue]::Create($case.Value) }
        $staleBytes = $script:Utf8.GetBytes($node.ToJsonString())
        [IO.File]::WriteAllBytes((Join-Path (Get-OutboxPath -Fixture $fixture) 'event-0000000000000002.json'), $staleBytes)
        if ($case.Structural) {
            $before = Get-ConsumedStateFingerprint -Fixture $fixture
            Assert-Terminal -Result (Invoke-Publish -Fixture $fixture) -Script Publish -Class outbox -Detail outbox-record-invalid -Message 'A publish beside a record of another schema version'
            $stale = [pscustomobject]@{ logicalOutboxId = $node['logicalOutboxId'].GetValue[string](); sha256 = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($staleBytes)).ToLowerInvariant(); sequence = 2 }
            Assert-Terminal -Result (Invoke-Settle -Fixture $fixture -Info $stale) -Script Settlement -Class outbox -Detail outbox-record-invalid -Message 'A settlement beside a record of another schema version'
            Assert-Terminal -Result (Invoke-Switch -Fixture $fixture -Owner runtime) -Script Consumer -Class outbox -Detail outbox-record-invalid -Message 'A hand-over beside a record of another schema version'
            Assert-OrdinalEqual -Actual (Get-ConsumedStateFingerprint -Fixture $fixture) -Expected $before -Message 'An outbox-record-invalid stop mutates nothing.'
        }
        else {
            Assert-Equal -Actual (Invoke-Publish -Fixture $fixture).ExitCode -Expected 0 -Message 'An adapter version change alone leaves ordinary publishes working.'
        }
        $repair = Read-Receipt -Result (Invoke-Publish -Fixture $fixture -RepairOperationId "jr-$($case.Name)") -Message "The $($case.Name) version repair"
        Assert-OrdinalEqual -Actual $repair['kind'] -Expected 'resync' -Message "The $($case.Name) version repair commits a resync."
        $quarantine = @([IO.Directory]::GetFiles((Join-Path (Get-OutboxPath -Fixture $fixture) 'quarantine')))
        Assert-Equal -Actual $quarantine.Count -Expected 1 -Message "The $($case.Name) version repair quarantines the old record."
        Assert-True -Condition ([Linq.Enumerable]::SequenceEqual[byte]($staleBytes, [IO.File]::ReadAllBytes($quarantine[0]))) -Message "The quarantined $($case.Name) record keeps its exact bytes."
    }

    # A resync whose bytes became producer-invalid before it was drained is quarantined by the
    # repeated -Resync, which then commits a fresh resync instead of replaying the quarantined one.
    $fixture = New-RuntimeFixture -Prefix 'state-event-resync-damaged'
    $first = Read-Receipt -Result (Invoke-Publish -Fixture $fixture -RepairOperationId 'jr-damaged') -Message 'The first resync'
    $info = Get-RecordInfo -Fixture $fixture -Name @(Get-RecordNames -Fixture $fixture)[-1]
    $node = [Text.Json.Nodes.JsonNode]::Parse($script:Utf8.GetString($info.bytes))
    Set-RecordAdapterVersion -Node $node
    [IO.File]::WriteAllBytes((Join-Path (Get-OutboxPath -Fixture $fixture) $info.name), $script:Utf8.GetBytes($node.ToJsonString()))
    $second = Read-Receipt -Result (Invoke-Publish -Fixture $fixture -RepairOperationId 'jr-damaged') -Message 'The repeated resync after damage'
    Assert-OrdinalEqual -Actual $second['outcome'] -Expected 'committed' -Message 'A quarantined resync is not replayed.'
    Assert-OrdinalEqual -Actual $second['kind'] -Expected 'resync' -Message 'The repeat commits a fresh resync.'
    Assert-True -Condition ($second['logicalOutboxId'] -cne $first['logicalOutboxId']) -Message 'The fresh resync has its own identity.'
    $damagedTombstones = @((Read-Ledger -Fixture $fixture)['settled'] | Where-Object { $_['outcome'] -ceq 'quarantined' -and $_['repairOperationId'] -ceq 'jr-damaged' })
    Assert-Equal -Actual $damagedTombstones.Count -Expected 1 -Message 'The quarantine tombstone keeps the repair identifier.'
    $third = Read-Receipt -Result (Invoke-Publish -Fixture $fixture -RepairOperationId 'jr-damaged') -Message 'A further repeat'
    Assert-OrdinalEqual -Actual $third['outcome'] -Expected 'replayed' -Message 'The live resync replays.'
    Assert-OrdinalEqual -Actual $third['logicalOutboxId'] -Expected $second['logicalOutboxId'] -Message 'The replay names the fresh resync.'

    # A structurally admitted non-resync tombstone with the repair token cannot authorize the
    # quarantine fence, even when it is newer than a rejected record.
    $fixture = New-RuntimeFixture -Prefix 'state-event-nonresync-authority'
    $consumed = Read-Receipt -Result (Invoke-Publish -Fixture $fixture) -Message 'The non-resync fixture consumed record'
    $first = Get-RecordInfo -Fixture $fixture -Name @(Get-RecordNames -Fixture $fixture)[0]
    $snapshot = Read-Receipt -Result (Invoke-Publish -Fixture $fixture -RequireRecord) -Message 'The non-resync fixture snapshot'
    $second = Get-RecordInfo -Fixture $fixture -Name @(Get-RecordNames -Fixture $fixture)[-1]
    Assert-OrdinalEqual -Actual $consumed['kind'] -Expected 'consumed' -Message 'The first fixture record is consumed.'
    Assert-OrdinalEqual -Actual $snapshot['kind'] -Expected 'snapshot' -Message 'The second fixture record is a snapshot.'
    Assert-OrdinalEqual -Actual (Read-StateEventSettlementResult -Json (Invoke-Settle -Fixture $fixture -Info $first).StdOut).Materialized['outcome'] -Expected 'settled' -Message 'The consumed record settles.'
    Assert-OrdinalEqual -Actual (Read-StateEventSettlementResult -Json (Invoke-Settle -Fixture $fixture -Info $second).StdOut).Materialized['outcome'] -Expected 'settled' -Message 'The snapshot settles.'
    $tombstoneKind = Invoke-InCompanionModule {
        param($Root)
        $ledger = (Read-StateEventLedger -CompanionRoot $Root).ledger
        $entry = @($ledger.settled | Where-Object { $_.sequence -eq 2 })[0]
        if ($null -eq $entry -or $entry.kind -cne 'snapshot' -or $entry.outcome -cne 'delivered') { throw 'Unexpected non-resync fixture tombstone.' }
        $entry.repairOperationId = 'jr-nonresync-authority'
        Write-StateEventLedger -CompanionRoot $Root -Ledger $ledger -ExistingRecordSequences @()
        return (Read-StateEventLedger -CompanionRoot $Root).ledger.settled[1].kind
    } @($fixture.Root)
    Assert-OrdinalEqual -Actual $tombstoneKind -Expected 'snapshot' -Message 'The inconsistent tombstone remains structurally admitted.'
    $node = [Text.Json.Nodes.JsonNode]::Parse($script:Utf8.GetString($first.bytes))
    Set-RecordAdapterVersion -Node $node
    $rejectedBytes = $script:Utf8.GetBytes($node.ToJsonString())
    [IO.File]::WriteAllBytes((Join-Path (Get-OutboxPath -Fixture $fixture) $first.name), $rejectedBytes)
    $fresh = Read-Receipt -Result (Invoke-Publish -Fixture $fixture -RepairOperationId 'jr-nonresync-authority') -Message 'The resync after non-resync authority'
    Assert-OrdinalEqual -Actual $fresh['outcome'] -Expected 'committed' -Message 'A snapshot tombstone cannot replay as a resync.'
    Assert-OrdinalEqual -Actual $fresh['kind'] -Expected 'resync' -Message 'The repair commits actual resync disclosure.'
    Assert-Equal -Actual $fresh['sequence'] -Expected 3L -Message 'The resync is above the rejected record and snapshot.'
    $quarantine = @([IO.Directory]::GetFiles((Join-Path (Get-OutboxPath -Fixture $fixture) 'quarantine')))
    Assert-Equal -Actual $quarantine.Count -Expected 1 -Message 'The fresh resync permits one quarantine move.'
    Assert-True -Condition ([Linq.Enumerable]::SequenceEqual[byte]($rejectedBytes, [IO.File]::ReadAllBytes($quarantine[0]))) -Message 'The quarantine preserves the rejected bytes.'
    $resyncInfo = Get-RecordInfo -Fixture $fixture -Name @(Get-RecordNames -Fixture $fixture)[0]
    Assert-OrdinalEqual -Actual (Read-StateEventSettlementResult -Json (Invoke-Settle -Fixture $fixture -Info $resyncInfo).StdOut).Materialized['outcome'] -Expected 'settled' -Message 'The actual resync settles.'
    $again = Read-Receipt -Result (Invoke-Publish -Fixture $fixture -RepairOperationId 'jr-nonresync-authority') -Message 'The delivered resync replay'
    Assert-OrdinalEqual -Actual $again['outcome'] -Expected 'replayed' -Message 'A delivered resync remains valid replay authority.'
    Assert-OrdinalEqual -Actual $again['kind'] -Expected 'resync' -Message 'The delivered resync replay keeps its kind.'

    # A repeated -Resync that rejects a pending record above its identifier's live resync
    # commits a fresh resync before it fences that record, so the set-aside is never durable
    # without the disclosure after it: a failed fence write, a kill between the commit and the
    # fence, and a failed commit each leave the record pending and unfenced, and the next
    # -Resync replays the highest-sequence live resync and fences it.
    foreach ($case in @('clean', 'fence-fails', 'killed', 'commit-fails')) {
        $fixture = New-RuntimeFixture -Prefix "state-event-resync-aside-$case"
        $first = Read-Receipt -Result (Invoke-Publish -Fixture $fixture -RepairOperationId 'jr-aside') -Message "The $case resync before a record is set aside"
        Add-NewerSave -Fixture $fixture -Name 's-b.zip'
        $consumed = Read-Receipt -Result (Invoke-Publish -Fixture $fixture) -Message "A $case consumed record after the resync"
        Assert-OrdinalEqual -Actual $consumed['kind'] -Expected 'consumed' -Message "The $case newer save commits a consumed record."
        $info = Get-RecordInfo -Fixture $fixture -Name @(Get-RecordNames -Fixture $fixture)[-1]
        $node = [Text.Json.Nodes.JsonNode]::Parse($script:Utf8.GetString($info.bytes))
        Set-RecordAdapterVersion -Node $node
        $asidePath = Join-Path (Get-OutboxPath -Fixture $fixture) $info.name
        [IO.File]::WriteAllBytes($asidePath, $script:Utf8.GetBytes($node.ToJsonString()))
        $fenced = { @((Read-Ledger -Fixture $fixture)['settled'] | Where-Object { $_['sequence'] -eq $info.sequence -and $_['outcome'] -ceq 'quarantined' }).Count -eq 1 }
        $fresh = $null
        switch ($case) {
            'clean' {
                $second = Read-Receipt -Result (Invoke-Publish -Fixture $fixture -RepairOperationId 'jr-aside') -Message 'The repeated resync that sets a record aside'
                Assert-OrdinalEqual -Actual $second['outcome'] -Expected 'committed' -Message 'A resync below a rejected record is not replayed.'
                Assert-OrdinalEqual -Actual $second['kind'] -Expected 'resync' -Message 'It commits a fresh resync.'
                Assert-True -Condition (& $fenced) -Message 'The fresh resync fences the rejected record.'
                $fresh = $second['logicalOutboxId']
            }
            'fence-fails' {
                $deferred = Invoke-InModuleAttempt -Fixture $fixture -RepairOperationId 'jr-aside' -Seams @{ WriteLedger = { param($Root, $Ledger, $Existing) throw [IO.IOException]::new('injected fence failure') } }
                Assert-OrdinalEqual -Actual $deferred.result.stateEventOutcome -Expected 'committed' -Message 'A failed fence write keeps the commit.'
                Assert-True -Condition ($deferred.receiptWarnings -ccontains 'outbox-quarantine-deferred') -Message 'A failed fence write adds outbox-quarantine-deferred.'
                $fresh = $deferred.result.logicalOutboxId
            }
            'killed' {
                Set-StagedKillPoint -Fixture $fixture -RelativePath 'private/StateEvents.ps1' -Anchor '        if ($Resync) { Invoke-StateEventResyncFence' -Name 'resync-before-fence'
                Invoke-Killed -Action { Invoke-Publish -Fixture $fixture -RepairOperationId 'jr-aside' -Environment @{ COMPANION_TEST_STATE_EVENT_KILL = 'resync-before-fence' } } -Message 'A resync killed between its commit and its fence'
                $fresh = (Get-RecordInfo -Fixture $fixture -Name @(Get-RecordNames -Fixture $fixture)[-1]).logicalOutboxId
            }
            'commit-fails' {
                $failed = Invoke-InModuleAttempt -Fixture $fixture -RepairOperationId 'jr-aside' -Seams @{ CommitRecord = { param($Path, $Bytes) throw [IO.IOException]::new('injected commit failure') } }
                Assert-OrdinalEqual -Actual $failed.result.outcomeClass -Expected 'outbox-write:not-consumed' -Message 'A failed commit consumes nothing.'
                Assert-Equal -Actual @(Get-RecordNames -Fixture $fixture).Count -Expected 2 -Message 'A failed commit adds no record.'
            }
        }
        if ($case -cne 'clean') {
            Assert-False -Condition (& $fenced) -Message "After a $case resync the rejected record is not fenced."
            Assert-True -Condition ([IO.File]::Exists($asidePath)) -Message "After a $case resync the rejected record stays pending."
            $next = Read-Receipt -Result (Invoke-Publish -Fixture $fixture -RepairOperationId 'jr-aside') -Message "The resync after the $case one"
            if ($null -eq $fresh) {
                Assert-OrdinalEqual -Actual $next['outcome'] -Expected 'committed' -Message 'With no live resync above the record, the next resync commits.'
                $fresh = $next['logicalOutboxId']
            }
            else {
                Assert-OrdinalEqual -Actual $next['outcome'] -Expected 'replayed' -Message "After a $case resync the next one replays."
                Assert-OrdinalEqual -Actual $next['logicalOutboxId'] -Expected $fresh -Message "After a $case resync the replay names the live resync above the record."
            }
            Assert-True -Condition (& $fenced) -Message "After a $case resync the next one fences the record."
        }
        Assert-False -Condition ([IO.File]::Exists($asidePath)) -Message "The $case rejected record leaves the outbox."
        Assert-True -Condition ($fresh -cne $first['logicalOutboxId']) -Message "The $case disclosure is a fresh resync with its own identity."
        $repeat = Read-Receipt -Result (Invoke-Publish -Fixture $fixture -RepairOperationId 'jr-aside') -Message "A $case repeat that rejects nothing"
        Assert-OrdinalEqual -Actual $repeat['outcome'] -Expected 'replayed' -Message "A $case repeat that rejects nothing replays."
        Assert-OrdinalEqual -Actual $repeat['logicalOutboxId'] -Expected $fresh -Message "A $case replay names the highest-sequence live resync."
    }
}

# ---------------------------------------------------------------------------------
if (Test-Selected 'ReceiptIndependence') {
    $fixture = New-RuntimeFixture -Prefix 'state-event-receipt'
    $startInfo = [Diagnostics.ProcessStartInfo]::new('pwsh')
    foreach ($argument in @('-NoProfile', '-File', (Join-Path $fixture.Core 'Publish-StateEvent.ps1'), '-Principal', $script:Principal)) { $startInfo.ArgumentList.Add($argument) }
    $startInfo.WorkingDirectory = $fixture.Root
    $startInfo.UseShellExecute = $false
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $process = [Diagnostics.Process]::Start($startInfo)
    try {
        $process.StandardOutput.Close()
        $stderrTask = $process.StandardError.ReadToEndAsync()
        Assert-True -Condition $process.WaitForExit(240000) -Message 'The closed-stdout publish exits.'
        $closedResult = [pscustomobject]@{ ExitCode = $process.ExitCode; StdOut = ''; StdErr = $stderrTask.GetAwaiter().GetResult() }
    }
    finally { $process.Dispose() }
    # .NET's console stream ignores a broken stdout pipe, so the receipt write may report
    # success or a consumed delivery failure; either way the record carries the transition.
    if ($closedResult.ExitCode -ne 0) { Assert-Terminal -Result $closedResult -Script Publish -Class delivery -Detail stdout-write-failed -ConsumptionState consumed -Message 'A publish whose stdout is closed' }
    $names = @(Get-RecordNames -Fixture $fixture)
    Assert-Equal -Actual @($names).Count -Expected 1 -Message 'The record of an undelivered receipt is in the outbox.'
    [void] (Read-StateEventRecord -Bytes ([IO.File]::ReadAllBytes((Join-Path (Get-OutboxPath -Fixture $fixture) $names[0]))))
}

Write-Output 'PASS: state events'
