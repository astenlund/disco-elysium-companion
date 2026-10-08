#Requires -Version 7.5
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
Import-Module (Join-Path $repoRoot 'core/tests/TestSupport.psm1') -Force
Add-Type -Path @('NativeFiles.cs', 'JsonDocuments.cs', 'EventDocuments.cs', 'PayloadCodec.cs', 'ContextFingerprint.cs', 'ContextCodec.cs', 'ContextSelection.cs', 'RuntimeFilePublication.cs', 'RuntimeContext.cs' | ForEach-Object { Join-Path $repoRoot ('runtime/scripts/' + $_) })
$utf8 = [Text.UTF8Encoding]::new($false, $true)
$eventSample = New-RuntimeAcceptedPayloadSample
$sample = $eventSample.Sample
$metadata = $eventSample.Metadata
$pending = $eventSample.Pending
$pendingHash = [Convert]::ToHexStringLower([Security.Cryptography.SHA256]::HashData($pending))
Assert-ThrowsType 'DocumentInvalidException' { [Companion.Runtime.VerifiedContextRecord]::FromFrozen($pending, $pendingHash, ('1' * 32)) }
$accepted = $eventSample.Accepted
$acceptedHash = [Convert]::ToHexStringLower([Security.Cryptography.SHA256]::HashData($accepted))
$record = [Companion.Runtime.VerifiedContextRecord]::FromFrozen($accepted, $acceptedHash, ('1' * 32))
Assert-ThrowsType 'DocumentInvalidException' { [Companion.Runtime.VerifiedContextRecord]::FromFrozen($accepted, $acceptedHash, ('2' * 32)) }
$changed = $utf8.GetBytes($utf8.GetString($accepted).Replace('9007199254740993', '9007199254740994'))
$changedHash = [Convert]::ToHexStringLower([Security.Cryptography.SHA256]::HashData($changed))
Assert-ThrowsType 'DocumentInvalidException' { [Companion.Runtime.VerifiedContextRecord]::FromFrozen($changed, $changedHash, ('1' * 32)) }
$template = $utf8.GetBytes('{"companionTurnContextVersion":1,"interactionId":"interaction","requestReceivedAt":"2026-10-08T06:00:00.0000000Z","sessionOpening":true,"freshness":{"state":"fresh","class":null,"reason":null,"lastGoodGeneratedAt":null},"operational":{"state":"current","warnings":[]},"correction":null}')
$events = [Collections.Generic.List[Companion.Runtime.ContextEventSelection]]::new()
$events.Add([Companion.Runtime.ContextEventSelection]::new($record, $false))
$nullString = [System.Management.Automation.Language.NullString]::Value
$result = [Companion.Runtime.ContextCodec]::Render($template, $events, $record, ('1' * 32), $nullString, $false, $false, ('a' * 64), ('b' * 64), 4194304)
$text = $utf8.GetString($result.Bytes)
$opening = '<companion-turn-context>'
$closing = '</companion-turn-context>'
Assert-True -Condition ($text.StartsWith($opening, [StringComparison]::Ordinal) -and $text.EndsWith($closing, [StringComparison]::Ordinal)) -Message 'one complete tagged context block'
$json = $text.Substring($opening.Length, $text.Length - $opening.Length - $closing.Length)
$document = [Text.Json.JsonDocument]::Parse($json)
try {
    Assert-OrdinalEqual -Actual $document.RootElement.GetProperty('state').GetRawText() -Expected $sample.RawState -Message 'state values preserve exact numeric lexemes, escapes and timestamp fractions'
    Assert-OrdinalEqual -Actual $document.RootElement.GetProperty('events')[0].GetProperty('diff').GetRawText() -Expected $sample.Diff -Message 'diff is copied as its exact validated token'
    Assert-True -Condition ($null -eq $result.Degraded -and $result.StateIncluded -and $result.EventCount -eq 1) -Message 'full candidate metadata matches transmitted bytes'
}
finally { $document.Dispose() }
$redelivery = [Companion.Runtime.ContextCodec]::Redeliver($result, ('a' * 64), ('b' * 64))
Assert-Equal -Actual $redelivery.Offsets.Length -Expected 1 -Message 'only the direct event flag is a redelivery change'
Assert-Equal -Actual $redelivery.Bytes.Length -Expected ($result.Bytes.Length - 1) -Message 'true removes one UTF-8 byte per false flag'
$redeliveryText = $utf8.GetString($redelivery.Bytes)
$redeliveryDocument = [Text.Json.JsonDocument]::Parse($redeliveryText.Substring($opening.Length, $redeliveryText.Length - $opening.Length - $closing.Length))
try {
    Assert-True -Condition $redeliveryDocument.RootElement.GetProperty('events')[0].GetProperty('redelivery').GetBoolean() -Message 'the direct event flag becomes true'
    Assert-OrdinalEqual -Actual $redeliveryDocument.RootElement.GetProperty('state').GetRawText() -Expected $sample.RawState -Message 'redelivery leaves nested state flags and raw values untouched'
    Assert-OrdinalEqual -Actual $redeliveryDocument.RootElement.GetProperty('events')[0].GetProperty('diff').GetRawText() -Expected $sample.Diff -Message 'redelivery leaves nested diff flags and quoted names untouched'
    Assert-OrdinalEqual -Actual ([Companion.Runtime.ContextFingerprint]::Compute($utf8.GetBytes($redeliveryDocument.RootElement.GetRawText()), ('a' * 64), ('b' * 64))) -Expected $result.Fingerprint -Message 'redelivery has the same semantic fingerprint'
}
finally { $redeliveryDocument.Dispose() }
$tooSmall = [Companion.Runtime.ContextCodec]::Render($template, $events, $record, ('1' * 32), $nullString, $false, $false, ('a' * 64), ('b' * 64), ($result.Bytes.Length - 1))
Assert-True -Condition ($null -eq $tooSmall) -Message 'cap counts tags and all exact UTF-8 bytes'
$floor = [Companion.Runtime.ContextCodec]::Render($template, $events, $null, ('1' * 32), 'stateTooLarge', $true, $true, ('a' * 64), ('b' * 64), 4194304)
Assert-True -Condition (-not $floor.StateIncluded -and $floor.EventCount -eq 1 -and $floor.Bytes.Length -lt $result.Bytes.Length) -Message 'floor candidate retains one event with no state or diff'
Assert-OrdinalEqual -Actual $floor.Degraded -Expected 'stateTooLarge' -Message 'floor metadata describes omitted wanted state'
$ordinary = [Companion.Runtime.ContextSelection]::Select(1, $template, $events, $record, $true, ('1' * 32), ('a' * 64), ('b' * 64), $null)
Assert-Equal -Actual $ordinary.Bytes.Length -Expected $result.Bytes.Length -Message 'ordinary ladder retains the complete fitting prefix and state'
$smaller = [Companion.Runtime.ContextSelection]::Select(2, $template, $events, $record, $true, ('1' * 32), ('a' * 64), ('b' * 64), $result.Bytes.Length)
Assert-True -Condition ($null -eq $smaller) -Message 'half-size shape is infeasible when wanted state cannot fit'
$withoutDiff = [Companion.Runtime.ContextSelection]::Select(3, $template, $events, $record, $true, ('1' * 32), ('a' * 64), ('b' * 64), $null)
Assert-True -Condition ($withoutDiff.StateIncluded -and $withoutDiff.EventCount -eq 1 -and $withoutDiff.Bytes.Length -lt $ordinary.Bytes.Length) -Message 'third shape preserves state and omits the first diff'
$withoutState = [Companion.Runtime.ContextSelection]::Select(4, $template, $events, $record, $true, ('1' * 32), ('a' * 64), ('b' * 64), $null)
Assert-Equal -Actual $withoutState.Bytes.Length -Expected $floor.Bytes.Length -Message 'fourth shape preserves only the event header'
$largeSample = New-RuntimePayloadSample -PaddingBytes 4194304
$largeSource = $largeSample.Source
$largeMetadata = $largeSample.Metadata
$largeMetadata.recordSha256 = [Convert]::ToHexStringLower([Security.Cryptography.SHA256]::HashData($largeSource))
$largePending = [Companion.Runtime.PayloadCodec]::CreateEvent($largeSource, $utf8.GetBytes((ConvertTo-Json -InputObject $largeMetadata -Depth 8 -Compress)))
$largeMetadata.settlement = 'accepted'
$largeMetadata.acceptance = [ordered]@{ journalId = 'journal'; eventId = ('d' * 32); generation = ('1' * 32) }
$largeAccepted = [Companion.Runtime.PayloadCodec]::RewriteEvent($largePending, $utf8.GetBytes((ConvertTo-Json -InputObject $largeMetadata -Depth 8 -Compress)), $false)
$largeHash = [Convert]::ToHexStringLower([Security.Cryptography.SHA256]::HashData($largeAccepted))
$largeRecord = [Companion.Runtime.VerifiedContextRecord]::FromFrozen($largeAccepted, $largeHash, ('1' * 32))
$largeEvents = [Collections.Generic.List[Companion.Runtime.ContextEventSelection]]::new()
$largeEvents.Add([Companion.Runtime.ContextEventSelection]::new($largeRecord, $false))
$limited = [Companion.Runtime.ContextSelection]::Select(1, $template, $largeEvents, $largeRecord, $true, ('1' * 32), ('a' * 64), ('b' * 64), $null)
Assert-True -Condition (-not $limited.StateIncluded -and $limited.EventCount -eq 1 -and $limited.Bytes.Length -le 4194304) -Message 'oversized wanted state reaches a bounded header-only candidate'
Assert-OrdinalEqual -Actual $limited.Degraded -Expected 'stateTooLarge' -Message 'oversized state is disclosed without an older-state fallback'
$events.Add([Companion.Runtime.ContextEventSelection]::new($record, $true))
Assert-ThrowsType 'DocumentInvalidException' { [Companion.Runtime.ContextCodec]::Render($template, $events, $record, ('1' * 32), $nullString, $false, $false, ('a' * 64), ('b' * 64), 4194304) }

$staged = New-StagedRuntimeContextRoot -Prefix 'runtime-context' -EventBytes $accepted
$fixture = $staged.Root
$request = [ordered]@{
    contextRequestVersion = 1; scopeSha256 = $staged.ScopeSha256; safetySha256 = $staged.SafetySha256
    generation = ('1' * 32); journalId = 'journal'; game = 'game'; principal = 'principal'; template = ($utf8.GetString($template) | ConvertFrom-Json -AsHashtable -DateKind String)
    events = @(@{ sequence = 1; sha256 = $acceptedHash; redelivery = $false }); state = @{ sequence = 1; sha256 = $acceptedHash }; stateWanted = $true
    shape = $null; failedBlockBytes = $null; instructionsSha256 = ('a' * 64); providerFingerprint = ('b' * 64); disclosure = $false
}
$inputPath = Join-Path $fixture ('prepared-context.txt.' + ('a' * 32) + '.tmp')
$inputBytes = $utf8.GetBytes((ConvertTo-Json -InputObject $request -Depth 16 -Compress))
[IO.File]::WriteAllBytes($inputPath, $inputBytes)
$inputHash = [Convert]::ToHexStringLower([Security.Cryptography.SHA256]::HashData($inputBytes))
$previewReply = $utf8.GetString([Companion.Runtime.RuntimeContext]::Execute($fixture, $inputPath, $inputHash, 'Preview')) | ConvertFrom-Json -AsHashtable -DateKind String
Assert-True -Condition (-not $previewReply.published -and $previewReply.candidates.Count -eq 3) -Message 'preview returns bounded candidate metadata without publication'
Assert-False -Condition ([IO.File]::Exists((Join-Path $fixture 'prepared-context.txt'))) -Message 'preview has no prepared artifact'
$request.shape = 1
$inputBytes = $utf8.GetBytes((ConvertTo-Json -InputObject $request -Depth 16 -Compress))
[IO.File]::WriteAllBytes($inputPath, $inputBytes)
$inputHash = [Convert]::ToHexStringLower([Security.Cryptography.SHA256]::HashData($inputBytes))
$publishedReply = $utf8.GetString([Companion.Runtime.RuntimeContext]::Execute($fixture, $inputPath, $inputHash, 'Publish')) | ConvertFrom-Json -AsHashtable -DateKind String
Assert-True -Condition ($publishedReply.published -and $publishedReply.cleanupComplete) -Message 'one admitted candidate is atomically published'
Assert-OrdinalEqual -Actual ([IO.File]::ReadAllText((Join-Path $fixture 'prepared-context.txt'))) -Expected $text -Message 'published block matches the verified rendering'
$verifiedReply = $utf8.GetString([Companion.Runtime.RuntimeContext]::Execute($fixture, $inputPath, $inputHash, 'Verify')) | ConvertFrom-Json -AsHashtable -DateKind String
Assert-True -Condition ($verifiedReply.published -and -not $verifiedReply.cleanupComplete) -Message 'lost-reply verification proves bytes without inventing cleanup evidence'
foreach ($reply in @($previewReply, $publishedReply, $verifiedReply)) {
    $candidate = @($reply.candidates | Where-Object shape -EQ 1)[0]
    Assert-OrdinalEqual -Actual $candidate.redeliverySha256 -Expected ([Convert]::ToHexStringLower([Security.Cryptography.SHA256]::HashData($redelivery.Bytes))) -Message 'preview, publication and verification identify the same redelivery bytes'
    Assert-Equal -Actual ([int]$candidate.redeliveryBytes) -Expected $redelivery.Bytes.Length -Message 'redelivery length is identical across lost-response recovery'
    Assert-Equal -Actual ([int]$candidate.redeliveryChanges) -Expected 1 -Message 'redelivery change count is present before publication'
    $packed = [Convert]::FromBase64String($reply.redeliveryOffsets)
    Assert-Equal -Actual ([long]([BitConverter]::ToUInt32($packed, 0) + $candidate.redeliveryOffsetDelta)) -Expected ([long]$redelivery.Offsets[0]) -Message 'preview plan resolves the exact published flag offset'
}

# Arrange a mixed event prefix and all four recovery shapes using the same admitted payload.
$mixedEvents = [Collections.Generic.List[Companion.Runtime.ContextEventSelection]]::new()
$allTrueEvents = [Collections.Generic.List[Companion.Runtime.ContextEventSelection]]::new()
$mixedReferences = @()
for ($sequence = 1; $sequence -le 4; $sequence++) {
    $eventMetadata = (ConvertTo-Json -InputObject $metadata -Depth 8 -Compress) | ConvertFrom-Json -AsHashtable -DateKind String
    $eventMetadata.sequence = $sequence
    $eventMetadata.eventId = $sequence.ToString('x32')
    $eventMetadata.acceptance.eventId = $eventMetadata.eventId
    $eventBytes = [Companion.Runtime.PayloadCodec]::RewriteEvent($pending, $utf8.GetBytes((ConvertTo-Json -InputObject $eventMetadata -Depth 8 -Compress)), $false)
    $eventHash = [Convert]::ToHexStringLower([Security.Cryptography.SHA256]::HashData($eventBytes))
    $eventRecord = [Companion.Runtime.VerifiedContextRecord]::FromFrozen($eventBytes, $eventHash, ('1' * 32))
    $isRedelivery = $sequence -eq 2
    $mixedEvents.Add([Companion.Runtime.ContextEventSelection]::new($eventRecord, $isRedelivery))
    $allTrueEvents.Add([Companion.Runtime.ContextEventSelection]::new($eventRecord, $true))
    $mixedReferences += @{ sequence = $sequence; sha256 = $eventHash; redelivery = $isRedelivery }
    [IO.File]::WriteAllBytes((Join-Path $fixture ('journal/events/' + $sequence.ToString('D16') + '.json')), $eventBytes)
}
$mixedFull = [Companion.Runtime.ContextCodec]::Render($template, $mixedEvents, $eventRecord, ('1' * 32), $nullString, $false, $false, ('a' * 64), ('b' * 64), 4194304)
$request.events = $mixedReferences
$request.state = @{ sequence = 4; sha256 = $eventHash }
$request.shape = $null
$request.failedBlockBytes = $mixedFull.Bytes.Length
$inputBytes = $utf8.GetBytes((ConvertTo-Json -InputObject $request -Depth 16 -Compress))
[IO.File]::WriteAllBytes($inputPath, $inputBytes)
$inputHash = [Convert]::ToHexStringLower([Security.Cryptography.SHA256]::HashData($inputBytes))

# Act through the native boundary, including the half-size prefix and both degraded shapes.
$mixedReplyBytes = [Companion.Runtime.RuntimeContext]::Execute($fixture, $inputPath, $inputHash, 'Preview')
$mixedReply = $utf8.GetString($mixedReplyBytes) | ConvertFrom-Json -AsHashtable -DateKind String
$packed = [Convert]::FromBase64String($mixedReply.redeliveryOffsets)

# Assert that every transported plan reconstructs the separately rendered all-true shape exactly.
Assert-Equal -Actual $mixedReply.candidates.Count -Expected 4 -Message 'all four candidate shapes have redelivery plans'
Assert-True -Condition ($mixedReplyBytes.Length -le 65536) -Message 'four-candidate control reply remains within the supervisor bound'
foreach ($candidate in $mixedReply.candidates) {
    $primary = [Companion.Runtime.ContextSelection]::Select($candidate.shape, $template, $mixedEvents, $eventRecord, $true, ('1' * 32), ('a' * 64), ('b' * 64), $mixedFull.Bytes.Length)
    $request.shape = $candidate.shape
    $inputBytes = $utf8.GetBytes((ConvertTo-Json -InputObject $request -Depth 16 -Compress))
    [IO.File]::WriteAllBytes($inputPath, $inputBytes)
    $inputHash = [Convert]::ToHexStringLower([Security.Cryptography.SHA256]::HashData($inputBytes))
    [IO.File]::Delete((Join-Path $fixture 'prepared-context.txt'))
    $selectedReply = $utf8.GetString([Companion.Runtime.RuntimeContext]::Execute($fixture, $inputPath, $inputHash, 'Publish')) | ConvertFrom-Json -AsHashtable -DateKind String
    $publishedBytes = [IO.File]::ReadAllBytes((Join-Path $fixture 'prepared-context.txt'))
    Assert-OrdinalEqual -Actual ([Convert]::ToBase64String($publishedBytes)) -Expected ([Convert]::ToBase64String($primary.Bytes)) -Message 'publication preserves the exact primary candidate'
    Assert-OrdinalEqual -Actual $selectedReply.candidates[0].redeliverySha256 -Expected $candidate.redeliverySha256 -Message 'every selected shape is recoverable from its preview plan after a lost publication response'
    $selectedTrue = [Collections.Generic.List[Companion.Runtime.ContextEventSelection]]::new()
    for ($index = 0; $index -lt $primary.EventCount; $index++) { $selectedTrue.Add($allTrueEvents[$index]) }
    $expectedState = if ($primary.StateIncluded) { $eventRecord } else { $null }
    $degraded = if ($null -eq $primary.Degraded) { $nullString } else { $primary.Degraded }
    $expected = [Companion.Runtime.ContextCodec]::Render($template, $selectedTrue, $expectedState, ('1' * 32), $degraded, ($null -ne $primary.Degraded), $false, ('a' * 64), ('b' * 64), 4194304)
    $reconstructed = [IO.MemoryStream]::new()
    try {
        $sourceAt = 0
        for ($index = 0; $index -lt $candidate.redeliveryChanges; $index++) {
            $offset = [BitConverter]::ToUInt32($packed, $index * 4) + $candidate.redeliveryOffsetDelta
            Assert-OrdinalEqual -Actual $utf8.GetString($primary.Bytes, $offset, 5) -Expected 'false' -Message 'each offset indexes the complete original false token'
            $reconstructed.Write($primary.Bytes, $sourceAt, $offset - $sourceAt)
            $reconstructed.Write($utf8.GetBytes('true'))
            $sourceAt = $offset + 5
        }
        $reconstructed.Write($primary.Bytes, $sourceAt, $primary.Bytes.Length - $sourceAt)
        $actual = $reconstructed.ToArray()
        Assert-OrdinalEqual -Actual ([Convert]::ToBase64String($actual)) -Expected ([Convert]::ToBase64String($expected.Bytes)) -Message 'shared prefix and delta reproduce the exact selected all-true candidate'
        Assert-OrdinalEqual -Actual ([Convert]::ToHexStringLower([Security.Cryptography.SHA256]::HashData($actual))) -Expected $candidate.redeliverySha256 -Message 'transported redelivery hash matches exact reconstruction'
        Assert-Equal -Actual $actual.Length -Expected ([int]$candidate.redeliveryBytes) -Message 'transported redelivery length matches exact reconstruction'
        Assert-OrdinalEqual -Actual $primary.Fingerprint -Expected $expected.Fingerprint -Message 'all shapes preserve semantic identity across redelivery'
    }
    finally { $reconstructed.Dispose() }
}

$emptyEvents = [Collections.Generic.List[Companion.Runtime.ContextEventSelection]]::new()
$empty = [Companion.Runtime.ContextCodec]::Render($template, $emptyEvents, $null, ('1' * 32), $nullString, $false, $false, ('a' * 64), ('b' * 64), 4194304)
$emptyRedelivery = [Companion.Runtime.ContextCodec]::Redeliver($empty, ('a' * 64), ('b' * 64))
Assert-True -Condition ($emptyRedelivery.Offsets.Length -eq 0 -and [Convert]::ToBase64String($empty.Bytes) -ceq [Convert]::ToBase64String($emptyRedelivery.Bytes)) -Message 'empty events keep byte-identical redelivery'
$allTrue = [Companion.Runtime.ContextCodec]::Render($template, $allTrueEvents, $eventRecord, ('1' * 32), $nullString, $false, $false, ('a' * 64), ('b' * 64), 4194304)
$allTrueRedelivery = [Companion.Runtime.ContextCodec]::Redeliver($allTrue, ('a' * 64), ('b' * 64))
Assert-Equal -Actual $allTrueRedelivery.Offsets.Length -Expected 0 -Message 'already true direct flags require no replacement'
$emptyPlan = [Companion.Runtime.ContextCodec]::PackRedeliveryOffsets([Companion.Runtime.ContextRedeliveryRendering[]]@($emptyRedelivery, $allTrueRedelivery))
Assert-True -Condition ($emptyPlan.Encoded -ceq '' -and $emptyPlan.Deltas[0] -eq 0 -and $emptyPlan.Deltas[1] -eq 0) -Message 'empty plans have an empty vector and zero delta'

# The offset scanner itself reaches the complete retained-event ceiling in memory.
$maximumJson = '{"events":[' + ((1..8192 | ForEach-Object { '{"redelivery":false,"diff":{"redelivery":false}}' }) -join ',') + '],"state":null}'
$maximumFingerprint = [Companion.Runtime.ContextFingerprint]::Compute($utf8.GetBytes($maximumJson), ('a' * 64), ('b' * 64))
$maximumRendering = [Companion.Runtime.ContextRendering]::new($utf8.GetBytes($opening + $maximumJson + $closing), $maximumFingerprint, 8192, $false, $nullString)
$maximumRedelivery = [Companion.Runtime.ContextCodec]::Redeliver($maximumRendering, ('a' * 64), ('b' * 64))
Assert-Equal -Actual $maximumRedelivery.Offsets.Length -Expected 8192 -Message 'all 8192 direct flags are found without nested payload matches'
Assert-Equal -Actual $maximumRedelivery.Bytes.Length -Expected ($maximumRendering.Bytes.Length - 8192) -Message 'maximum redelivery removes exactly the direct-flag bytes'

# Arrange the maximum offset count without creating thousands of filesystem payload fixtures.
$maximumOffsets = [uint32[]]::new(8192)
for ($index = 0; $index -lt $maximumOffsets.Length; $index++) { $maximumOffsets[$index] = 100 + 20 * $index }
$maximum = [Companion.Runtime.ContextRedeliveryRendering]::new([byte[]]@(), $maximumOffsets)
$shorter = [Companion.Runtime.ContextRedeliveryRendering]::new([byte[]]@(), [uint32[]]@(90, 110))
$sameLength = [Companion.Runtime.ContextRedeliveryRendering]::new([byte[]]@(), [uint32[]]@($maximumOffsets | ForEach-Object { $_ + 10 }))

# Act and assert a deterministic first-longest vector, signed deltas and the complete bound.
$maximumPlan = [Companion.Runtime.ContextCodec]::PackRedeliveryOffsets([Companion.Runtime.ContextRedeliveryRendering[]]@($maximum, $shorter, $sameLength, $emptyRedelivery))
Assert-Equal -Actual $maximumPlan.Encoded.Length -Expected 43692 -Message '8192 offsets use exactly 43692 base64 bytes'
Assert-Equal -Actual ([Convert]::FromBase64String($maximumPlan.Encoded)).Length -Expected 32768 -Message 'every offset has one little-endian uint32 slot'
Assert-True -Condition ($maximumPlan.Deltas[0] -eq 0 -and $maximumPlan.Deltas[1] -eq -10 -and $maximumPlan.Deltas[2] -eq 10 -and $maximumPlan.Deltas[3] -eq 0) -Message 'first-longest vector governs every prefix including empty and shifted plans'
$candidateType = [Companion.Runtime.RuntimeContext].GetNestedType('Candidate', [Reflection.BindingFlags]::NonPublic)
$boundedCandidates = [Array]::CreateInstance($candidateType, 4)
for ($index = 0; $index -lt 4; $index++) {
    $boundedCandidates[$index] = [Activator]::CreateInstance($candidateType, [object[]]@(($index + 1), $mixedFull, $maximum, ('a' * 64), ('b' * 64)))
}
$createReply = [Companion.Runtime.RuntimeContext].GetMethod('CreateReply', ([Reflection.BindingFlags]::NonPublic -bor [Reflection.BindingFlags]::Static))
$maximumReply = $createReply.Invoke($null, [object[]]@(('a' * 64), $boundedCandidates, $maximumPlan, $false, $false))
Assert-True -Condition ($maximumReply.Length -le 65536) -Message 'the actual four-candidate serializer fits the maximum common vector in one control response'
$maximumDocument = $utf8.GetString($maximumReply) | ConvertFrom-Json -AsHashtable -DateKind String
Assert-OrdinalEqual -Actual $maximumDocument.redeliveryOffsets -Expected $maximumPlan.Encoded -Message 'the wire vector preserves complete base64 bytes'
$inconsistent = [Companion.Runtime.ContextRedeliveryRendering]::new([byte[]]@(), [uint32[]]@(90, 111))
Assert-ThrowsType 'DocumentInvalidException' { [Companion.Runtime.ContextCodec]::PackRedeliveryOffsets([Companion.Runtime.ContextRedeliveryRendering[]]@($maximum, $inconsistent)) }
[IO.File]::WriteAllBytes((Join-Path $fixture 'state-safety.json'), $utf8.GetBytes('{}'))
Assert-ThrowsType 'IOException' { [Companion.Runtime.RuntimeContext]::Execute($fixture, $inputPath, $inputHash, 'Preview') }
Write-Output 'PASS: lossless accepted context rendering'
