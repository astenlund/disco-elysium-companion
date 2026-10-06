$script:ConsumerMarkerFileName = 'consumer.json'
$script:StateEventOutboxName = 'outbox'
$script:StateEventLedgerFileName = 'ledger.json'
$script:StateEventQuarantineName = 'quarantine'
# The 7.6 closed grammars end in '\z': '$' would also match before one trailing line feed.
$script:StateEventRecordNamePattern = '\Aevent-([0-9]{16})\.json\z'
$script:StateEventSiblingPattern = '\A.+\.[0-9a-f]{32}\.(?:tmp|bak)\z'
$script:StateEventIncarnationFragment = '[0-9a-f]{32}'
$script:StateEventIncarnationPattern = '\A' + $script:StateEventIncarnationFragment + '\z'
$script:StateEventLogicalOutboxIdPattern = '\A(' + $script:StateEventIncarnationFragment + ')-([1-9][0-9]{0,15})\z'
$script:StateEventSha256Pattern = '\A[0-9a-f]{64}\z'
$script:StateEventSequenceMaximum = 9007199254740991L
$script:StateEventPendingLimit = 16
$script:StateEventChildLimit = 1024
$script:StateEventTombstoneMaximumAge = [TimeSpan]::FromDays(180)
$script:StateEventTombstoneMaximumCount = 512
$script:StateEventQuarantineMaximumEntries = 64
$script:StateEventDiagnosticByteCap = 4096
$script:StateEventReceiptByteCap = 4096
$script:StateEventRecordKinds = @('consumed', 'snapshot', 'resync')
$script:StateEventTombstoneOutcomes = @('delivered', 'abandoned', 'quarantined')
$script:StateEventRecordFields = @('stateEventVersion', 'logicalOutboxId', 'incarnationId', 'sequence', 'kind', 'createdAt', 'principal', 'repairOperationId', 'adapterVersion', 'game', 'baseline', 'sourceFloor', 'refresh', 'warnings', 'baselineReset', 'diff', 'state')
$script:StateEventTombstoneFields = @('sequence', 'outcome', 'recordSha256', 'logicalOutboxId', 'kind', 'journalId', 'eventId', 'repairOperationId', 'settledAt')
$script:StateEventRecordWarningCodes = @(@($script:CompanionWarningProfiles['TurnAttempt']) + @($script:CompanionWarningProfiles['TurnOperational']) | Where-Object { $_ -cne 'consume-cache-fallback' })
$script:StateEventReceiptWarningCodes = @($script:CompanionWarningProfiles['TurnOperational']) + @($script:CompanionWarningProfiles['StateEventReceipt'])

$script:StateEventConsumerReasons = @('consumer-not-owner', 'consumer-owner-invalid', 'consumer-owner-unreadable', 'consumer-outbox-pending')
$script:StateEventOutboxReasons = @('outbox-setup-failed', 'outbox-record-invalid', 'outbox-apply-failed', 'outbox-full', 'outbox-sequence-exhausted', 'outbox-write-failed')
$script:StateEventReasons = @{
    Publish = @{
        config = @($script:TurnContextReasons['config']) + @('principal-invalid', 'repair-operation-invalid')
        outbox = $script:StateEventOutboxReasons
        'outbox-write:not-consumed' = @('record-serialize-failed', 'record-temp-write-failed', 'record-commit-failed')
        busy = $script:TurnContextReasons['busy']
        lock = $script:TurnContextReasons['lock']
        'stale-target' = $script:TurnContextReasons['stale-target']
        'no-saves' = $script:TurnContextReasons['no-saves']
        stability = $script:TurnContextReasons['stability']
        source = $script:TurnContextReasons['source']
        dump = $script:TurnContextReasons['dump']
        digest = $script:TurnContextReasons['digest']
        refresh = $script:TurnContextReasons['refresh']
        freshness = $script:TurnContextReasons['freshness']
        compute = $script:TurnContextReasons['compute']
        protocol = $script:TurnContextReasons['protocol']
        delivery = $script:TurnContextReasons['delivery']
    }
    Settlement = @{
        config = @($script:StateEventConsumerReasons) + @('companion-root-invalid', 'settlement-argument-invalid')
        busy = @('lock-timeout')
        lock = @('lock-open-failed')
        compute = @('baseline-read-failed')
        outbox = $script:StateEventOutboxReasons
        settlement = @('settlement-unknown', 'settlement-conflict', 'settlement-quarantined', 'settlement-hash-mismatch', 'settlement-out-of-order')
        protocol = @('attempt-result-invalid')
        delivery = @('stdout-write-failed')
    }
    Consumer = @{
        config = @('consumer-owner-unreadable', 'companion-root-invalid', 'owner-argument-invalid', 'release-switch-invalid', 'release-decision-required', 'release-pending-records')
        busy = @('lock-timeout')
        lock = @('lock-open-failed')
        compute = @('baseline-read-failed')
        outbox = $script:StateEventOutboxReasons
        protocol = @('attempt-result-invalid')
        delivery = @('stdout-write-failed')
    }
}
# Classes whose reasons this section adds; every other class keeps its 7.5 reasons, atoms, and provenance rules.
$script:StateEventAddedClasses = @('outbox', 'outbox-write:not-consumed', 'settlement')

class StateEventFailure : System.Exception {
    [string] $OutcomeClass
    [string] $Reason

    StateEventFailure([string] $OutcomeClass, [string] $Reason) : base("$OutcomeClass/$Reason") {
        $this.OutcomeClass = $OutcomeClass
        $this.Reason = $Reason
    }
}

function Stop-StateEventOperation {
    param([Parameter(Mandatory)] [string] $Class, [Parameter(Mandatory)] [string] $Reason)

    throw [StateEventFailure]::new($Class, $Reason)
}

function Get-StateEventUtcNow {
    return [DateTime]::UtcNow.ToString('o', [Globalization.CultureInfo]::InvariantCulture)
}

function Get-StateEventOutboxPath {
    param([Parameter(Mandatory)] [string] $CompanionRoot)

    return Get-CompanionStatePath -CompanionRoot $CompanionRoot -Name $script:StateEventOutboxName
}

function Get-StateEventRecordName {
    param([Parameter(Mandatory)] [long] $Sequence)

    return 'event-' + $Sequence.ToString('D16', [Globalization.CultureInfo]::InvariantCulture) + '.json'
}

function Get-StateEventLogicalOutboxId {
    param([Parameter(Mandatory)] [string] $IncarnationId, [Parameter(Mandatory)] [long] $Sequence)

    return $IncarnationId + '-' + $Sequence.ToString([Globalization.CultureInfo]::InvariantCulture)
}

# Reads a 7.6 file in one bounded pass, retaining only the budget plus one byte for validation.
# With -Hash the pass continues to the end of the file, so a quarantined oversized record keeps
# the SHA-256 of its exact bytes rather than of the retained prefix.
function Read-StateEventFileBytes {
    param([Parameter(Mandatory)] [string] $Path, [Parameter(Mandatory)] [string] $Budget, [switch] $Hash)

    $maximumRead = (Get-CompanionJsonBudget -Budget $Budget).MaxBytes + 1
    $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
    $hasher = if ($Hash) { [Security.Cryptography.IncrementalHash]::CreateHash([Security.Cryptography.HashAlgorithmName]::SHA256) } else { $null }
    try {
        $buffer = [IO.MemoryStream]::new()
        $chunk = [byte[]]::new(81920)
        while (($read = $stream.Read($chunk, 0, $chunk.Length)) -gt 0) {
            if ($null -ne $hasher) { $hasher.AppendData($chunk, 0, $read) }
            $remaining = $maximumRead - $buffer.Length
            if ($remaining -gt 0) { $buffer.Write($chunk, 0, [Math]::Min($read, [int] $remaining)) }
            elseif ($null -eq $hasher) { break }
        }
        $sha256 = if ($null -ne $hasher) { [Convert]::ToHexString($hasher.GetHashAndReset()).ToLowerInvariant() } else { $null }
    }
    finally {
        if ($null -ne $hasher) { $hasher.Dispose() }
        $stream.Dispose()
    }

    return [pscustomobject]@{ bytes = $buffer.ToArray(); sha256 = $sha256 }
}

# Parses the bytes of a 7.6 file. A zero-byte file was read completely and then fails to parse,
# which 7.6 defines as invalid content, so it raises the parse failure here; the shared reader
# would reject its empty input at parameter binding, which callers report as unreadable.
function ConvertFrom-StateEventJsonBytes {
    param([Parameter(Mandatory)] [AllowEmptyCollection()] [byte[]] $Bytes, [Parameter(Mandatory)] [string] $Budget)

    if ($Bytes.Length -eq 0) { throw [CompanionJsonParseException]::new('Companion JSON is empty.') }
    try { $json = $script:CompanionJsonUtf8.GetString($Bytes) }
    catch { throw [CompanionJsonParseException]::new('Companion JSON is not strict UTF-8.', $_.Exception) }

    return Read-CompanionJson -Json $json -Budget $Budget
}

function New-StateEventIncarnationId {
    return [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(16)).ToLowerInvariant()
}

# The shared opaque-token profile: NFC UTF-8, no C0 or C1 control characters, 1 to 128
# Unicode scalars, and at most 512 UTF-8 bytes. A lone surrogate fails strict encoding.
function Test-CompanionOpaqueToken {
    param([AllowNull()] [object] $Value)

    if ($Value -isnot [string] -or $Value.Length -eq 0) { return $false }
    try {
        if ($script:CompanionJsonUtf8.GetByteCount($Value) -gt 512) { return $false }
        if (-not $Value.IsNormalized([Text.NormalizationForm]::FormC)) { return $false }
    }
    catch { return $false }
    $scalars = 0
    foreach ($rune in $Value.EnumerateRunes()) {
        $scalars++
        if ($rune.Value -le 0x1F -or ($rune.Value -ge 0x80 -and $rune.Value -le 0x9F)) { return $false }
    }

    return $scalars -ge 1 -and $scalars -le 128
}

function Test-StateEventSequenceValue {
    param([Parameter(Mandatory)] [long] $Value)

    return $Value -ge 1 -and $Value -le $script:StateEventSequenceMaximum
}

function Test-StateEventLogicalOutboxIdText {
    param([AllowNull()] [object] $Value)

    if ($Value -isnot [string] -or $Value -cnotmatch $script:StateEventLogicalOutboxIdPattern) { return $false }
    $sequence = 0L
    if (-not [long]::TryParse($Matches[2], [Globalization.NumberStyles]::None, [Globalization.CultureInfo]::InvariantCulture, [ref] $sequence)) { return $false }

    return Test-StateEventSequenceValue -Value $sequence
}

function Test-StateEventSha256Text {
    param([AllowNull()] [object] $Value)

    return $Value -is [string] -and $Value -cmatch $script:StateEventSha256Pattern
}

# --- Consumer ownership ------------------------------------------------------------

function Read-CompanionConsumerMarker {
    param([Parameter(Mandatory)] [string] $CompanionRoot)

    $path = Get-CompanionStatePath -CompanionRoot $CompanionRoot -Name $script:ConsumerMarkerFileName
    try { $document = ConvertFrom-StateEventJsonBytes -Bytes (Read-StateEventFileBytes -Path $path -Budget config).bytes -Budget config }
    catch [IO.FileNotFoundException] { return [pscustomobject]@{ outcome = 'absent'; owner = $null } }
    catch [IO.DirectoryNotFoundException] { return [pscustomobject]@{ outcome = 'absent'; owner = $null } }
    catch [CompanionContentException] { return [pscustomobject]@{ outcome = 'content-invalid'; owner = $null } }
    catch { return [pscustomobject]@{ outcome = 'infrastructure-failure'; owner = $null } }
    try {
        $root = $document.RootElement
        Test-ExactFields $root @('consumerVersion', 'owner', 'changedAt')
        if ((Test-Integer (Get-Property $root consumerVersion)) -ne 1) { Fail-Document }
        $owner = Test-String (Get-Property $root owner)
        if ($owner -cnotin @('bridge', 'runtime')) { Fail-Document }
        Test-Utc (Get-Property $root changedAt)
    }
    catch [CompanionDocumentValidationException] { return [pscustomobject]@{ outcome = 'content-invalid'; owner = $null } }

    return [pscustomobject]@{ outcome = 'valid'; owner = $owner }
}

# Record file names directly under state\outbox\, ascending. An absent directory is no
# record; every other enumeration failure propagates to the caller's classification.
function Get-StateEventRecordFileNames {
    param([Parameter(Mandatory)] [string] $CompanionRoot)

    $outbox = Get-StateEventOutboxPath -CompanionRoot $CompanionRoot
    $names = [Collections.Generic.List[string]]::new()
    try {
        foreach ($path in [IO.Directory]::EnumerateFiles($outbox)) {
            $name = [IO.Path]::GetFileName($path)
            if ($name -cmatch $script:StateEventRecordNamePattern) { $names.Add($name) }
        }
    }
    catch [IO.DirectoryNotFoundException] { return @() }
    $sorted = $names.ToArray()
    [Array]::Sort($sorted, [StringComparer]::Ordinal)

    return $sorted
}

# The authoritative ownership check of 7.6. Returns null to proceed, otherwise the config
# reason. The bridge role counts record files without consulting the ledger.
function Get-CompanionOwnershipFailure {
    param([Parameter(Mandatory)] [string] $CompanionRoot, [Parameter(Mandatory)] [ValidateSet('bridge', 'runtime')] [string] $Role)

    $marker = Read-CompanionConsumerMarker -CompanionRoot $CompanionRoot
    if ($marker.outcome -ceq 'content-invalid') { return 'consumer-owner-invalid' }
    if ($marker.outcome -ceq 'infrastructure-failure') { return 'consumer-owner-unreadable' }
    $owner = if ($marker.outcome -ceq 'absent') { 'bridge' } else { $marker.owner }
    if ($Role -ceq 'runtime') {
        if ($owner -ceq 'runtime') { return $null }

        return 'consumer-not-owner'
    }
    if ($owner -ceq 'runtime') { return 'consumer-not-owner' }
    try { $count = @(Get-StateEventRecordFileNames -CompanionRoot $CompanionRoot).Count }
    catch { return 'consumer-owner-unreadable' }
    if ($count -gt 0) { return 'consumer-outbox-pending' }

    return $null
}

function Write-CompanionConsumerMarker {
    param([Parameter(Mandatory)] [string] $CompanionRoot, [Parameter(Mandatory)] [ValidateSet('bridge', 'runtime')] [string] $Owner)

    $document = [ordered]@{ consumerVersion = 1; owner = $Owner; changedAt = (Get-StateEventUtcNow) }
    Write-CompanionStateJson -Path (Get-CompanionStatePath -CompanionRoot $CompanionRoot -Name $script:ConsumerMarkerFileName) -Document $document -Budget config
}

# --- Ledger ------------------------------------------------------------------------

function ConvertFrom-StateEventLedgerDocument {
    param([Parameter(Mandatory)] [CompanionJsonValue] $Document)

    $root = $Document.RootElement
    Test-ExactFields $root @('outboxLedgerVersion', 'incarnationId', 'highWaterSequence', 'settled')
    if ((Test-Integer (Get-Property $root outboxLedgerVersion)) -ne 1) { Fail-Document }
    $incarnation = Test-String (Get-Property $root incarnationId)
    if ($incarnation -cnotmatch $script:StateEventIncarnationPattern) { Fail-Document }
    $highWater = Test-Integer (Get-Property $root highWaterSequence) $true
    if ($highWater -gt $script:StateEventSequenceMaximum) { Fail-Document }
    $settledElement = Get-Property $root settled
    Test-ElementKind $settledElement Array
    $settled = [Collections.Generic.List[object]]::new()
    $previous = 0L
    foreach ($entry in $settledElement.EnumerateArray()) {
        Test-ExactFields $entry $script:StateEventTombstoneFields
        $sequence = Test-Integer (Get-Property $entry sequence) $false $true
        if (-not (Test-StateEventSequenceValue -Value $sequence) -or $sequence -le $previous -or $sequence -gt $highWater) { Fail-Document }
        $previous = $sequence
        $outcome = Test-String (Get-Property $entry outcome)
        if ($outcome -cnotin $script:StateEventTombstoneOutcomes) { Fail-Document }
        $sha = Test-String (Get-Property $entry recordSha256)
        if (-not (Test-StateEventSha256Text -Value $sha)) { Fail-Document }
        $logicalElement = Get-Property $entry logicalOutboxId
        $kindElement = Get-Property $entry kind
        $logical = $null
        $kind = $null
        if ($logicalElement.ValueKind -eq [Text.Json.JsonValueKind]::Null -or $kindElement.ValueKind -eq [Text.Json.JsonValueKind]::Null) {
            if ($outcome -cne 'quarantined' -or $logicalElement.ValueKind -ne $kindElement.ValueKind) { Fail-Document }
        }
        else {
            $logical = Test-String $logicalElement
            if (-not (Test-StateEventLogicalOutboxIdText -Value $logical) -or -not $logical.EndsWith('-' + $sequence.ToString([Globalization.CultureInfo]::InvariantCulture), [StringComparison]::Ordinal)) { Fail-Document }
            $kind = Test-String $kindElement
            if ($kind -cnotin $script:StateEventRecordKinds) { Fail-Document }
        }
        $journalElement = Get-Property $entry journalId
        $eventElement = Get-Property $entry eventId
        $journalId = $null
        $eventId = $null
        if ($outcome -ceq 'delivered') {
            $journalId = Test-String $journalElement
            $eventId = Test-String $eventElement
            if (-not (Test-CompanionOpaqueToken -Value $journalId) -or -not (Test-CompanionOpaqueToken -Value $eventId)) { Fail-Document }
        }
        elseif ($journalElement.ValueKind -ne [Text.Json.JsonValueKind]::Null -or $eventElement.ValueKind -ne [Text.Json.JsonValueKind]::Null) { Fail-Document }
        $repairElement = Get-Property $entry repairOperationId
        $repair = $null
        if ($repairElement.ValueKind -ne [Text.Json.JsonValueKind]::Null) {
            $repair = Test-String $repairElement
            if (-not (Test-CompanionOpaqueToken -Value $repair)) { Fail-Document }
        }
        Test-Utc (Get-Property $entry settledAt)
        $settled.Add([ordered]@{ sequence = $sequence; outcome = $outcome; recordSha256 = $sha; logicalOutboxId = $logical; kind = $kind; journalId = $journalId; eventId = $eventId; repairOperationId = $repair; settledAt = (Get-Property $entry settledAt).GetString() })
    }

    return [pscustomobject]@{ incarnationId = $incarnation; highWaterSequence = $highWater; settled = $settled }
}

function Read-StateEventLedger {
    param([Parameter(Mandatory)] [string] $CompanionRoot)

    $path = Join-Path (Get-StateEventOutboxPath -CompanionRoot $CompanionRoot) $script:StateEventLedgerFileName
    try { $document = ConvertFrom-StateEventJsonBytes -Bytes (Read-StateEventFileBytes -Path $path -Budget config).bytes -Budget config }
    catch [IO.FileNotFoundException] { return [pscustomobject]@{ outcome = 'absent'; ledger = $null } }
    catch [IO.DirectoryNotFoundException] { return [pscustomobject]@{ outcome = 'absent'; ledger = $null } }
    catch [CompanionContentException] { return [pscustomobject]@{ outcome = 'content-invalid'; ledger = $null } }
    catch { return [pscustomobject]@{ outcome = 'infrastructure-failure'; ledger = $null } }
    try { $ledger = ConvertFrom-StateEventLedgerDocument -Document $document }
    catch [CompanionDocumentValidationException] { return [pscustomobject]@{ outcome = 'content-invalid'; ledger = $null } }

    return [pscustomobject]@{ outcome = 'valid'; ledger = $ledger }
}

function Find-StateEventTombstone {
    param([Parameter(Mandatory)] $Ledger, [Parameter(Mandatory)] [long] $Sequence)

    foreach ($tombstone in $Ledger.settled) { if ($tombstone.sequence -eq $Sequence) { return $tombstone } }

    return $null
}

# Every ledger write raises the high water over each tombstone, keeps entries sorted and
# unique, and prunes old tombstones except those whose record file still exists.
function Write-StateEventLedger {
    param(
        [Parameter(Mandatory)] [string] $CompanionRoot,
        [Parameter(Mandatory)] $Ledger,
        [Parameter(Mandatory)] [AllowEmptyCollection()] [long[]] $ExistingRecordSequences,
        [Parameter()] [DateTime] $Now = [DateTime]::UtcNow
    )

    $existing = [Collections.Generic.HashSet[long]]::new([long[]] $ExistingRecordSequences)
    $entries = [Collections.Generic.List[object]]::new()
    foreach ($tombstone in ($Ledger.settled | Sort-Object -Property { [long] $_.sequence })) { $entries.Add($tombstone) }
    foreach ($tombstone in $entries) { if ($tombstone.sequence -gt $Ledger.highWaterSequence) { $Ledger.highWaterSequence = [long] $tombstone.sequence } }
    $cutoff = $Now.Subtract($script:StateEventTombstoneMaximumAge)
    $kept = [Collections.Generic.List[object]]::new()
    foreach ($tombstone in $entries) {
        $settledAt = [DateTime]::Parse($tombstone.settledAt, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind)
        if ($settledAt -lt $cutoff -and -not $existing.Contains([long] $tombstone.sequence)) { continue }
        $kept.Add($tombstone)
    }
    if ($kept.Count -gt $script:StateEventTombstoneMaximumCount) {
        $removable = @($kept | Where-Object { -not $existing.Contains([long] $_.sequence) } | Sort-Object -Property @{ Expression = { $_.settledAt } }, @{ Expression = { [long] $_.sequence } })
        $excess = $kept.Count - $script:StateEventTombstoneMaximumCount
        $drop = [Collections.Generic.HashSet[long]]::new()
        foreach ($tombstone in ($removable | Select-Object -First $excess)) { [void] $drop.Add([long] $tombstone.sequence) }
        $kept = [Collections.Generic.List[object]]::new(@($kept | Where-Object { -not $drop.Contains([long] $_.sequence) }))
    }
    $Ledger.settled = $kept
    $document = [ordered]@{ outboxLedgerVersion = 1; incarnationId = $Ledger.incarnationId; highWaterSequence = [long] $Ledger.highWaterSequence; settled = @($kept) }
    Write-CompanionStateJson -Path (Join-Path (Get-StateEventOutboxPath -CompanionRoot $CompanionRoot) $script:StateEventLedgerFileName) -Document $document -Budget config
}

function New-StateEventTombstone {
    param(
        [Parameter(Mandatory)] [long] $Sequence,
        [Parameter(Mandatory)] [ValidateSet('delivered', 'abandoned', 'quarantined')] [string] $Outcome,
        [Parameter(Mandatory)] [string] $RecordSha256,
        [AllowNull()] $LogicalOutboxId,
        [AllowNull()] $Kind,
        [AllowNull()] $JournalId,
        [AllowNull()] $EventId,
        [AllowNull()] $RepairOperationId
    )

    $normalize = { param($Value) if ([string]::IsNullOrEmpty([string] $Value)) { $null } else { [string] $Value } }

    return [ordered]@{ sequence = $Sequence; outcome = $Outcome; recordSha256 = $RecordSha256; logicalOutboxId = (& $normalize $LogicalOutboxId); kind = (& $normalize $Kind); journalId = (& $normalize $JournalId); eventId = (& $normalize $EventId); repairOperationId = (& $normalize $RepairOperationId); settledAt = (Get-StateEventUtcNow) }
}

# --- Records -----------------------------------------------------------------------

function Read-StateEventRecordBytes {
    param([Parameter(Mandatory)] [string] $Path)

    return Read-StateEventFileBytes -Path $Path -Budget 'state-event' -Hash
}

function Test-StateEventWarningArray {
    param([Parameter(Mandatory)] [Text.Json.JsonElement] $Element, [Parameter(Mandatory)] [string[]] $Codes)

    Test-ElementKind $Element Array
    $previous = $null
    foreach ($warning in $Element.EnumerateArray()) {
        Test-ExactFields $warning @('code', 'detail')
        $code = Test-String (Get-Property $warning code)
        $detailElement = Get-Property $warning detail
        $detail = if ($detailElement.ValueKind -eq [Text.Json.JsonValueKind]::Null) { $null } else { Test-String $detailElement }
        if ($code -cnotin $Codes -or ($code -ceq 'pipeline-reaper-discovery-limit-exceeded' -and $detail -cnotin @('tmp', 'state')) -or ($code -ceq 'diff-exclude-path-unused' -and ($null -eq $detail -or -not $detail.StartsWith('/', [StringComparison]::Ordinal))) -or ($code -cnotin @('pipeline-reaper-discovery-limit-exceeded', 'diff-exclude-path-unused') -and $null -ne $detail)) { Fail-Document }
        $key = $code + [char]0 + [string] $detail
        if ($null -ne $previous -and [string]::CompareOrdinal($previous, $key) -ge 0) { Fail-Document }
        $previous = $key
    }
}

function Test-StateEventTargetIdentityEqual {
    param([Parameter(Mandatory)] [Text.Json.JsonElement] $GeneratedAt, [Parameter(Mandatory)] [Text.Json.JsonElement] $Source, [Parameter(Mandatory)] [Text.Json.JsonElement] $State)

    return [string]::Equals($GeneratedAt.GetString(), $State.GetProperty('generatedAt').GetString(), [StringComparison]::Ordinal) -and [Text.Json.JsonElement]::DeepEquals($Source, $State.GetProperty('source'))
}

function Test-StateEventDiffEmpty {
    param([Parameter(Mandatory)] [Text.Json.JsonElement] $Diff)

    $character = $Diff.GetProperty('character'); $inventory = $Diff.GetProperty('inventory'); $objectives = $Diff.GetProperty('objectives')

    return -not $Diff.GetProperty('hasChanges').GetBoolean() -and -not $Diff.GetProperty('hasUnrepresentedChanges').GetBoolean() -and $Diff.GetProperty('sessionChange').ValueKind -eq [Text.Json.JsonValueKind]::Null -and $objectives.GetProperty('added').GetArrayLength() -eq 0 -and $objectives.GetProperty('removed').GetArrayLength() -eq 0 -and $objectives.GetProperty('statusChanged').GetArrayLength() -eq 0 -and $character.GetProperty('levelDelta').GetInt64() -eq 0 -and $character.GetProperty('xpDelta').GetInt64() -eq 0 -and $character.GetProperty('moneyDelta').GetDecimal() -eq 0 -and $character.GetProperty('skillChanges').GetArrayLength() -eq 0 -and $inventory.GetProperty('gained').GetArrayLength() -eq 0 -and $inventory.GetProperty('lost').GetArrayLength() -eq 0 -and -not $inventory.GetProperty('equippedChanged').GetBoolean() -and $Diff.GetProperty('extraChanges').GetArrayLength() -eq 0
}

# The record validator. Structural mode enforces the exact field set, every kind and
# pairwise invariant, and core-valid nested documents; producer mode additionally admits
# the state under the held adapter configuration. Rejections throw the 7.1 content types.
function Read-StateEventRecord {
    [CmdletBinding(DefaultParameterSetName = 'Bytes')]
    param(
        [Parameter(Mandatory, ParameterSetName = 'Bytes')] [AllowEmptyCollection()] [byte[]] $Bytes,
        [Parameter(Mandatory, ParameterSetName = 'Json')] [string] $Json,
        [Parameter()] [ValidateSet('Structural', 'Producer')] [string] $Mode = 'Structural',
        [Parameter()] [AllowNull()] [AdapterCompatibilityConfig] $AdapterConfig,
        [Parameter()] [long] $ExpectedSequence = 0
    )

    if ($Mode -ceq 'Producer' -and $null -eq $AdapterConfig) { throw [ArgumentException]::new('Producer-mode record validation requires an adapter configuration.') }
    if ($PSCmdlet.ParameterSetName -ceq 'Bytes') {
        if ($Bytes.Length -ge 3 -and $Bytes[0] -eq 0xEF -and $Bytes[1] -eq 0xBB -and $Bytes[2] -eq 0xBF) { throw [CompanionJsonParseException]::new('State-event record carries a byte order mark.') }
        $document = ConvertFrom-StateEventJsonBytes -Bytes $Bytes -Budget 'state-event'
    }
    else {
        $document = Read-CompanionJson -Json $Json -Budget 'state-event'
    }
    $root = $document.RootElement
    Test-ExactFields $root $script:StateEventRecordFields
    if ((Test-Integer (Get-Property $root stateEventVersion)) -ne 1) { Fail-Document }
    $incarnation = Test-String (Get-Property $root incarnationId)
    if ($incarnation -cnotmatch $script:StateEventIncarnationPattern) { Fail-Document }
    $sequence = Test-Integer (Get-Property $root sequence) $false $true
    if (-not (Test-StateEventSequenceValue -Value $sequence) -or ($ExpectedSequence -ne 0 -and $sequence -ne $ExpectedSequence)) { Fail-Document }
    if (-not [string]::Equals((Test-String (Get-Property $root logicalOutboxId)), (Get-StateEventLogicalOutboxId -IncarnationId $incarnation -Sequence $sequence), [StringComparison]::Ordinal)) { Fail-Document }
    $kind = Test-String (Get-Property $root kind)
    if ($kind -cnotin $script:StateEventRecordKinds) { Fail-Document }
    Test-Utc (Get-Property $root createdAt)
    if (-not (Test-CompanionOpaqueToken -Value (Test-String (Get-Property $root principal)))) { Fail-Document }
    $repair = Get-Property $root repairOperationId
    if ($kind -ceq 'resync') {
        if (-not (Test-CompanionOpaqueToken -Value (Test-String $repair))) { Fail-Document }
    }
    elseif ($repair.ValueKind -ne [Text.Json.JsonValueKind]::Null) { Fail-Document }
    $adapterVersion = Test-Integer (Get-Property $root adapterVersion)
    $game = Test-String (Get-Property $root game)
    $baseline = Get-Property $root baseline
    if ($baseline.ValueKind -ne [Text.Json.JsonValueKind]::Null) {
        Test-ExactFields $baseline @('generatedAt', 'source')
        Test-Utc (Get-Property $baseline generatedAt)
        [void] (Test-Source (Get-Property $baseline source))
    }
    $floor = Get-Property $root sourceFloor
    Test-SourceIdentityFields $floor
    $refresh = Get-Property $root refresh
    Test-ExactFields $refresh @('attempted', 'commitObserved', 'attempts')
    Test-Boolean (Get-Property $refresh attempted); Test-Boolean (Get-Property $refresh commitObserved)
    $attempts = Test-Integer (Get-Property $refresh attempts) $true
    $attempted = (Get-Property $refresh attempted).GetBoolean()
    if ($attempts -gt $script:TurnContextRefreshAttemptCap -or $attempted -ne ($attempts -gt 0) -or ((Get-Property $refresh commitObserved).GetBoolean() -and -not $attempted)) { Fail-Document }
    Test-StateEventWarningArray -Element (Get-Property $root warnings) -Codes $script:StateEventRecordWarningCodes
    Test-Boolean (Get-Property $root baselineReset)
    $diff = Read-DiffDocument -Json (Get-Property $root diff).GetRawText()
    $state = Read-DigestDocument -Json (Get-Property $root state).GetRawText()
    $diffRoot = $diff.RootElement; $stateRoot = $state.RootElement
    if ($adapterVersion -ne $diffRoot.GetProperty('adapterVersion').GetInt64() -or $adapterVersion -ne $stateRoot.GetProperty('adapterVersion').GetInt64() -or -not [string]::Equals($game, $diffRoot.GetProperty('game').GetString(), [StringComparison]::Ordinal) -or -not [string]::Equals($game, $stateRoot.GetProperty('game').GetString(), [StringComparison]::Ordinal)) { Fail-Document }
    if (-not [string]::Equals($diffRoot.GetProperty('currentGeneratedAt').GetString(), $stateRoot.GetProperty('generatedAt').GetString(), [StringComparison]::Ordinal) -or -not [Text.Json.JsonElement]::DeepEquals($diffRoot.GetProperty('currentSource'), $stateRoot.GetProperty('source'))) { Fail-Document }
    $stateSource = $state.Materialized['source']
    $floorIdentity = ConvertFrom-SourceIdentity -Element $floor
    if (-not [string]::Equals([string] $stateSource['domainId'], $floorIdentity.domainId, [StringComparison]::Ordinal)) { Fail-Document }
    $floorOrder = Compare-SourceIdentity -Left (ConvertFrom-SourceIdentity -Value $stateSource) -Right $floorIdentity
    if (-not $floorOrder.comparable -or $floorOrder.order -lt 0) { Fail-Document }
    $baselineReset = (Get-Property $root baselineReset).GetBoolean()
    $diffBaseline = $diffRoot.GetProperty('baselineGeneratedAt')
    if ($baselineReset -ne ($baseline.ValueKind -eq [Text.Json.JsonValueKind]::Null) -or $baselineReset -ne ($diffBaseline.ValueKind -eq [Text.Json.JsonValueKind]::Null)) { Fail-Document }
    if ($baseline.ValueKind -ne [Text.Json.JsonValueKind]::Null -and -not [string]::Equals($diffBaseline.GetString(), $baseline.GetProperty('generatedAt').GetString(), [StringComparison]::Ordinal)) { Fail-Document }
    switch ($kind) {
        'consumed' {
            if ($baseline.ValueKind -ne [Text.Json.JsonValueKind]::Null -and (Test-StateEventTargetIdentityEqual -GeneratedAt $baseline.GetProperty('generatedAt') -Source $baseline.GetProperty('source') -State $stateRoot)) { Fail-Document }
        }
        'snapshot' {
            if ($baseline.ValueKind -eq [Text.Json.JsonValueKind]::Null -or -not (Test-StateEventTargetIdentityEqual -GeneratedAt $baseline.GetProperty('generatedAt') -Source $baseline.GetProperty('source') -State $stateRoot) -or -not (Test-StateEventDiffEmpty -Diff $diffRoot) -or $baselineReset) { Fail-Document }
        }
        'resync' {
            if ($baseline.ValueKind -ne [Text.Json.JsonValueKind]::Null -or -not (Test-StateEventDiffEmpty -Diff $diffRoot) -or -not $baselineReset) { Fail-Document }
        }
    }
    if ($Mode -ceq 'Producer') {
        Assert-AdapterDigestDocument -Document $state -AdapterConfig $AdapterConfig
        if ($adapterVersion -ne $AdapterConfig.AdapterVersion -or -not [string]::Equals($game, $AdapterConfig.Game, [StringComparison]::Ordinal) -or -not [string]::Equals([string] $stateSource['domainId'], $AdapterConfig.SourceDomainId, [StringComparison]::Ordinal)) { throw [AdapterDigestValidationException]::new('State-event record does not match the held adapter configuration.') }
    }

    return [pscustomobject]@{ document = $document; state = $state; diff = $diff; sequence = $sequence; incarnationId = $incarnation; logicalOutboxId = (Get-Property $root logicalOutboxId).GetString(); kind = $kind; repairOperationId = if ($kind -ceq 'resync') { $repair.GetString() } else { $null } }
}

# --- Reconciliation ----------------------------------------------------------------

function Remove-StateEventQuarantineExcess {
    param([Parameter(Mandatory)] [string] $QuarantinePath, [Parameter(Mandatory)] [CompanionWarningSink] $WarningSink)

    try {
        $entries = @([IO.DirectoryInfo]::new($QuarantinePath).GetFiles() | Sort-Object -Property LastWriteTimeUtc, Name)
        $excess = $entries.Count - $script:StateEventQuarantineMaximumEntries
        for ($index = 0; $index -lt $excess; $index++) { [IO.File]::Delete($entries[$index].FullName) }
    }
    catch { Add-CompanionWarning -Sink $WarningSink -Code 'pipeline-cleanup-degraded' -Detail $null }
}

function Move-StateEventRecordToQuarantine {
    param([Parameter(Mandatory)] [string] $OutboxPath, [Parameter(Mandatory)] [string] $Name, [Parameter(Mandatory)] [CompanionWarningSink] $WarningSink)

    try {
        $quarantine = Join-Path $OutboxPath $script:StateEventQuarantineName
        [void] [IO.Directory]::CreateDirectory($quarantine)
        $target = Join-Path $quarantine ("$Name.$(New-StateEventIncarnationId).invalid")
        [IO.File]::Move((Join-Path $OutboxPath $Name), $target, $false)
        Remove-StateEventQuarantineExcess -QuarantinePath $quarantine -WarningSink $WarningSink
    }
    catch { Add-CompanionWarning -Sink $WarningSink -Code 'pipeline-cleanup-degraded' -Detail $null }
}

# Deletes baseline.json and proves it gone. Returns whether a file existed. A file that
# cannot be opened for any reason other than absence, or that survives the delete, throws:
# no existence predicate may stand in for the removal that carries a reset obligation.
function Remove-CompanionBaselineFile {
    param([Parameter(Mandatory)] [string] $CompanionRoot)

    $path = Get-CompanionStatePath -CompanionRoot $CompanionRoot -Name 'baseline.json'
    $existed = $true
    try { [IO.File]::Open($path, [IO.FileMode]::Open, [IO.FileAccess]::Read, ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete)).Dispose() }
    catch [IO.FileNotFoundException], [IO.DirectoryNotFoundException] { $existed = $false }
    if ($existed) { [IO.File]::Delete($path) }
    $survived = $true
    try { [IO.File]::Open($path, [IO.FileMode]::Open, [IO.FileAccess]::Read, ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete)).Dispose() }
    catch [IO.FileNotFoundException], [IO.DirectoryNotFoundException] { $survived = $false }
    if ($survived) { throw [IO.IOException]::new('baseline.json is still present after removal.') }

    return $existed
}

function Get-StateEventSequenceFromLogicalOutboxId {
    param([Parameter(Mandatory)] [string] $LogicalOutboxId)

    if (-not (Test-StateEventLogicalOutboxIdText -Value $LogicalOutboxId)) { throw [ArgumentException]::new('Not a logical outbox identifier.') }

    return [long]::Parse($LogicalOutboxId.Substring($LogicalOutboxId.IndexOf('-') + 1), [Globalization.CultureInfo]::InvariantCulture)
}

function Get-StateEventSequenceFromName {
    param([Parameter(Mandatory)] [string] $Name)

    if ($Name -cnotmatch $script:StateEventRecordNamePattern) { throw [ArgumentException]::new('Not a record file name.') }

    return [long]::Parse($Matches[1], [Globalization.CultureInfo]::InvariantCulture)
}

function Test-StateEventBaselineSupersedes {
    param([Parameter(Mandatory)] [CompanionJsonValue] $Baseline, [Parameter(Mandatory)] [CompanionJsonValue] $State)

    $relation = Compare-SourceIdentity -Left (ConvertFrom-SourceIdentity -Value $Baseline.Materialized['source']) -Right (ConvertFrom-SourceIdentity -Value $State.Materialized['source'])
    if (-not $relation.comparable) { return $false }
    if ($relation.order -gt 0) { return $true }
    if ($relation.order -lt 0) { return $false }
    $baselineAt = [DateTime]::Parse($Baseline.RootElement.GetProperty('generatedAt').GetString(), [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind)
    $stateAt = [DateTime]::Parse($State.RootElement.GetProperty('generatedAt').GetString(), [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind)

    return $baselineAt -gt $stateAt
}

# One ledger write fences every entry with a quarantined tombstone, which retires its sequence,
# and only then is each file moved; reconciliation step 5 finishes a failed move. A failed
# ledger write throws outbox / outbox-write-failed.
function Add-StateEventQuarantineFence {
    param(
        [Parameter(Mandatory)] [string] $CompanionRoot,
        [Parameter(Mandatory)] $Ledger,
        [Parameter(Mandatory)] [AllowEmptyCollection()] [object[]] $Entries,
        [Parameter(Mandatory)] [AllowEmptyCollection()] [long[]] $RecordSequences,
        [Parameter(Mandatory)] [CompanionWarningSink] $OperationalWarnings,
        [Parameter(Mandatory)] [scriptblock] $WriteLedger
    )

    if ($Entries.Count -eq 0) { return }
    foreach ($entry in $Entries) {
        $logical = if ($null -ne $entry.identity) { $entry.identity.logicalOutboxId } else { $null }
        $kind = if ($null -ne $entry.identity) { $entry.identity.kind } else { $null }
        $repair = if ($null -ne $entry.identity) { $entry.identity.repairOperationId } else { $null }
        $Ledger.settled.Add((New-StateEventTombstone -Sequence $entry.sequence -Outcome quarantined -RecordSha256 $entry.sha256 -LogicalOutboxId $logical -Kind $kind -JournalId $null -EventId $null -RepairOperationId $repair))
    }
    try { & $WriteLedger $CompanionRoot $Ledger $RecordSequences }
    catch { Stop-StateEventOperation -Class outbox -Reason outbox-write-failed }
    $outbox = Get-StateEventOutboxPath -CompanionRoot $CompanionRoot
    foreach ($entry in $Entries) { Move-StateEventRecordToQuarantine -OutboxPath $outbox -Name $entry.name -WarningSink $OperationalWarnings }
}

# The highest-sequence live resync carrying a repair identifier: a pending record or a delivered
# or abandoned tombstone, never a quarantined one.
function Find-StateEventLiveResync {
    param([Parameter(Mandatory)] $Reconciliation, [Parameter(Mandatory)] [string] $RepairOperationId)

    $live = $null
    foreach ($entry in $Reconciliation.pending) {
        if ($entry.record.kind -cne 'resync') { continue }
        if ([string]::Equals($entry.record.repairOperationId, $RepairOperationId, [StringComparison]::Ordinal) -and ($null -eq $live -or [long] $entry.sequence -gt $live.sequence)) { $live = [pscustomobject]@{ kind = $entry.record.kind; logicalOutboxId = $entry.record.logicalOutboxId; sequence = [long] $entry.sequence } }
    }
    foreach ($tombstone in $Reconciliation.ledger.settled) {
        if ($tombstone.kind -cne 'resync' -or $tombstone.outcome -ceq 'quarantined' -or $null -eq $tombstone.logicalOutboxId) { continue }
        if ([string]::Equals($tombstone.repairOperationId, $RepairOperationId, [StringComparison]::Ordinal) -and ($null -eq $live -or [long] $tombstone.sequence -gt $live.sequence)) { $live = [pscustomobject]@{ kind = $tombstone.kind; logicalOutboxId = $tombstone.logicalOutboxId; sequence = [long] $tombstone.sequence } }
    }

    return $live
}

# The fence of a resync's rejected records once a live resync above them is durable. A failed
# ledger write cannot fail the transaction: the records stay pending, and the receipt says so.
function Invoke-StateEventResyncFence {
    param(
        [Parameter(Mandatory)] [string] $CompanionRoot,
        [Parameter(Mandatory)] $Reconciliation,
        [Parameter(Mandatory)] [CompanionWarningSink] $OperationalWarnings,
        [Parameter(Mandatory)] [CompanionWarningSink] $ReceiptWarnings,
        [Parameter(Mandatory)] [scriptblock] $WriteLedger
    )

    try { Add-StateEventQuarantineFence -CompanionRoot $CompanionRoot -Ledger $Reconciliation.ledger -Entries $Reconciliation.rejected -RecordSequences $Reconciliation.recordSequences -OperationalWarnings $OperationalWarnings -WriteLedger $WriteLedger }
    catch [StateEventFailure] { Add-CompanionWarning -Sink $ReceiptWarnings -Code 'outbox-quarantine-deferred' -Detail $null }
}

# The one reconciliation of 7.6, run after every ownership check. Modes: Normal stops at
# an invalid pending record; Resync and Abandon are repair modes. Abandon fences and quarantines
# invalid records at once; Resync validates in producer mode and returns the records it rejects
# for the publish to fence after its resync is durable. Abandon removes the baseline before
# quarantine whatever the marker or the pending records, and skips the apply. Failures
# throw StateEventFailure.
function Invoke-StateEventReconciliation {
    param(
        [Parameter(Mandatory)] [string] $CompanionRoot,
        [Parameter(Mandatory)] [ValidateSet('Normal', 'Resync', 'Abandon')] [string] $Mode,
        [Parameter(Mandatory)] [CompanionWarningSink] $OperationalWarnings,
        [Parameter()] [AllowNull()] [CompanionWarningSink] $ReceiptWarnings,
        [Parameter()] [AllowNull()] [AdapterCompatibilityConfig] $AdapterConfig,
        [Parameter()] [scriptblock] $WriteLedger = { param([string] $Root, $Ledger, [long[]] $Existing) Write-StateEventLedger -CompanionRoot $Root -Ledger $Ledger -ExistingRecordSequences $Existing },
        [Parameter()] [scriptblock] $WriteBaseline = { param([string] $Root, [CompanionJsonValue] $Document) Write-CompanionBaseline -CompanionRoot $Root -Document $Document },
        [Parameter()] [scriptblock] $RemoveBaseline = { param([string] $Root) Remove-CompanionBaselineFile -CompanionRoot $Root }
    )

    if ($Mode -ceq 'Resync' -and $null -eq $AdapterConfig) { throw [ArgumentException]::new('A resync reconciliation requires the held adapter configuration.') }
    $outbox = Get-StateEventOutboxPath -CompanionRoot $CompanionRoot
    try { [void] [IO.Directory]::CreateDirectory($outbox) }
    catch { Stop-StateEventOperation -Class outbox -Reason outbox-setup-failed }
    try {
        foreach ($path in [IO.Directory]::EnumerateFiles($outbox)) {
            if ([IO.Path]::GetFileName($path) -cmatch $script:StateEventSiblingPattern) {
                try { [IO.File]::Delete($path) } catch { Add-CompanionWarning -Sink $OperationalWarnings -Code 'pipeline-cleanup-degraded' -Detail $null }
            }
        }
    }
    catch { Add-CompanionWarning -Sink $OperationalWarnings -Code 'pipeline-cleanup-degraded' -Detail $null }
    $recordNames = [Collections.Generic.List[string]]::new()
    try {
        $children = 0
        foreach ($entry in [IO.DirectoryInfo]::new($outbox).EnumerateFileSystemInfos()) {
            $children++
            if ($children -gt $script:StateEventChildLimit) { Stop-StateEventOperation -Class outbox -Reason outbox-setup-failed }
            if ($entry -is [IO.FileInfo] -and $entry.Name -cmatch $script:StateEventRecordNamePattern) { $recordNames.Add($entry.Name) }
        }
    }
    catch [StateEventFailure] { throw }
    catch { Stop-StateEventOperation -Class outbox -Reason outbox-setup-failed }
    $sortedNames = $recordNames.ToArray()
    [Array]::Sort($sortedNames, [StringComparer]::Ordinal)
    $sequences = [long[]] @($sortedNames | ForEach-Object { Get-StateEventSequenceFromName -Name $_ })
    $highestFile = if ($sequences.Count -gt 0) { [long] $sequences[-1] } else { 0L }

    $ledgerRead = Read-StateEventLedger -CompanionRoot $CompanionRoot
    if ($ledgerRead.outcome -ceq 'infrastructure-failure') { Stop-StateEventOperation -Class outbox -Reason outbox-setup-failed }
    $ledger = $ledgerRead.ledger
    if ($ledgerRead.outcome -cne 'valid') {
        $ledger = [pscustomobject]@{ incarnationId = (New-StateEventIncarnationId); highWaterSequence = $highestFile; settled = [Collections.Generic.List[object]]::new() }
        try { & $WriteLedger $CompanionRoot $ledger $sequences }
        catch { Stop-StateEventOperation -Class outbox -Reason outbox-setup-failed }
        if (($ledgerRead.outcome -ceq 'content-invalid' -or $sequences.Count -gt 0) -and $null -ne $ReceiptWarnings) { Add-CompanionWarning -Sink $ReceiptWarnings -Code 'outbox-ledger-rebuilt' -Detail $null }
    }

    $pendingNames = [Collections.Generic.List[string]]::new()
    foreach ($name in $sortedNames) {
        $sequence = Get-StateEventSequenceFromName -Name $name
        $tombstone = Find-StateEventTombstone -Ledger $ledger -Sequence $sequence
        if ($null -eq $tombstone) { $pendingNames.Add($name); continue }
        if ($tombstone.outcome -ceq 'quarantined') { Move-StateEventRecordToQuarantine -OutboxPath $outbox -Name $name -WarningSink $OperationalWarnings; continue }
        try { [IO.File]::Delete((Join-Path $outbox $name)) } catch { Add-CompanionWarning -Sink $OperationalWarnings -Code 'pipeline-cleanup-degraded' -Detail $null }
    }

    # The runtime journal may hold undelivered events the core cannot see, so an abandon
    # removes the baseline even on a root that is not releasing.
    $baselineRemoved = $false
    if ($Mode -ceq 'Abandon') {
        try { $baselineRemoved = [bool] (& $RemoveBaseline $CompanionRoot) }
        catch { Stop-StateEventOperation -Class outbox -Reason outbox-write-failed }
    }
    $releasingByRecord = $pendingNames.Count -gt 0

    $valid = [Collections.Generic.List[object]]::new()
    $invalid = [Collections.Generic.List[object]]::new()
    foreach ($name in $pendingNames) {
        $sequence = Get-StateEventSequenceFromName -Name $name
        try { $file = Read-StateEventRecordBytes -Path (Join-Path $outbox $name) }
        catch { Stop-StateEventOperation -Class outbox -Reason outbox-setup-failed }
        try {
            $record = if ($Mode -ceq 'Resync') { Read-StateEventRecord -Bytes $file.bytes -Mode Producer -AdapterConfig $AdapterConfig -ExpectedSequence $sequence } else { Read-StateEventRecord -Bytes $file.bytes -ExpectedSequence $sequence }
            $valid.Add([pscustomobject]@{ name = $name; sequence = $sequence; sha256 = $file.sha256; record = $record })
        }
        catch {
            if ($_.Exception -isnot [CompanionContentException] -or (Test-ValidatorInfrastructureFailure -Exception $_.Exception)) {
                if ($Mode -ceq 'Resync') { Stop-StateEventOperation -Class compute -Reason adapter-validator-infrastructure-failed }
                throw
            }
            $identity = $null
            if ($Mode -ceq 'Resync') {
                try { $identity = Read-StateEventRecord -Bytes $file.bytes -ExpectedSequence $sequence } catch { $identity = $null }
            }
            $invalid.Add([pscustomobject]@{ name = $name; sequence = $sequence; sha256 = $file.sha256; identity = $identity })
        }
    }
    if ($invalid.Count -gt 0) {
        if ($Mode -ceq 'Normal') { Stop-StateEventOperation -Class outbox -Reason outbox-record-invalid }
        # An abandon fences at once; a resync fences after its commit point (publish step 8), so
        # a quarantine never becomes durable without the disclosure that follows it.
        if ($Mode -ceq 'Abandon') { Add-StateEventQuarantineFence -CompanionRoot $CompanionRoot -Ledger $ledger -Entries $invalid.ToArray() -RecordSequences $sequences -OperationalWarnings $OperationalWarnings -WriteLedger $WriteLedger }
    }

    if ($Mode -cne 'Abandon' -and $valid.Count -gt 0) {
        $newest = $valid[$valid.Count - 1].record
        $baselineRead = Read-CompanionBaseline -CompanionRoot $CompanionRoot
        if ($baselineRead.outcome -ceq 'infrastructure-failure') { Stop-StateEventOperation -Class compute -Reason baseline-read-failed }
        $applied = $false
        $superseded = $false
        if ($baselineRead.outcome -ceq 'valid') {
            $baselineRoot = $baselineRead.document.RootElement
            $applied = Test-StateEventTargetIdentityEqual -GeneratedAt $baselineRoot.GetProperty('generatedAt') -Source $baselineRoot.GetProperty('source') -State $newest.state.RootElement
            # An outstanding record (the baseline is its own recorded predecessor) is never
            # superseded, whatever the generation times say.
            $predecessor = $newest.document.RootElement.GetProperty('baseline')
            $outstanding = -not $applied -and $predecessor.ValueKind -ne [Text.Json.JsonValueKind]::Null -and (Test-StateEventTargetIdentityEqual -GeneratedAt $predecessor.GetProperty('generatedAt') -Source $predecessor.GetProperty('source') -State $baselineRoot)
            if (-not $applied -and -not $outstanding) { $superseded = Test-StateEventBaselineSupersedes -Baseline $baselineRead.document -State $newest.state }
        }
        if (-not $applied -and -not $superseded) {
            try { & $WriteBaseline $CompanionRoot $newest.state }
            catch { Stop-StateEventOperation -Class outbox -Reason outbox-apply-failed }
        }
    }
    # Assigned through a variable, so an empty list stays an empty array rather than null.
    $rejected = [object[]]::new(0)
    if ($Mode -ceq 'Resync') { $rejected = $invalid.ToArray() }

    return [pscustomobject]@{ ledger = $ledger; pending = $valid; recordSequences = $sequences; highestFileSequence = $highestFile; baselineRemoved = $baselineRemoved; releasingByRecord = $releasingByRecord; rejected = $rejected }
}

# --- Diagnostics, receipts, and results ----------------------------------------------

function New-StateEventDetail {
    param([Parameter(Mandatory)] [ValidateSet('Publish', 'Settlement', 'Consumer')] [string] $Script, [Parameter(Mandatory)] [string] $Class, [Parameter(Mandatory)] [string] $Reason, [hashtable] $Atoms = @{})

    $registry = $script:StateEventReasons[$Script]
    if (-not $registry.ContainsKey($Class) -or -not (Test-TurnContextReason -Reason $Reason -Allowed $registry[$Class])) { throw [TurnContextProtocolException]::new('Invalid state-event detail.') }
    if ($Class -cin $script:StateEventAddedClasses -or -not (Test-TurnContextReason -Reason $Reason -Allowed $script:TurnContextReasons[$Class])) {
        if ($Atoms.Count -ne 0) { throw [TurnContextProtocolException]::new('State-event added reasons accept no atoms.') }

        return $Reason
    }

    return New-TurnContextDetail -Class $Class -Reason $Reason -Atoms $Atoms
}

function Read-StateEventDetailReason {
    param([Parameter(Mandatory)] [string] $Script, [Parameter(Mandatory)] [string] $Class, [Parameter(Mandatory)] [string] $Detail)

    $registry = $script:StateEventReasons[$Script]
    if (-not $registry.ContainsKey($Class)) { throw [TurnContextProtocolException]::new('Invalid state-event diagnostic.') }
    if (Test-TurnContextReason -Reason $Detail -Allowed $registry[$Class]) {
        if ($Class -cin $script:StateEventAddedClasses -or -not (Test-TurnContextReason -Reason $Detail -Allowed $script:TurnContextReasons[$Class])) { return $Detail }
    }
    if ($Class -cin $script:StateEventAddedClasses) { throw [TurnContextProtocolException]::new('Invalid state-event diagnostic.') }
    $reason = Read-TurnContextDetailReason -Class $Class -Detail $Detail
    if (-not (Test-TurnContextReason -Reason $reason -Allowed $registry[$Class])) { throw [TurnContextProtocolException]::new('Invalid state-event diagnostic.') }

    return $reason
}

function Read-StateEventDiagnostic {
    param([Parameter(Mandatory)] [string] $Json, [Parameter(Mandatory)] [string] $ExpectedClass, [Parameter(Mandatory)] [ValidateSet('Publish', 'Settlement', 'Consumer')] [string] $Script)

    try {
        if ($script:CompanionJsonUtf8.GetByteCount($Json) -gt $script:StateEventDiagnosticByteCap) { throw [TurnContextProtocolException]::new('State-event diagnostic exceeds byte cap.') }
        $document = Read-CompanionJson -Json $Json -Budget config
        $root = $document.RootElement
        Test-ExactFields $root @('outcomeClass', 'consumptionState', 'lockStage', 'sourceIdentity', 'generationTimestamp', 'detail', 'warnings')
        $class = Test-String (Get-Property $root outcomeClass)
        $consumption = Test-String (Get-Property $root consumptionState)
        $registry = $script:StateEventReasons[$Script]
        if (-not [string]::Equals($class, $ExpectedClass, [StringComparison]::Ordinal) -or -not $registry.ContainsKey($class) -or $consumption -cnotin @('none', 'notConsumed', 'consumed', 'unknown')) { throw [TurnContextProtocolException]::new('Invalid state-event diagnostic.') }
        $lock = Get-Property $root lockStage
        $lockStage = if ($lock.ValueKind -eq [Text.Json.JsonValueKind]::Null) { $null } else { Test-String $lock }
        $legalStages = if ($Script -ceq 'Publish') { @('cycle', 'consume') } else { @('consume') }
        if (($class -cin @('busy', 'lock')) -ne ($null -ne $lockStage) -or ($null -ne $lockStage -and $lockStage -cnotin $legalStages)) { throw [TurnContextProtocolException]::new('Invalid state-event diagnostic.') }
        $detail = Test-String (Get-Property $root detail)
        $reason = Read-StateEventDetailReason -Script $Script -Class $class -Detail $detail
        $source = Get-Property $root sourceIdentity
        $generation = Get-Property $root generationTimestamp
        $hasSource = $source.ValueKind -ne [Text.Json.JsonValueKind]::Null
        $hasGeneration = $generation.ValueKind -ne [Text.Json.JsonValueKind]::Null
        if ($hasSource) { [void] (Get-TurnContextIdentity -Element $source) }
        if ($hasGeneration) { Test-Utc $generation }
        $consumptionLegal = switch ($consumption) {
            'notConsumed' { $class -ceq 'outbox-write:not-consumed' }
            'consumed' { $Script -ceq 'Publish' -and $class -ceq 'delivery' }
            'unknown' { $class -ceq 'protocol' -and $reason -ceq 'attempt-result-invalid' -and -not $hasSource -and -not $hasGeneration }
            default { $class -cne 'outbox-write:not-consumed' }
        }
        if (-not $consumptionLegal) { throw [TurnContextProtocolException]::new('Invalid state-event diagnostic.') }
        $provenanceLegal = if ($Script -cne 'Publish') { -not $hasSource -and -not $hasGeneration }
        elseif ($class -cin @('outbox', 'outbox-write:not-consumed', 'delivery')) { $hasSource -and $hasGeneration }
        elseif ($class -ceq 'protocol' -and $consumption -ceq 'unknown') { $true }
        else { Test-TurnContextDiagnosticProvenance -Class $class -ConsumptionState $consumption -Reason $reason -LockStage $lockStage -HasSource $hasSource -HasGeneration $hasGeneration }
        if (-not $provenanceLegal) { throw [TurnContextProtocolException]::new('Invalid state-event diagnostic.') }
        Assert-TurnContextWarnings -Element (Get-Property $root warnings) -OperationalOnly

        return $document
    }
    catch [TurnContextProtocolException] { throw }
    catch { throw [TurnContextProtocolException]::new('State-event diagnostic is invalid.') }
}

function Format-StateEventDiagnosticLine {
    param([Parameter(Mandatory)] [ValidateSet('Publish', 'Settlement', 'Consumer')] [string] $Script, [Parameter(Mandatory)] $Diagnostic)

    $json = ConvertTo-CompanionJson -InputObject $Diagnostic -Budget config
    [void] (Read-StateEventDiagnostic -Json $json -ExpectedClass $Diagnostic.outcomeClass -Script $Script)

    return "[state-event:$($Diagnostic.outcomeClass)] $json"
}

function ConvertTo-StateEventWarningArray {
    param([Parameter(Mandatory)] [AllowEmptyCollection()] [object[]] $Warnings)

    $entries = [Collections.Generic.List[object]]::new()
    $keys = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($warning in $Warnings) {
        $key = [string] $warning.code + [char]0 + [string] $warning.detail
        if ($keys.Add($key)) { $entries.Add([ordered]@{ code = $warning.code; detail = $warning.detail }) }
    }
    if ($entries.Count -le 1) { return @($entries) }
    $orderedKeys = [string[]] @($entries | ForEach-Object { [string] $_.code + [char]0 + [string] $_.detail })
    $orderedValues = [object[]] @($entries)
    [Array]::Sort[string, object]($orderedKeys, $orderedValues, [StringComparer]::Ordinal)

    return $orderedValues
}

function Read-StateEventReceipt {
    param([Parameter(Mandatory)] [string] $Json, [Parameter()] [AllowNull()] [AdapterCompatibilityConfig] $AdapterConfig)

    if ($script:CompanionJsonUtf8.GetByteCount($Json) -gt $script:StateEventReceiptByteCap) { Fail-Document }
    $document = Read-CompanionJson -Json $Json -Budget config
    $root = $document.RootElement
    Test-ExactFields $root @('outcome', 'kind', 'logicalOutboxId', 'sequence', 'target', 'schemaVersion', 'adapterVersion', 'game', 'baselineApplied', 'cacheDegraded', 'warnings')
    $outcome = Test-String (Get-Property $root outcome)
    if ($outcome -cnotin @('committed', 'unchanged', 'replayed')) { Fail-Document }
    $identified = $outcome -cin @('committed', 'replayed')
    $kind = Get-Property $root kind; $logical = Get-Property $root logicalOutboxId; $sequence = Get-Property $root sequence; $target = Get-Property $root target; $applied = Get-Property $root baselineApplied
    if ($identified) {
        if ((Test-String $kind) -cnotin $script:StateEventRecordKinds -or -not (Test-StateEventLogicalOutboxIdText -Value (Test-String $logical))) { Fail-Document }
        $sequenceValue = Test-Integer $sequence $false $true
        if (-not $logical.GetString().EndsWith('-' + $sequenceValue.ToString([Globalization.CultureInfo]::InvariantCulture), [StringComparison]::Ordinal)) { Fail-Document }
    }
    elseif ($kind.ValueKind -ne [Text.Json.JsonValueKind]::Null -or $logical.ValueKind -ne [Text.Json.JsonValueKind]::Null -or $sequence.ValueKind -ne [Text.Json.JsonValueKind]::Null) { Fail-Document }
    if ($outcome -cin @('committed', 'unchanged')) {
        Test-ExactFields $target @('generatedAt', 'source')
        Test-Utc (Get-Property $target generatedAt)
        [void] (Test-Source (Get-Property $target source))
    }
    elseif ($target.ValueKind -ne [Text.Json.JsonValueKind]::Null) { Fail-Document }
    if ($outcome -ceq 'committed') { Test-Boolean $applied } elseif ($applied.ValueKind -ne [Text.Json.JsonValueKind]::Null) { Fail-Document }
    if ((Test-Integer (Get-Property $root schemaVersion)) -ne (Get-CoreSchemaVersion)) { Fail-Document }
    $adapterVersion = Test-Integer (Get-Property $root adapterVersion)
    $game = Test-String (Get-Property $root game)
    if ($null -ne $AdapterConfig -and ($adapterVersion -ne $AdapterConfig.AdapterVersion -or -not [string]::Equals($game, $AdapterConfig.Game, [StringComparison]::Ordinal))) { Fail-Document }
    Test-Boolean (Get-Property $root cacheDegraded)
    Test-StateEventWarningArray -Element (Get-Property $root warnings) -Codes $script:StateEventReceiptWarningCodes

    return $document
}

# --- Outbox-mode consuming operation -----------------------------------------------

function New-StateEventTargetIdentity {
    param([Parameter(Mandatory)] [CompanionJsonValue] $Document)

    return [ordered]@{ generatedAt = $Document.RootElement.GetProperty('generatedAt').GetString(); source = $Document.RootElement.GetProperty('source').Clone() }
}

function New-StateEventOperationResult {
    param(
        [Parameter(Mandatory)] [ValidateSet('committed', 'unchanged', 'replayed', 'failure')] [string] $Outcome,
        [string] $ConsumptionState = 'none',
        [AllowNull()] [string] $Class,
        [AllowNull()] [string] $Reason,
        [AllowNull()] $Kind,
        [AllowNull()] $LogicalOutboxId,
        [AllowNull()] $Sequence,
        [AllowNull()] $Target,
        [AllowNull()] $BaselineApplied,
        [bool] $CacheDegraded = $false,
        [AllowNull()] $ProvenanceDocument,
        [bool] $Retryable = $false
    )

    return [pscustomobject]@{ stateEventOutcome = $Outcome; consumptionState = $ConsumptionState; outcomeClass = $Class; reason = $Reason; kind = $Kind; logicalOutboxId = $LogicalOutboxId; sequence = $Sequence; target = $Target; baselineApplied = $BaselineApplied; cacheDegraded = $CacheDegraded; provenanceDocument = $ProvenanceDocument; retryable = $Retryable }
}

# The runtime-role sibling of Invoke-CompanionConsumption (7.6 steps 1 to 11). It shares the
# locked target freeze, baseline classification, stale-target guard, and diff computation,
# and differs in commit behavior: one create-only outbox record before the baseline moves.
function Invoke-StateEventConsumption {
    param(
        [Parameter(Mandatory)] [AdapterConfig] $AdapterConfig,
        [Parameter(Mandatory)] [string] $CompanionRoot,
        [Parameter(Mandatory)] $SourceFloor,
        [Parameter(Mandatory)] [TurnContextPayloadContext] $Context,
        [Parameter(Mandatory)] [CompanionWarningSink] $AttemptWarnings,
        [Parameter(Mandatory)] [CompanionWarningSink] $OperationalWarnings,
        [Parameter(Mandatory)] [CompanionWarningSink] $ReceiptWarnings,
        [Parameter(Mandatory)] [string] $Principal,
        [switch] $RequireRecord,
        [switch] $Resync,
        [AllowNull()] [string] $RepairOperationId,
        [Parameter()] [scriptblock] $EnterConsumeLock = { param([string] $Root) Enter-CompanionConsumeLock -CompanionRoot $Root },
        [Parameter()] [scriptblock] $ReadCurrent = { param([string] $Root, [AdapterCompatibilityConfig] $Config) Read-CompanionCurrent -CompanionRoot $Root -AdapterConfig $Config },
        [Parameter()] [scriptblock] $SerializeRecord = { param($Record) ConvertTo-CompanionJson -InputObject $Record -Budget 'state-event' },
        [Parameter()] [scriptblock] $CommitRecord = { param([string] $Path, [byte[]] $Bytes) Write-CompanionStateBytes -Path $Path -Bytes $Bytes -CreateOnly },
        [Parameter()] [scriptblock] $AfterCommit = { param([string] $Path) },
        [Parameter()] [scriptblock] $WriteBaseline = { param([string] $Root, [CompanionJsonValue] $Document) Write-CompanionBaseline -CompanionRoot $Root -Document $Document },
        [Parameter()] [scriptblock] $CompareCache = { param($Baseline, $Target, $Config) Compare-Digests -Baseline $Baseline -Target $Target -AdapterConfig $Config -WarningSink $null },
        [Parameter()] [scriptblock] $WriteCache = { param([string] $Root, [CompanionJsonValue] $Document) Write-CompanionDiffCache -CompanionRoot $Root -Document $Document },
        [Parameter()] [scriptblock] $WriteLedger = { param([string] $Root, $Ledger, [long[]] $Existing) Write-StateEventLedger -CompanionRoot $Root -Ledger $Ledger -ExistingRecordSequences $Existing }
    )

    try { $lease = & $EnterConsumeLock $CompanionRoot }
    catch [TimeoutException] { return New-StateEventOperationResult -Outcome failure -Class busy -Reason lock-timeout }
    catch { return New-StateEventOperationResult -Outcome failure -Class lock -Reason lock-open-failed }

    $target = $null
    try {
        $ownership = Get-CompanionOwnershipFailure -CompanionRoot $CompanionRoot -Role runtime
        if ($null -ne $ownership) { return New-StateEventOperationResult -Outcome failure -Class config -Reason $ownership }
        try { $reconciliation = Invoke-StateEventReconciliation -CompanionRoot $CompanionRoot -Mode $(if ($Resync) { 'Resync' } else { 'Normal' }) -OperationalWarnings $OperationalWarnings -ReceiptWarnings $ReceiptWarnings -AdapterConfig $AdapterConfig -WriteLedger $WriteLedger }
        catch [StateEventFailure] { return New-StateEventOperationResult -Outcome failure -Class $_.Exception.OutcomeClass -Reason $_.Exception.Reason }

        $current = & $ReadCurrent $CompanionRoot $AdapterConfig
        if ($current.outcome -ceq 'validator-infrastructure') { return New-StateEventOperationResult -Outcome failure -Class compute -Reason adapter-validator-infrastructure-failed }
        if ($current.outcome -cne 'valid') { return New-StateEventOperationResult -Outcome failure -Class freshness -Reason $current.reason -Retryable $true }
        $target = $current.document
        $floorRelation = $null
        try { $floorRelation = Compare-SourceIdentity -Left (Get-ConsumptionSourceIdentity -Document $target) -Right $SourceFloor } catch { }
        if ($null -eq $floorRelation -or -not $floorRelation.comparable) { return New-StateEventOperationResult -Outcome failure -Class freshness -Reason target-identity-invalid -ProvenanceDocument $target -Retryable $true }
        if ($floorRelation.order -lt 0) { return New-StateEventOperationResult -Outcome failure -Class freshness -Reason target-below-floor -ProvenanceDocument $target -Retryable $true }

        $baselineRead = Read-CompanionBaseline -CompanionRoot $CompanionRoot
        if ($baselineRead.outcome -ceq 'infrastructure-failure') { return New-StateEventOperationResult -Outcome failure -Class compute -Reason baseline-read-failed -ProvenanceDocument $target }
        $baseline = $baselineRead.document
        if ($baselineRead.outcome -ceq 'valid') {
            try { Assert-AdapterDigestDocument -Document $baseline -AdapterConfig $AdapterConfig }
            catch {
                if ($_.Exception -isnot [CompanionContentException] -or (Test-ValidatorInfrastructureFailure -Exception $_.Exception)) { return New-StateEventOperationResult -Outcome failure -Class compute -Reason adapter-validator-infrastructure-failed -ProvenanceDocument $target }
                $baselineRead = [pscustomobject]@{ outcome = 'content-invalid'; document = $null }
                $baseline = $null
            }
        }
        if ($baselineRead.outcome -ceq 'valid') {
            $relation = Compare-SourceIdentity -Left (Get-ConsumptionSourceIdentity -Document $target) -Right (Get-ConsumptionSourceIdentity -Document $baseline)
            if ($relation.comparable -and $relation.order -lt 0) { return New-StateEventOperationResult -Outcome failure -Class stale-target -Reason target-precedes-baseline -ProvenanceDocument $target -Retryable $true }
        }

        $targetIdentity = New-StateEventTargetIdentity -Document $target
        if ($Resync) {
            # A rejected record may hold a consumed transition the runtime never journaled, so it
            # is fenced only below a live resync: one above every rejected record replays, and
            # otherwise a fresh resync commits first. A quarantined resync is never live.
            $rejectedCeiling = 0L
            foreach ($entry in $reconciliation.rejected) { $rejectedCeiling = [Math]::Max($rejectedCeiling, [long] $entry.sequence) }
            $live = Find-StateEventLiveResync -Reconciliation $reconciliation -RepairOperationId $RepairOperationId
            if ($null -ne $live -and $live.sequence -gt $rejectedCeiling) {
                Invoke-StateEventResyncFence -CompanionRoot $CompanionRoot -Reconciliation $reconciliation -OperationalWarnings $OperationalWarnings -ReceiptWarnings $ReceiptWarnings -WriteLedger $WriteLedger

                return New-StateEventOperationResult -Outcome replayed -Kind $live.kind -LogicalOutboxId $live.logicalOutboxId -Sequence $live.sequence -ProvenanceDocument $target
            }
            $kind = 'resync'
            $comparisonBaseline = $null
        }
        elseif ($baselineRead.outcome -ceq 'valid' -and (Test-StateEventTargetIdentityEqual -GeneratedAt $baseline.RootElement.GetProperty('generatedAt') -Source $baseline.RootElement.GetProperty('source') -State $target.RootElement)) {
            if (-not $RequireRecord) {
                return New-StateEventOperationResult -Outcome unchanged -Target $targetIdentity -ProvenanceDocument $target
            }
            $kind = 'snapshot'
            $comparisonBaseline = $baseline
        }
        else {
            $kind = 'consumed'
            $comparisonBaseline = $baseline
        }

        # A repair must commit its resync before it can drain what fills the outbox, so the
        # bound applies to ordinary publishes; resyncs stay finite because a repair has one live
        # resync and a fresh one commits only above a record its fence then retires.
        if (-not $Resync -and $reconciliation.pending.Count -ge $script:StateEventPendingLimit) { return New-StateEventOperationResult -Outcome failure -Class outbox -Reason outbox-full -ProvenanceDocument $target }
        $nextSequence = [Math]::Max([long] $reconciliation.ledger.highWaterSequence, [long] $reconciliation.highestFileSequence) + 1
        if ($nextSequence -gt $script:StateEventSequenceMaximum) { return New-StateEventOperationResult -Outcome failure -Class outbox -Reason outbox-sequence-exhausted -ProvenanceDocument $target }

        try {
            $diff = Compare-Digests -Baseline $comparisonBaseline -Target $target -AdapterConfig $AdapterConfig -WarningSink $AttemptWarnings
            Assert-DiffSemantics -Diff $diff -Baseline $comparisonBaseline -Target $target -AdapterConfig $AdapterConfig
        }
        catch {
            $reason = if ($_.Exception -is [CompanionDiffCompatibilityException]) { 'diff-compatibility-failed' } elseif ($_.Exception -is [CompanionDiffSemanticException]) { 'diff-validation-failed' } else { 'diff-compute-failed' }

            return New-StateEventOperationResult -Outcome failure -Class compute -Reason $reason -ProvenanceDocument $target
        }
        try {
            $incarnation = $reconciliation.ledger.incarnationId
            $recordWarnings = [object[]] @(ConvertTo-StateEventWarningArray -Warnings @(@($AttemptWarnings.Freeze()) + @($OperationalWarnings.Peek()) | Where-Object { $_.code -cne 'consume-cache-fallback' }))
            $record = [ordered]@{
                stateEventVersion = 1
                logicalOutboxId = Get-StateEventLogicalOutboxId -IncarnationId $incarnation -Sequence $nextSequence
                incarnationId = $incarnation
                sequence = $nextSequence
                kind = $kind
                createdAt = Get-StateEventUtcNow
                principal = $Principal
                repairOperationId = if ($kind -ceq 'resync') { $RepairOperationId } else { $null }
                adapterVersion = $AdapterConfig.AdapterVersion
                game = $AdapterConfig.Game
                baseline = if ($null -eq $comparisonBaseline) { $null } else { New-StateEventTargetIdentity -Document $comparisonBaseline }
                sourceFloor = ConvertTo-WalkIdentity -Source $Context.SourceFloor
                refresh = [ordered]@{ attempted = $Context.RefreshAttempted; commitObserved = $Context.RefreshCommitObserved; attempts = $Context.RefreshAttempts }
                warnings = $recordWarnings
                baselineReset = $null -eq $comparisonBaseline
                diff = $diff.RootElement
                state = $target.RootElement
            }
        }
        catch { return New-StateEventOperationResult -Outcome failure -Class compute -Reason payload-build-failed -ProvenanceDocument $target }
        try {
            $json = & $SerializeRecord $record
            $bytes = $script:CompanionJsonUtf8.GetBytes($json)
        }
        catch { return New-StateEventOperationResult -Outcome failure -Class 'outbox-write:not-consumed' -Reason record-serialize-failed -ConsumptionState notConsumed -ProvenanceDocument $target }
        try { [void] (Read-StateEventRecord -Bytes $bytes -Mode Producer -AdapterConfig $AdapterConfig -ExpectedSequence $nextSequence) }
        catch {
            if ($_.Exception -isnot [CompanionContentException] -or (Test-ValidatorInfrastructureFailure -Exception $_.Exception)) { return New-StateEventOperationResult -Outcome failure -Class compute -Reason adapter-validator-infrastructure-failed -ProvenanceDocument $target }

            return New-StateEventOperationResult -Outcome failure -Class compute -Reason payload-build-failed -ProvenanceDocument $target
        }

        $recordPath = Join-Path (Get-StateEventOutboxPath -CompanionRoot $CompanionRoot) (Get-StateEventRecordName -Sequence $nextSequence)
        try { & $CommitRecord $recordPath $bytes }
        catch {
            $reason = if ($_.Exception -is [CompanionStateWriteException] -and $_.Exception.Stage -ceq 'replace') { 'record-commit-failed' } else { 'record-temp-write-failed' }

            return New-StateEventOperationResult -Outcome failure -Class 'outbox-write:not-consumed' -Reason $reason -ConsumptionState notConsumed -ProvenanceDocument $target
        }
        & $AfterCommit $recordPath
        if ($Resync) { Invoke-StateEventResyncFence -CompanionRoot $CompanionRoot -Reconciliation $reconciliation -OperationalWarnings $OperationalWarnings -ReceiptWarnings $ReceiptWarnings -WriteLedger $WriteLedger }

        # The move above is the commit point; nothing after it can fail the transaction.
        $logicalOutboxId = $record.logicalOutboxId
        if ($kind -ceq 'snapshot') { $baselineApplied = $true }
        else {
            try { & $WriteBaseline $CompanionRoot $target; $baselineApplied = $true }
            catch { $baselineApplied = $false }
        }
        if (-not $baselineApplied) {
            Add-CompanionWarning -Sink $ReceiptWarnings -Code 'outbox-apply-deferred' -Detail $null

            return New-StateEventOperationResult -Outcome committed -ConsumptionState consumed -Kind $kind -LogicalOutboxId $logicalOutboxId -Sequence $nextSequence -Target $targetIdentity -BaselineApplied $false -CacheDegraded $true -ProvenanceDocument $target
        }
        $cacheDegraded = $false
        try {
            $fresh = & $ReadCurrent $CompanionRoot $AdapterConfig
            if ($fresh.outcome -ceq 'valid') { $cache = & $CompareCache $target $fresh.document $AdapterConfig }
            elseif ($fresh.outcome -cin @('absent', 'content-invalid', 'stale')) {
                Add-CompanionWarning -Sink $ReceiptWarnings -Code 'consume-cache-fallback' -Detail $null
                $cache = New-EmptyDiff -Target $target
            }
            else { $cache = $null }
            if ($null -eq $cache) { $cacheDegraded = $true } else { & $WriteCache $CompanionRoot $cache }
        }
        catch { $cacheDegraded = $true }

        return New-StateEventOperationResult -Outcome committed -ConsumptionState consumed -Kind $kind -LogicalOutboxId $logicalOutboxId -Sequence $nextSequence -Target $targetIdentity -BaselineApplied $true -CacheDegraded $cacheDegraded -ProvenanceDocument $target
    }
    finally {
        $lease.Dispose()
    }
}

# --- Settlement --------------------------------------------------------------------

function Invoke-StateEventSettlement {
    param(
        [Parameter(Mandatory)] [string] $CompanionRoot,
        [Parameter(Mandatory)] [string] $LogicalOutboxId,
        [Parameter(Mandatory)] [string] $RecordSha256,
        [Parameter(Mandatory)] [string] $JournalId,
        [Parameter(Mandatory)] [string] $EventId,
        [Parameter(Mandatory)] [CompanionWarningSink] $OperationalWarnings,
        [Parameter()] [scriptblock] $EnterConsumeLock = { param([string] $Root) Enter-CompanionConsumeLock -CompanionRoot $Root },
        [Parameter()] [scriptblock] $WriteLedger = { param([string] $Root, $Ledger, [long[]] $Existing) Write-StateEventLedger -CompanionRoot $Root -Ledger $Ledger -ExistingRecordSequences $Existing },
        [Parameter()] [scriptblock] $DeleteRecord = { param([string] $Path) [IO.File]::Delete($Path) }
    )

    $failure = { param([string] $Class, [string] $Reason) [pscustomobject]@{ outcome = $null; outcomeClass = $Class; reason = $Reason } }
    try { $lease = & $EnterConsumeLock $CompanionRoot }
    catch [TimeoutException] { return & $failure busy lock-timeout }
    catch { return & $failure lock lock-open-failed }
    try {
        $ownership = Get-CompanionOwnershipFailure -CompanionRoot $CompanionRoot -Role runtime
        if ($null -ne $ownership) { return & $failure config $ownership }
        try { $reconciliation = Invoke-StateEventReconciliation -CompanionRoot $CompanionRoot -Mode Normal -OperationalWarnings $OperationalWarnings -WriteLedger $WriteLedger }
        catch [StateEventFailure] { return & $failure $_.Exception.OutcomeClass $_.Exception.Reason }
        $pending = @($reconciliation.pending)
        for ($index = 0; $index -lt $pending.Count; $index++) {
            $entry = $pending[$index]
            if (-not [string]::Equals($entry.record.logicalOutboxId, $LogicalOutboxId, [StringComparison]::Ordinal)) { continue }
            if (-not [string]::Equals($entry.sha256, $RecordSha256, [StringComparison]::Ordinal)) { return & $failure settlement settlement-hash-mismatch }
            if ($index -gt 0) { return & $failure settlement settlement-out-of-order }
            $reconciliation.ledger.settled.Add((New-StateEventTombstone -Sequence $entry.sequence -Outcome delivered -RecordSha256 $entry.sha256 -LogicalOutboxId $entry.record.logicalOutboxId -Kind $entry.record.kind -JournalId $JournalId -EventId $EventId -RepairOperationId $entry.record.repairOperationId))
            try { & $WriteLedger $CompanionRoot $reconciliation.ledger $reconciliation.recordSequences }
            catch { return & $failure outbox outbox-write-failed }
            try { & $DeleteRecord (Join-Path (Get-StateEventOutboxPath -CompanionRoot $CompanionRoot) $entry.name) }
            catch { Add-CompanionWarning -Sink $OperationalWarnings -Code 'pipeline-cleanup-degraded' -Detail $null }

            return [pscustomobject]@{ outcome = 'settled'; outcomeClass = $null; reason = $null }
        }
        # A quarantined tombstone is keyed by sequence, because bytes that could not be parsed
        # leave a null logical identifier; the equal hash makes the key safe across incarnations.
        $quarantined = Find-StateEventTombstone -Ledger $reconciliation.ledger -Sequence (Get-StateEventSequenceFromLogicalOutboxId -LogicalOutboxId $LogicalOutboxId)
        if ($null -ne $quarantined -and $quarantined.outcome -ceq 'quarantined' -and [string]::Equals($quarantined.recordSha256, $RecordSha256, [StringComparison]::Ordinal)) { return & $failure settlement settlement-quarantined }
        foreach ($tombstone in $reconciliation.ledger.settled) {
            if (-not [string]::Equals($tombstone.logicalOutboxId, $LogicalOutboxId, [StringComparison]::Ordinal)) { continue }
            if ($tombstone.outcome -ceq 'delivered' -and [string]::Equals($tombstone.recordSha256, $RecordSha256, [StringComparison]::Ordinal) -and [string]::Equals($tombstone.journalId, $JournalId, [StringComparison]::Ordinal) -and [string]::Equals($tombstone.eventId, $EventId, [StringComparison]::Ordinal)) {
                return [pscustomobject]@{ outcome = 'already-settled'; outcomeClass = $null; reason = $null }
            }

            return & $failure settlement settlement-conflict
        }

        return & $failure settlement settlement-unknown
    }
    finally {
        $lease.Dispose()
    }
}

# --- Consumer switch ---------------------------------------------------------------

function Invoke-CompanionConsumerSwitch {
    param(
        [Parameter(Mandatory)] [string] $CompanionRoot,
        [Parameter(Mandatory)] [ValidateSet('bridge', 'runtime')] [string] $Owner,
        [switch] $DeliveryConfirmed,
        [switch] $AbandonUndelivered,
        [Parameter(Mandatory)] [CompanionWarningSink] $OperationalWarnings,
        [Parameter()] [scriptblock] $EnterConsumeLock = { param([string] $Root) Enter-CompanionConsumeLock -CompanionRoot $Root },
        [Parameter()] [scriptblock] $WriteLedger = { param([string] $Root, $Ledger, [long[]] $Existing) Write-StateEventLedger -CompanionRoot $Root -Ledger $Ledger -ExistingRecordSequences $Existing },
        [Parameter()] [scriptblock] $RemoveBaseline = { param([string] $Root) Remove-CompanionBaselineFile -CompanionRoot $Root },
        [Parameter()] [scriptblock] $DeleteRecord = { param([string] $Path) [IO.File]::Delete($Path) },
        [Parameter()] [scriptblock] $WriteMarker = { param([string] $Root, [string] $Value) Write-CompanionConsumerMarker -CompanionRoot $Root -Owner $Value }
    )

    $failure = { param([string] $Class, [string] $Reason) [pscustomobject]@{ outcomeClass = $Class; reason = $Reason; owner = $null; changed = $false; baselineRemoved = $false; abandonedCount = 0 } }
    try { $lease = & $EnterConsumeLock $CompanionRoot }
    catch [TimeoutException] { return & $failure busy lock-timeout }
    catch { return & $failure lock lock-open-failed }
    try {
        $marker = Read-CompanionConsumerMarker -CompanionRoot $CompanionRoot
        if ($marker.outcome -ceq 'infrastructure-failure') { return & $failure config consumer-owner-unreadable }
        $mode = if ($AbandonUndelivered) { 'Abandon' } else { 'Normal' }
        try { $reconciliation = Invoke-StateEventReconciliation -CompanionRoot $CompanionRoot -Mode $mode -OperationalWarnings $OperationalWarnings -WriteLedger $WriteLedger -RemoveBaseline $RemoveBaseline }
        catch [StateEventFailure] { return & $failure $_.Exception.OutcomeClass $_.Exception.Reason }
        $baselineRemoved = $reconciliation.baselineRemoved
        $markerRuntime = $marker.outcome -ceq 'valid' -and $marker.owner -ceq 'runtime'
        $previousOwner = switch ($marker.outcome) { 'absent' { 'absent' } 'valid' { $marker.owner } default { 'invalid' } }
        $releasing = $markerRuntime -or $marker.outcome -ceq 'content-invalid' -or $reconciliation.releasingByRecord
        $tryWriteMarker = {
            param([string] $Value)
            try { & $WriteMarker $CompanionRoot $Value }
            catch { return $false }

            return $true
        }
        $done = { param([bool] $Changed, [int] $Abandoned) [pscustomobject]@{ outcomeClass = $null; reason = $null; owner = $Owner; previousOwner = $previousOwner; changed = $Changed; baselineRemoved = $baselineRemoved; abandonedCount = $Abandoned } }

        if (-not $releasing) {
            if ($Owner -ceq 'bridge') { return & $done $false 0 }
            if (-not (& $tryWriteMarker 'runtime')) { return & $failure outbox outbox-write-failed }

            return & $done $true 0
        }
        if ($Owner -ceq 'runtime') {
            if ($markerRuntime) { return & $done $false 0 }
            if (-not (& $tryWriteMarker 'runtime')) { return & $failure outbox outbox-write-failed }

            return & $done $true 0
        }
        if ($DeliveryConfirmed) {
            if ($reconciliation.pending.Count -gt 0) { return & $failure config release-pending-records }
            if (-not (& $tryWriteMarker 'bridge')) { return & $failure outbox outbox-write-failed }

            return & $done $true 0
        }
        if (-not $AbandonUndelivered) { return & $failure config release-decision-required }

        # Reconciliation's abandon mode already deleted the baseline before step 6.
        $pending = @($reconciliation.pending)
        if ($pending.Count -gt 0) {
            foreach ($entry in $pending) {
                $reconciliation.ledger.settled.Add((New-StateEventTombstone -Sequence $entry.sequence -Outcome abandoned -RecordSha256 $entry.sha256 -LogicalOutboxId $entry.record.logicalOutboxId -Kind $entry.record.kind -JournalId $null -EventId $null -RepairOperationId $entry.record.repairOperationId))
            }
            try { & $WriteLedger $CompanionRoot $reconciliation.ledger $reconciliation.recordSequences }
            catch { return & $failure outbox outbox-write-failed }
            foreach ($entry in $pending) {
                try { & $DeleteRecord (Join-Path (Get-StateEventOutboxPath -CompanionRoot $CompanionRoot) $entry.name) }
                catch { Add-CompanionWarning -Sink $OperationalWarnings -Code 'pipeline-cleanup-degraded' -Detail $null }
            }
        }
        if (-not (& $tryWriteMarker 'bridge')) { return & $failure outbox outbox-write-failed }

        return & $done $true $pending.Count
    }
    finally {
        $lease.Dispose()
    }
}

# --- Publish transaction -----------------------------------------------------------

# One Publish-StateEvent.ps1 attempt: 7.5 stages 1 through 5 unchanged, with stage 6
# replaced by the outbox-mode operation. A stage 1 to 5 failure returns the shared
# TurnContextAttemptResult; the outbox stage returns a state-event operation result that
# also carries the admitted preflight target for diagnostic provenance.
function Invoke-StateEventAttempt {
    param(
        [Parameter(Mandatory)] [string] $CompanionRoot,
        [Parameter(Mandatory)] [AdapterConfig] $AdapterConfig,
        [Parameter(Mandatory)] [CompanionWarningSink] $OperationalWarnings,
        [Parameter(Mandatory)] [CompanionWarningSink] $ReceiptWarnings,
        [Parameter(Mandatory)] [string] $Principal,
        [switch] $RequireRecord,
        [switch] $Resync,
        [AllowNull()] [string] $RepairOperationId,
        [Parameter()] [hashtable] $Operations = @{},
        [Parameter()] [hashtable] $ConsumptionSeams = @{}
    )

    $stateEventRequest = [pscustomobject]@{ CompanionRoot = $CompanionRoot; AdapterConfig = $AdapterConfig; OperationalWarnings = $OperationalWarnings; ReceiptWarnings = $ReceiptWarnings; Principal = $Principal; RequireRecord = [bool] $RequireRecord; Resync = [bool] $Resync; RepairOperationId = $RepairOperationId; Seams = $ConsumptionSeams }
    $attemptOperations = @{} + $Operations
    $attemptOperations['ConsumeStage'] = {
        param($Stage)

        $request = $stateEventRequest
        $context = [TurnContextPayloadContext]::new($Stage.Floor, $Stage.RefreshAttempts -gt 0, $Stage.RefreshCommitted, $Stage.RefreshAttempts)
        $seams = $request.Seams
        $result = Invoke-StateEventConsumption @seams -AdapterConfig $request.AdapterConfig -CompanionRoot $request.CompanionRoot -SourceFloor $Stage.Floor -Context $context -AttemptWarnings $Stage.AttemptWarnings -OperationalWarnings $request.OperationalWarnings -ReceiptWarnings $request.ReceiptWarnings -Principal $request.Principal -RequireRecord:$request.RequireRecord -Resync:$request.Resync -RepairOperationId $request.RepairOperationId
        if ($result.stateEventOutcome -ceq 'failure' -and $result.retryable -and $Stage.Pass -lt ($script:TurnContextRefreshAttemptCap - 1)) { return [pscustomobject]@{ action = 'retry'; terminalResult = $null } }
        $result | Add-Member -NotePropertyName admittedTarget -NotePropertyValue $Stage.AdmittedTarget

        return [pscustomobject]@{ action = 'terminal'; terminalResult = $result }
    }

    return Invoke-TurnContextAttempt -CompanionRoot $CompanionRoot -AdapterConfig $AdapterConfig -OperationalWarnings $OperationalWarnings -Operations $attemptOperations
}

function Test-StateEventOperationResult {
    param([AllowNull()] $Value)

    return $null -ne $Value -and $null -ne $Value.PSObject.Properties['stateEventOutcome']
}

# Builds the Publish exit-1 diagnostic for a state-event operation failure, or for a
# delivery failure after one. Provenance follows the 7.5 latch: config clears it, a
# failure before the locked freeze uses the admitted preflight target, and every later
# failure uses the final target.
function New-StateEventPublishDiagnostic {
    param([Parameter(Mandatory)] $Result, [Parameter(Mandatory)] [string] $Class, [Parameter(Mandatory)] [string] $Reason, [Parameter(Mandatory)] [string] $ConsumptionState, [Parameter(Mandatory)] [CompanionWarningSink] $OperationalWarnings)

    $sourceIdentity = $null
    $generation = $null
    if ($Class -cne 'config') {
        $document = if ($null -ne $Result.provenanceDocument) { $Result.provenanceDocument } else { $Result.admittedTarget }
        $sourceIdentity = $document.RootElement.GetProperty('source')
        $generation = $document.RootElement.GetProperty('generatedAt').GetString()
    }
    $lockStage = if ($Class -cin @('busy', 'lock')) { 'consume' } else { $null }

    return New-TurnContextDiagnosticObject -Class $Class -ConsumptionState $ConsumptionState -Detail (New-StateEventDetail -Script Publish -Class $Class -Reason $Reason) -SourceIdentity $sourceIdentity -GenerationTimestamp $generation -LockStage $lockStage -OperationalWarnings $OperationalWarnings
}

function ConvertTo-StateEventReceiptJson {
    param([Parameter(Mandatory)] $Result, [Parameter(Mandatory)] [AdapterConfig] $AdapterConfig, [Parameter(Mandatory)] [CompanionWarningSink] $OperationalWarnings, [Parameter(Mandatory)] [CompanionWarningSink] $ReceiptWarnings)

    $receipt = [ordered]@{
        outcome = $Result.stateEventOutcome
        kind = $Result.kind
        logicalOutboxId = $Result.logicalOutboxId
        sequence = $Result.sequence
        target = $Result.target
        schemaVersion = Get-CoreSchemaVersion
        adapterVersion = $AdapterConfig.AdapterVersion
        game = $AdapterConfig.Game
        baselineApplied = $Result.baselineApplied
        cacheDegraded = [bool] $Result.cacheDegraded
        warnings = [object[]] @(ConvertTo-StateEventWarningArray -Warnings @(@($ReceiptWarnings.Freeze()) + @($OperationalWarnings.Freeze())))
    }
    $json = ConvertTo-CompanionJson -InputObject $receipt -Budget config
    [void] (Read-StateEventReceipt -Json $json -AdapterConfig $AdapterConfig)

    return $json
}

function Read-StateEventSettlementResult {
    param([Parameter(Mandatory)] [string] $Json)

    $document = Read-CompanionJson -Json $Json -Budget config
    $root = $document.RootElement
    Test-ExactFields $root @('outcome', 'logicalOutboxId')
    if ((Test-String (Get-Property $root outcome)) -cnotin @('settled', 'already-settled') -or -not (Test-StateEventLogicalOutboxIdText -Value (Test-String (Get-Property $root logicalOutboxId)))) { Fail-Document }

    return $document
}

function Read-CompanionConsumerResult {
    param([Parameter(Mandatory)] [string] $Json)

    $document = Read-CompanionJson -Json $Json -Budget config
    $root = $document.RootElement
    Test-ExactFields $root @('owner', 'previousOwner', 'changed', 'baselineRemoved', 'abandonedCount')
    if ((Test-String (Get-Property $root owner)) -cnotin @('bridge', 'runtime')) { Fail-Document }
    if ((Test-String (Get-Property $root previousOwner)) -cnotin @('absent', 'bridge', 'runtime', 'invalid')) { Fail-Document }
    Test-Boolean (Get-Property $root changed)
    Test-Boolean (Get-Property $root baselineRemoved)
    [void] (Test-Integer (Get-Property $root abandonedCount) $true)

    return $document
}
