#Requires -Version 7.5
[CmdletBinding()]
param([ValidateRange(1, 8193)] [int] $EventCount = 8193)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$scriptName = [IO.Path]::GetFileNameWithoutExtension($PSCommandPath)
$repository = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))
$scripts = Join-Path $repository 'runtime/scripts'
$sources = @('NativeFiles.cs', 'JsonDocuments.cs', 'EventDocuments.cs', 'PayloadCodec.cs', 'RuntimeFilePublication.cs', 'RuntimeCodec.cs', 'resource-lifecycle/ResourceInventory.cs')
Add-Type -Path @($sources | ForEach-Object { Join-Path $scripts $_ })
$fixtureParent = [IO.Path]::GetFullPath((Join-Path $repository '.tmp/nightshift/resources-impl/fixtures'))
[IO.Directory]::CreateDirectory($fixtureParent) | Out-Null
$container = [IO.Path]::GetFullPath((Join-Path $fixtureParent ([Guid]::NewGuid().ToString('N'))))
if (-not $container.StartsWith($fixtureParent + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Fixture escaped its private root.' }
$fixture = Join-Path $container 'scope'
[IO.Directory]::CreateDirectory($fixture) | Out-Null
$encoding = [Text.UTF8Encoding]::new($false, $true)
function Assert-Resource([bool] $Condition, [string] $Message) {
    if (-not $Condition) { throw $Message }
}
function Read-Inventory([bool] $MarkerOnly = $false) {
    $bytes = [Companion.Runtime.ResourceInventory]::Read($fixture, $scopeHash, $MarkerOnly, $container)

    return $encoding.GetString($bytes) | ConvertFrom-Json -DateKind String
}
try {
    $scope = $encoding.GetBytes('{"runtimeScopeVersion":1,"game":"test","principal":"test"}')
    [IO.File]::WriteAllBytes((Join-Path $fixture 'scope.json'), $scope)
    $scopeHash = [Convert]::ToHexStringLower([Security.Cryptography.SHA256]::HashData($scope))
    $empty = Read-Inventory
    Assert-Resource ($empty.uncompactedEvents -eq 0 -and $empty.retainedHandoffs -eq 0 -and [long]$empty.freeBytes -gt 0) 'Empty inventory was not admitted.'
    Assert-Resource ($empty.pendingOutbox -eq 0) 'Empty outbox was charged sixteen speculative records.'
    $outbox = Join-Path $container 'state/outbox'
    [IO.Directory]::CreateDirectory($outbox) | Out-Null
    for ($index = 1; $index -le 16; $index++) { [IO.File]::WriteAllText((Join-Path $outbox ('event-' + $index.ToString('D16') + '.json')), '{}', $encoding) }
    Assert-Resource ((Read-Inventory).pendingOutbox -eq 16) 'Existing outbox records were omitted from the transition.'
    for ($index = 1; $index -le 16; $index++) { [IO.File]::Delete((Join-Path $outbox ('event-' + $index.ToString('D16') + '.json'))) }

    $residue = Join-Path $fixture ('runtime.json.' + ('f' * 32) + '.tmp')
    [IO.File]::WriteAllText($residue, '{}', $encoding)
    Assert-Resource (Read-Inventory $true).uncertainWorkspace 'Marker inventory ignored its own residue.'
    [IO.File]::Delete($residue)
    $events = Join-Path $fixture 'journal/events'
    [IO.Directory]::CreateDirectory($events) | Out-Null
    $metadata = [ordered]@{
        eventVersion = 1; journalId = 'journal'; sequence = 1; eventId = ('a' * 32); type = 'state.consumed'; occurredAt = '2026-10-08T00:00:00.0000000Z'
        runtimeInstanceId = ('b' * 32); adapter = 'test'; adapterBindingEpoch = ('c' * 32); principal = 'test'; logicalOutboxId = (('d' * 32) + '-1')
        recordSha256 = [Convert]::ToHexStringLower([Security.Cryptography.SHA256]::HashData($encoding.GetBytes('{}'))); coreRepairOperationId = $null; attemptRef = $null; schemaVersion = 2; adapterVersion = 1
        settlement = 'accepted'; acceptance = @{ journalId = 'journal'; eventId = ('a' * 32); generation = ('f' * 32) }
        acknowledgedAt = '2026-10-08T00:00:00.0000000Z'; compacted = $true; payloadBindingSha256 = ('0' * 64)
    }
    for ($index = 1; $index -le $EventCount; $index++) {
        $metadata.sequence = $index
        $metadata.eventId = $index.ToString('x32')
        $metadata.logicalOutboxId = ('d' * 32) + '-' + $index
        $text = ConvertTo-Json -InputObject $metadata -Depth 10 -Compress
        [IO.File]::WriteAllText((Join-Path $events ($index.ToString('D16') + '.json')), $text, $encoding)
    }
    $started = [Diagnostics.Stopwatch]::StartNew()
    $compact = Read-Inventory
    $started.Stop()
    Assert-Resource ($compact.uncompactedEvents -eq 0 -and $compact.invalidEvents -eq 0) 'Complete compact history was not admitted.'
    $duplicate = Join-Path $outbox 'event-0000000000000001.json'
    [IO.File]::WriteAllText($duplicate, '{}', $encoding)
    Assert-Resource ((Read-Inventory).pendingOutbox -eq 0) 'Exact journaled source was charged as a new append.'
    [IO.File]::WriteAllText($duplicate, '{"changed":true}', $encoding)
    Assert-Resource ((Read-Inventory).pendingOutbox -eq 1) 'Changed outbox bytes inherited duplicate capacity.'
    [IO.File]::Delete($duplicate)

    for ($index = 1; $index -le $EventCount; $index++) {
        [IO.File]::WriteAllText((Join-Path $events ($index.ToString('D16') + '.json')), '{', $encoding)
    }
    $damaged = Read-Inventory
    Assert-Resource ($damaged.uncompactedEvents -eq $EventCount -and $damaged.invalidEvents -eq $EventCount) 'Damaged event inventory was truncated or counted as clean.'
    Assert-Resource (-not (Read-Inventory $true).uncertainWorkspace) 'Marker-only inventory imported event authority.'

    $operations = Join-Path $fixture 'operations'
    [IO.Directory]::CreateDirectory($operations) | Out-Null
    [IO.File]::WriteAllText((Join-Path $operations ('jr-' + ('a' * 32) + '.json')), '{"oops":true}', $encoding)
    Assert-Resource ((Read-Inventory).invalidOperations -eq 1) 'Invalid operation authority was silently ignored.'
    [IO.File]::WriteAllText((Join-Path $fixture 'prepared-context.txt'), 'stale', $encoding)
    Assert-Resource (Read-Inventory).uncertainWorkspace 'Prepared context residue was not charged.'

    $quarantine = Join-Path $fixture 'quarantine'
    [IO.Directory]::CreateDirectory($quarantine) | Out-Null
    $quarantineNames = @(0..256 | ForEach-Object { 'record.' + $_.ToString('D4') + '.' + ('a' * 32) + '.quarantined' })
    foreach ($name in $quarantineNames) {
        $target = Join-Path $quarantine $name
        [IO.File]::WriteAllText($target, 'diagnostic', $encoding)
        [IO.File]::SetLastWriteTimeUtc($target, [DateTime]::new(2026, 1, 1, 0, 0, 0, [DateTimeKind]::Utc))
    }
    $protected = $encoding.GetBytes((ConvertTo-Json -InputObject @('quarantine/' + $quarantineNames[0]) -Compress))
    $trimmed = $encoding.GetString([Companion.Runtime.ResourceInventory]::TrimQuarantine($fixture, $scopeHash, $protected)) | ConvertFrom-Json -DateKind String
    Assert-Resource ($trimmed.removed -eq 1 -and $trimmed.remaining -eq 256) 'Quarantine did not keep the production count.'
    Assert-Resource ([IO.File]::Exists((Join-Path $quarantine $quarantineNames[0])) -and -not [IO.File]::Exists((Join-Path $quarantine $quarantineNames[1]))) 'Quarantine ignored protected manifest evidence or ordinal oldest order.'
    [IO.File]::WriteAllText((Join-Path $quarantine $quarantineNames[1]), 'diagnostic', $encoding)
    $allProtected = $encoding.GetBytes((ConvertTo-Json -InputObject @($quarantineNames | ForEach-Object { 'quarantine/' + $_ }) -Compress))
    $retained = $encoding.GetString([Companion.Runtime.ResourceInventory]::TrimQuarantine($fixture, $scopeHash, $allProtected)) | ConvertFrom-Json -DateKind String
    Assert-Resource ($retained.removed -eq 0 -and $retained.remaining -eq 257) 'Protected quarantine was silently pruned.'

    [IO.File]::WriteAllText((Join-Path $fixture 'scope.json'), '{}', $encoding)
    $refused = $false
    try { Read-Inventory | Out-Null } catch { $refused = $true }
    Assert-Resource $refused 'Changed immutable scope was admitted.'
    Write-Output (ConvertTo-Json -InputObject @{ test = $scriptName; result = 'passed'; compactRecords = $EventCount; compactScanMilliseconds = $started.ElapsedMilliseconds } -Compress)
}
finally {
    $resolved = [IO.Path]::GetFullPath($container)
    if ($resolved.StartsWith($fixtureParent + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        Remove-Item -LiteralPath $resolved -Recurse -Force
    }
}
