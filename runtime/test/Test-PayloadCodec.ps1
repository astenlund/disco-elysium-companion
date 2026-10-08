#Requires -Version 7.5
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
Import-Module (Join-Path $repoRoot 'core/tests/TestSupport.psm1') -Force
Add-Type -Path @((Join-Path $repoRoot 'runtime/scripts/JsonDocuments.cs'), (Join-Path $repoRoot 'runtime/scripts/EventDocuments.cs'), (Join-Path $repoRoot 'runtime/scripts/PayloadCodec.cs'))
$utf8 = [Text.UTF8Encoding]::new($false, $true)

# This fixture exercises raw transport/integrity, not core digest admission or settlement.
$sample = New-RuntimePayloadSample
$time = $sample.Time
$floor = $sample.Floor
$rawState = $sample.RawState
$diff = $sample.Diff
$sourceText = $sample.SourceText
$source = $sample.Source
$hash = $sample.Hash
$metadata = $sample.Metadata
$metadataBytes = $utf8.GetBytes((ConvertTo-Json -InputObject $metadata -Depth 8 -Compress))
$eventBytes = [Companion.Runtime.PayloadCodec]::CreateEvent($source, $metadataBytes)
$binding = [Companion.Runtime.PayloadCodec]::Verify($eventBytes)
$expectedPayload = '{"baseline":null,"sourceFloor":' + $floor + ',"refresh":{"attempted":false,"commitObserved":false,"attempts":0},"warnings":[],"baselineReset":true,"diff":' + $diff + ',"state":' + $rawState + '}'
$expectedBinding = [Convert]::ToHexStringLower([Security.Cryptography.SHA256]::HashData($utf8.GetBytes('companion-core-payload-v1' + [char]10 + $hash + [char]10 + $expectedPayload)))
Assert-OrdinalEqual -Actual $binding -Expected $expectedBinding -Message 'binding equals the independent exact-byte recipe'
$event = [Text.Json.JsonDocument]::Parse([ReadOnlyMemory[byte]]::new($eventBytes))
try {
    $payload = $event.RootElement.GetProperty('payload').GetRawText()
    Assert-OrdinalEqual -Actual $payload -Expected $expectedPayload -Message 'all seven raw fields have the prescribed order and compact outer punctuation'
    Assert-OrdinalEqual -Actual $event.RootElement.GetProperty('payload').GetProperty('state').GetRawText() -Expected $rawState -Message 'state raw token survives without numeric or string reserialization'
}
finally { $event.Dispose() }
$metadata.settlement = 'accepted'
$metadata.acceptance = [ordered]@{ journalId = 'journal'; eventId = ('d' * 32); generation = ('1' * 32) }
$rewritten = [Companion.Runtime.PayloadCodec]::RewriteEvent($eventBytes, $utf8.GetBytes((ConvertTo-Json -InputObject $metadata -Depth 8 -Compress)), $false)
$updated = [Text.Json.JsonDocument]::Parse([ReadOnlyMemory[byte]]::new($rewritten))
try {
    Assert-OrdinalEqual -Actual $updated.RootElement.GetProperty('payload').GetRawText() -Expected $payload -Message 'metadata rewrite preserves exact complete payload token'
    Assert-OrdinalEqual -Actual ([Companion.Runtime.PayloadCodec]::Verify($rewritten)) -Expected $binding -Message 'binding remains immutable'
}
finally { $updated.Dispose() }
$changed = $utf8.GetBytes($utf8.GetString($rewritten).Replace('9007199254740993', '9007199254740994'))
Assert-ThrowsType 'DocumentInvalidException' { [Companion.Runtime.PayloadCodec]::Verify($changed) }
$metadata.compacted = $true
$compact = [Companion.Runtime.PayloadCodec]::RewriteEvent($rewritten, $utf8.GetBytes((ConvertTo-Json -InputObject $metadata -Depth 8 -Compress)), $true)
Assert-OrdinalEqual -Actual ([Companion.Runtime.PayloadCodec]::Verify($compact)) -Expected $binding -Message 'compact evidence retains the original binding'
$metadata.compacted = $false
Assert-ThrowsType 'DocumentInvalidException' { [Companion.Runtime.PayloadCodec]::RewriteEvent($compact, $utf8.GetBytes((ConvertTo-Json -InputObject $metadata -Depth 8 -Compress)), $false) }

# Readable corrupt metadata is rejected before any payload can be selected.
foreach ($mutation in @(
    { param($x) $x['sequence'] = [Text.Json.Nodes.JsonValue]::Create(0) },
    { param($x) $x['sequence'] = [Text.Json.Nodes.JsonValue]::Create(9007199254740992L) },
    { param($x) $x['sequence'] = [Text.Json.Nodes.JsonValue]::Create(1.5) },
    { param($x) $x['eventId'] = [Text.Json.Nodes.JsonValue]::Create(('d' * 32) + [char]10) },
    { param($x) $x['payloadBindingSha256'] = [Text.Json.Nodes.JsonValue]::Create(('a' * 64) + [char]10) },
    { param($x) $x['acceptance'] = $null },
    { param($x) $x['attemptRef'] = [Text.Json.Nodes.JsonNode]::Parse('{"operationId":"jr-11111111111111111111111111111111","attemptOrdinal":0}') },
    { param($x) $x['occurredAt'] = [Text.Json.Nodes.JsonValue]::Create('2026-02-30T01:23:45.1234567Z') }
)) {
    $node = [Text.Json.Nodes.JsonNode]::Parse($utf8.GetString($rewritten))
    & $mutation $node
    $damaged = $utf8.GetBytes($node.ToJsonString())
    Assert-ThrowsType 'DocumentInvalidException' { [Companion.Runtime.PayloadCodec]::Verify($damaged) }
}

# Root and pairwise failures must be discovered before creating a source binding.
foreach ($mutation in @(
    { param($x) $x['logicalOutboxId'] = [Text.Json.Nodes.JsonValue]::Create(('c' * 32) + '-01') },
    { param($x) $x['stateEventVersion'] = [Text.Json.Nodes.JsonValue]::Create(2) },
    { param($x) $x['baselineReset'] = [Text.Json.Nodes.JsonValue]::Create($false) },
    { param($x) $x['kind'] = [Text.Json.Nodes.JsonValue]::Create('snapshot') },
    { param($x) $x['sourceFloor']['savedAt'] = [Text.Json.Nodes.JsonValue]::Create('2026-10-08T01:23:45.1234567Z') },
    { param($x) $x['diff']['currentSource']['saveFile'] = [Text.Json.Nodes.JsonValue]::Create('other.zip') },
    { param($x) $x['diff']['schemaVersion'] = [Text.Json.Nodes.JsonValue]::Create(3) },
    { param($x) $x['refresh']['commitObserved'] = [Text.Json.Nodes.JsonValue]::Create($true) },
    { param($x) $x['warnings'] = [Text.Json.Nodes.JsonNode]::Parse('[{"code":"pipeline-cleanup-degraded","detail":"unexpected"}]') },
    { param($x) $x['warnings'] = [Text.Json.Nodes.JsonNode]::Parse('[{"code":"consume-cache-fallback","detail":null}]') }
)) {
    $node = [Text.Json.Nodes.JsonNode]::Parse($sourceText)
    & $mutation $node
    $damaged = $utf8.GetBytes($node.ToJsonString())
    $document = [Text.Json.JsonDocument]::Parse([ReadOnlyMemory[byte]]::new($damaged))
    try { Assert-ThrowsType 'DocumentInvalidException' { [Companion.Runtime.EventDocuments]::ValidateOutbox($document.RootElement) } }
    finally { $document.Dispose() }
    Assert-ThrowsType 'DocumentInvalidException' { [Companion.Runtime.PayloadCodec]::CreateEvent($damaged, $metadataBytes) }
}

$metadata.principal = 'different'
Assert-ThrowsType 'DocumentInvalidException' { [Companion.Runtime.PayloadCodec]::RewriteEvent($rewritten, $utf8.GetBytes((ConvertTo-Json -InputObject $metadata -Depth 8 -Compress)), $false) }
$metadata.principal = 'principal'
$metadata.acceptance.eventId = 'changed-original-binding'
Assert-ThrowsType 'DocumentInvalidException' { [Companion.Runtime.PayloadCodec]::RewriteEvent($rewritten, $utf8.GetBytes((ConvertTo-Json -InputObject $metadata -Depth 8 -Compress)), $false) }
$metadata.acceptance.eventId = 'd' * 32
$metadata.journalId = 'replacement-journal'
$metadata.eventId = '7' * 32
$restored = [Companion.Runtime.PayloadCodec]::ReconstructEvent($source, $utf8.GetBytes((ConvertTo-Json -InputObject $metadata -Depth 8 -Compress)), $binding)
Assert-OrdinalEqual -Actual ([Companion.Runtime.PayloadCodec]::Verify($restored)) -Expected $binding -Message 'independently matched source can reconstruct a new destination under the original binding'
Assert-ThrowsType 'DocumentInvalidException' { [Companion.Runtime.PayloadCodec]::ReconstructEvent($source, $utf8.GetBytes((ConvertTo-Json -InputObject $metadata -Depth 8 -Compress)), ('0' * 64)) }
$wideVersionSample = New-RuntimePayloadSample
$wideVersionSource = $utf8.GetBytes($wideVersionSample.SourceText.Replace('"adapterVersion":1', '"adapterVersion":-9223372036854775808'))
$wideVersionMetadata = $wideVersionSample.Metadata
$wideVersionMetadata.adapterVersion = [long]::MinValue
$wideVersionMetadata.recordSha256 = [Convert]::ToHexStringLower([Security.Cryptography.SHA256]::HashData($wideVersionSource))
$wideVersionEvent = [Companion.Runtime.PayloadCodec]::CreateEvent($wideVersionSource, $utf8.GetBytes((ConvertTo-Json -InputObject $wideVersionMetadata -Depth 8 -Compress)))
$wideVersionDocument = [Text.Json.JsonDocument]::Parse([ReadOnlyMemory[byte]]::new($wideVersionEvent))
try {
    Assert-OrdinalEqual -Actual $wideVersionDocument.RootElement.GetProperty('adapterVersion').GetRawText() -Expected '-9223372036854775808' -Message 'version metadata retains the accepted signed Int64 range'
}
finally { $wideVersionDocument.Dispose() }
[Companion.Runtime.PayloadCodec]::ValidateFinalizationBudget($eventBytes)
[Companion.Runtime.PayloadCodec]::ValidateFinalizationBudget($rewritten)
[Companion.Runtime.PayloadCodec]::ValidateFinalizationBudget($compact)

# An initially valid pending event must still leave room for its final controls.
$minimum = [int][Companion.Runtime.JsonDocuments]::Budget('state-event').TextBytes - 4096
$maximum = [int][Companion.Runtime.JsonDocuments]::Budget('state-event').TextBytes
$largestPending = $null
while ($minimum -le $maximum) {
    $paddingSize = [int][Math]::Floor(($minimum + $maximum) / 2)
    $budgetSample = New-RuntimePayloadSample -PaddingBytes $paddingSize
    try {
        $candidate = [Companion.Runtime.PayloadCodec]::CreateEvent($budgetSample.Source, $utf8.GetBytes((ConvertTo-Json -InputObject $budgetSample.Metadata -Depth 8 -Compress)))
        $largestPending = $candidate
        $minimum = $paddingSize + 1
    }
    catch {
        $errorType = $_.Exception
        while ($null -ne $errorType.InnerException) { $errorType = $errorType.InnerException }
        if ($errorType.GetType().Name -cne 'DocumentInvalidException') { throw }
        $maximum = $paddingSize - 1
    }
}
Assert-True -Condition ($null -ne $largestPending) -Message 'near-budget pending fixture is initially valid'
$null = [Companion.Runtime.PayloadCodec]::Verify($largestPending)
Assert-ThrowsType 'DocumentInvalidException' { [Companion.Runtime.PayloadCodec]::ValidateFinalizationBudget($largestPending) }
Write-Output 'PASS: lossless payload binding'
