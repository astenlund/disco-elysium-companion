[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string] $DumpPath,
    [Parameter(Mandatory)] [string] $SourceDomainId,
    [Parameter(Mandatory)] [string] $SourceName,
    [Parameter(Mandatory)] [string] $SavedAt,
    [Parameter(Mandatory)] [string] $SourceLength,
    [Parameter(Mandatory)] [string] $SourceSha256,
    [Parameter(Mandatory)] [string] $AdapterVersion,
    [Parameter(Mandatory)] [string] $OutPath
)
$ErrorActionPreference = 'Stop'
Import-Module "$PSScriptRoot\..\..\core\DigestDiff.psm1" -Force -DisableNameChecking

function Fail([string] $msg) { [Console]::Error.WriteLine("builddigest: $msg"); exit 1 }

# The mapper's OWN schema constant, deliberately a literal and NOT Get-CoreSchemaVersion:
# the commit-time lockstep check compares mapper-stamped vs core-supported, and deriving
# the stamp from the core module would make that check tautologically unfailable, hiding
# a genuine core-vs-mapper version gap (spec section 6).
$mapperSchemaVersion = 2

# Digest-key -> store-variable map (derived from vendored variables_reputation.json;
# validated below so a typo fails at build time, spec section 6).
$reputationMap = [ordered]@{
    communist = 'reputation.communist'; moralist = 'reputation.moralist'
    ultraliberal = 'reputation.ultraliberal'; nationalist = 'reputation.revacholian_nationhood'
    kim = 'reputation.kim'
}
$copStyleMap = [ordered]@{
    sorry = 'reputation.sorry_cop'; superstar = 'reputation.superstar_cop'
    apocalypse = 'reputation.apocalypse_cop'; boring = 'reputation.boring_cop'
    art = 'reputation.art_cop'
}

function ConvertTo-Clock([int] $dayMinutes) { if ($dayMinutes -lt 0 -or $dayMinutes -gt 1439) { Fail 'dayMinutes is outside the clock range' }; '{0:D2}:{1:D2}' -f [int][math]::Floor($dayMinutes / 60), ($dayMinutes % 60) }

function ConvertTo-Title([string] $id) { ($id -replace '^TASK\.', '') -replace '_', ' ' }

function ConvertTo-CanonicalInt64([string] $Value, [string] $Name, [bool] $Positive) {
    $pattern = if ($Positive) { '^[1-9][0-9]*$' } else { '^(0|-?[1-9][0-9]*)$' }
    $parsed = 0L
    if ($Value -notmatch $pattern -or -not [long]::TryParse($Value, [Globalization.NumberStyles]::None, [Globalization.CultureInfo]::InvariantCulture, [ref] $parsed)) { Fail "invalid $Name" }

    return $parsed
}

if ($SourceDomainId -notmatch '^[0-9a-f]{64}$' -or $SourceSha256 -notmatch '^[0-9a-f]{64}$') { Fail 'source hash is not lowercase SHA-256 hex' }
if ([IO.Path]::GetFileName($SourceName) -cne $SourceName -or [string]::IsNullOrEmpty($SourceName)) { Fail 'source name is not a file name' }
$sourceLengthValue = ConvertTo-CanonicalInt64 $SourceLength 'SourceLength' $true
$adapterVersionValue = ConvertTo-CanonicalInt64 $AdapterVersion 'AdapterVersion' $false
$savedAtValue = [datetime]::MinValue
if (-not [datetime]::TryParse($SavedAt, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind, [ref] $savedAtValue) -or $savedAtValue.Kind -ne [DateTimeKind]::Utc -or -not [string]::Equals($savedAtValue.ToString('o', [Globalization.CultureInfo]::InvariantCulture), $SavedAt, [StringComparison]::Ordinal)) { Fail 'SavedAt is not canonical UTC round-trip format' }

function Read-DiscoDumpDocument {
    param([Parameter(Mandatory)] [object] $Document)

    function Test-OrdinalFieldSet([string[]] $Actual, [string[]] $Expected) {
        if ($Actual.Count -ne $Expected.Count) { return $false }
        foreach ($actualName in $Actual) {
            $matched = $false
            foreach ($expectedName in $Expected) {
                if ([string]::Equals($actualName, $expectedName, [StringComparison]::Ordinal)) { $matched = $true; break }
            }
            if (-not $matched) { return $false }
        }

        return $true
    }

    $root = $Document.RootElement
    if ($root.ValueKind -ne [Text.Json.JsonValueKind]::Object) { Fail 'dump root is not an object' }
    $names = @($root.EnumerateObject() | ForEach-Object Name)
    if (-not (Test-OrdinalFieldSet $names @('source', 'header', 'world', 'states', 'tlv'))) { Fail 'dump root has an invalid field set' }
    foreach ($name in 'source', 'header', 'world', 'states', 'tlv') {
        $value = [Text.Json.JsonElement]::new()
        if (-not $root.TryGetProperty($name, [ref] $value) -or $value.ValueKind -ne [Text.Json.JsonValueKind]::Object) { Fail "dump.$name is not an object" }
    }
    $source = $root.GetProperty('source')
    $sourceNames = @($source.EnumerateObject() | ForEach-Object Name)
    if (-not (Test-OrdinalFieldSet $sourceNames @('zipName', 'byteLength', 'contentSha256', 'entries')) -or $source.GetProperty('zipName').ValueKind -ne [Text.Json.JsonValueKind]::String -or $source.GetProperty('contentSha256').ValueKind -ne [Text.Json.JsonValueKind]::String -or $source.GetProperty('contentSha256').GetString() -notmatch '^[0-9a-f]{64}$' -or $source.GetProperty('entries').ValueKind -ne [Text.Json.JsonValueKind]::Array) { Fail 'dump source has an invalid field set' }
    $length = 0L
    if ($source.GetProperty('byteLength').ValueKind -ne [Text.Json.JsonValueKind]::Number -or -not $source.GetProperty('byteLength').TryGetInt64([ref] $length) -or $length -le 0) { Fail 'dump source byte length is invalid' }
    $tlv = $root.GetProperty('tlv')
    $tlvNames = @($tlv.EnumerateObject() | ForEach-Object Name)
    if ($tlvNames.Count -ne 1 -or -not [string]::Equals($tlvNames[0], 'variables', [StringComparison]::Ordinal) -or $tlv.GetProperty('variables').ValueKind -ne [Text.Json.JsonValueKind]::Object) { Fail 'dump is not variables-only' }
    $variables = $tlv.GetProperty('variables')
    $books = [Text.Json.JsonElement]::new()
    if (-not $variables.TryGetProperty('character.books_read_counter', [ref] $books)) { Fail 'dump variable-store signature is missing books counter' }
    $booksValue = 0L
    if ($books.ValueKind -ne [Text.Json.JsonValueKind]::Number -or -not $books.TryGetInt64([ref] $booksValue)) { Fail 'dump variable-store books counter is not an integer' }
    $taskCount = 0
    foreach ($property in $variables.EnumerateObject()) {
        if ($property.Name.StartsWith('TASK.', [StringComparison]::Ordinal)) {
            if ($property.Value.ValueKind -ne [Text.Json.JsonValueKind]::True -and $property.Value.ValueKind -ne [Text.Json.JsonValueKind]::False) { Fail 'dump variable-store task signature is invalid' }
            $taskCount++
        }
    }
    if ($taskCount -ne 1131) { Fail 'dump variable-store task signature count is invalid' }

    $world = $root.GetProperty('world')
    $journal = [Text.Json.JsonElement]::new()
    if (-not $world.TryGetProperty('aquiredJournalTasks', [ref] $journal) -or $journal.ValueKind -ne [Text.Json.JsonValueKind]::Object) { Fail 'dump journal is missing' }
    $acquisitions = [Text.Json.JsonElement]::new()
    $resolutions = [Text.Json.JsonElement]::new()
    $subtasks = [Text.Json.JsonElement]::new()
    if (-not $journal.TryGetProperty('TaskAquisitions', [ref] $acquisitions) -or -not $journal.TryGetProperty('TaskResolutions', [ref] $resolutions) -or -not $journal.TryGetProperty('SubtaskAquisitions', [ref] $subtasks) -or $acquisitions.ValueKind -ne [Text.Json.JsonValueKind]::Object -or $resolutions.ValueKind -ne [Text.Json.JsonValueKind]::Object -or $subtasks.ValueKind -ne [Text.Json.JsonValueKind]::Object) { Fail 'dump journal has invalid containers' }
    $acquiredIds = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($property in $acquisitions.EnumerateObject()) {
        if ($property.Name -notmatch '^TASK\..+$' -or -not $acquiredIds.Add($property.Name) -or $property.Value.ValueKind -ne [Text.Json.JsonValueKind]::Object) { Fail 'dump journal acquisitions are invalid' }
    }
    $resolvedIds = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($property in $resolutions.EnumerateObject()) {
        if ($property.Name -notmatch '^TASK\..+$' -or -not $resolvedIds.Add($property.Name) -or ($property.Value.ValueKind -ne [Text.Json.JsonValueKind]::Object -and $property.Value.ValueKind -ne [Text.Json.JsonValueKind]::Null)) { Fail 'dump journal resolutions are invalid' }
    }
    if (-not $acquiredIds.SetEquals($resolvedIds)) { Fail 'dump journal acquisition and resolution keys differ' }
    foreach ($parent in $subtasks.EnumerateObject()) {
        if (-not $acquiredIds.Contains($parent.Name) -or $parent.Value.ValueKind -ne [Text.Json.JsonValueKind]::Object) { Fail 'dump journal subtask parent is invalid' }
        foreach ($child in $parent.Value.EnumerateObject()) {
            if ($child.Name -notmatch '^TASK\..+$' -or $child.Value.ValueKind -ne [Text.Json.JsonValueKind]::Object) { Fail 'dump journal subtask is invalid' }
        }
    }
    $sheet = [Text.Json.JsonElement]::new()
    if (-not $world.TryGetProperty('characterSheet', [ref] $sheet) -or $sheet.ValueKind -ne [Text.Json.JsonValueKind]::Object) { Fail 'dump character sheet is missing' }
    foreach ($arrayName in 'gainedItems', 'equippedItems', 'gainedThoughts', 'cookingThoughts', 'fixedThoughts', 'forgottenThoughts') {
        $array = [Text.Json.JsonElement]::new()
        if (-not $sheet.TryGetProperty($arrayName, [ref] $array) -or $array.ValueKind -ne [Text.Json.JsonValueKind]::Array) { Fail "dump character-sheet array is invalid: $arrayName" }
        $values = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
        foreach ($item in $array.EnumerateArray()) {
            if ($item.ValueKind -ne [Text.Json.JsonValueKind]::String -or [string]::IsNullOrEmpty($item.GetString()) -or -not $values.Add($item.GetString())) { Fail "dump character-sheet array has invalid values: $arrayName" }
        }
    }
    $gainedItems = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($item in $sheet.GetProperty('gainedItems').EnumerateArray()) { [void] $gainedItems.Add($item.GetString()) }
    foreach ($item in $sheet.GetProperty('equippedItems').EnumerateArray()) { if (-not $gainedItems.Contains($item.GetString())) { Fail 'equipped item is not owned' } }
    $gainedThoughts = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($item in $sheet.GetProperty('gainedThoughts').EnumerateArray()) { [void] $gainedThoughts.Add($item.GetString()) }
    $cookingThoughts = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($item in $sheet.GetProperty('cookingThoughts').EnumerateArray()) { if (-not $gainedThoughts.Contains($item.GetString()) -or -not $cookingThoughts.Add($item.GetString())) { Fail 'cooking thought lifecycle is invalid' } }
    foreach ($item in $sheet.GetProperty('fixedThoughts').EnumerateArray()) { if (-not $gainedThoughts.Contains($item.GetString()) -or $cookingThoughts.Contains($item.GetString())) { Fail 'fixed thought lifecycle is invalid' } }
    foreach ($item in $sheet.GetProperty('forgottenThoughts').EnumerateArray()) { if ($gainedThoughts.Contains($item.GetString())) { Fail 'forgotten thought lifecycle is invalid' } }
    $inventoryState = [Text.Json.JsonElement]::new()
    $items = [Text.Json.JsonElement]::new()
    if (-not $world.TryGetProperty('inventoryState', [ref] $inventoryState) -or $inventoryState.ValueKind -ne [Text.Json.JsonValueKind]::Object -or -not $inventoryState.TryGetProperty('itemListState', [ref] $items) -or $items.ValueKind -ne [Text.Json.JsonValueKind]::Array) { Fail 'dump item catalog is missing' }
    $catalogNames = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($item in $items.EnumerateArray()) {
        $itemName = [Text.Json.JsonElement]::new()
        if ($item.ValueKind -ne [Text.Json.JsonValueKind]::Object -or -not $item.TryGetProperty('itemName', [ref] $itemName) -or $itemName.ValueKind -ne [Text.Json.JsonValueKind]::String -or [string]::IsNullOrEmpty($itemName.GetString()) -or -not $catalogNames.Add($itemName.GetString())) { Fail 'dump item catalog has invalid item names' }
        $isFresh = [Text.Json.JsonElement]::new()
        if ($item.TryGetProperty('isFresh', [ref] $isFresh) -and $isFresh.ValueKind -ne [Text.Json.JsonValueKind]::True -and $isFresh.ValueKind -ne [Text.Json.JsonValueKind]::False) { Fail 'dump item catalog freshness has wrong kind' }
    }
    foreach ($storeName in @($reputationMap.Values) + @($copStyleMap.Values)) {
        $value = [Text.Json.JsonElement]::new()
        if ($variables.TryGetProperty($storeName, [ref] $value)) {
            $integer = 0L
            if ($value.ValueKind -ne [Text.Json.JsonValueKind]::Number -or -not $value.TryGetInt64([ref] $integer)) { Fail "reputation source has wrong kind: $storeName" }
        }
    }
    $checks = [Text.Json.JsonElement]::new()
    $seen = [Text.Json.JsonElement]::new()
    if (-not $world.TryGetProperty('failedWhiteChecksHolder', [ref] $checks) -or $checks.ValueKind -ne [Text.Json.JsonValueKind]::Object -or -not $checks.TryGetProperty('SeenWhiteCheckCache', [ref] $seen) -or $seen.ValueKind -ne [Text.Json.JsonValueKind]::Object) { Fail 'dump seen white-check cache is missing' }
    foreach ($entry in $seen.EnumerateObject()) {
        if ($entry.Value.ValueKind -ne [Text.Json.JsonValueKind]::Object) { Fail 'dump seen white-check entry has wrong kind' }
        $onlySeen = [Text.Json.JsonElement]::new()
        if ($entry.Value.TryGetProperty('isOnlySeen', [ref] $onlySeen) -and $onlySeen.ValueKind -ne [Text.Json.JsonValueKind]::True -and $onlySeen.ValueKind -ne [Text.Json.JsonValueKind]::False) { Fail 'dump seen white-check Boolean has wrong kind' }
    }

    return $Document
}

try { $dump = Read-DiscoDumpDocument -Document (Read-CompanionJson -Path $DumpPath -Budget dump) } catch { Fail 'dump JSON is missing or invalid' }
$sibling = $null
try {
    $repDb = Read-CompanionJson -Path "$PSScriptRoot\game_data\variables_reputation.json" -Budget config
    $skillMap = Read-CompanionJson -Path "$PSScriptRoot\game_data\skill_key_map.json" -Budget config
} catch { Fail 'vendored DB missing or unparseable' }
$dump = $dump.Materialized
$repDb = $repDb.Materialized
$skillMap = $skillMap.Materialized
if ($null -eq $dump.source -or $dump.source.byteLength -ne $sourceLengthValue -or -not [string]::Equals($dump.source.contentSha256, $SourceSha256, [StringComparison]::Ordinal)) { Fail 'dump source receipt does not match mapper receipt' }

$world = $dump.world; $header = $dump.header
foreach ($req in @(
    @{ name = 'world.sunshineClockTimeHolder.time'; value = $world.sunshineClockTimeHolder.time },
    @{ name = 'world.playerCharacter'; value = $world.playerCharacter },
    @{ name = 'world.characterSheet'; value = $world.characterSheet },
    @{ name = 'world.aquiredJournalTasks'; value = $world.aquiredJournalTasks },
    @{ name = 'world.inventoryState.itemListState'; value = $world.inventoryState.itemListState },
    @{ name = 'header.areaId'; value = $header.areaId },
    @{ name = 'header.partyState'; value = $header.partyState },
    @{ name = 'world.failedWhiteChecksHolder'; value = $world.failedWhiteChecksHolder },
    @{ name = 'tlv.variables'; value = $dump.tlv.variables }
)) {
    if ($null -eq $req.value) { Fail "required source container absent: $($req.name)" }
}
foreach ($cache in @('WhiteCheckCache', 'SeenWhiteCheckCache')) {
    if ($null -eq $world.failedWhiteChecksHolder[$cache]) { Fail "required source container absent: world.failedWhiteChecksHolder.$cache" }
}
foreach ($journalMap in @('TaskAquisitions', 'TaskResolutions', 'SubtaskAquisitions')) {
    if ($null -eq $world.aquiredJournalTasks[$journalMap]) { Fail "required source container absent: world.aquiredJournalTasks.$journalMap" }
}

# Default fail-closed rule for mapped sub-fields (spec section 6): absence of a mapped
# scalar is an error unless the mapping row states an explicit absent-value rule.
function Get-RequiredField($container, [string] $name, [string] $path) {
    if ($container -isnot [hashtable] -or -not $container.ContainsKey($name) -or $null -eq $container[$name]) {
        Fail "required source field absent: $path"
    }
    $container[$name]
}

function Get-RequiredBoolean($container, [string] $name, [string] $path) {
    $value = Get-RequiredField $container $name $path
    if ($value -isnot [bool]) { Fail "required source Boolean has wrong kind: $path" }

    return $value
}

function Get-RequiredInt64($container, [string] $name, [string] $path, [bool] $Nonnegative = $false) {
    $value = Get-RequiredField $container $name $path
    if ($value -isnot [long] -and $value -isnot [int]) { Fail "required source integer has wrong kind: $path" }
    $integer = [long]$value
    if ($Nonnegative -and $integer -lt 0) { Fail "required source integer is negative: $path" }

    return $integer
}

$endurance = Get-RequiredField $world.characterSheet 'endurance' 'world.characterSheet.endurance'
$volition = Get-RequiredField $world.characterSheet 'volition' 'world.characterSheet.volition'
$enduranceValue = Get-RequiredInt64 $endurance 'value' 'characterSheet.endurance.value'
$volitionValue = Get-RequiredInt64 $volition 'value' 'characterSheet.volition.value'

function ConvertTo-Stamp($record, [string] $recordPath) {
    # Journal timestamp record -> @{day; time}; realDayCounter/seconds ignored (spec 6.2).
    # dayCounter/dayMinutes are mapped sub-fields, so absence is fail-closed (spec section
    # 6's closed exception list does not cover them); the null-resolution and
    # absent-dayCounter-means-unresolved checks happen BEFORE any call reaches here.
    @{
        day = Get-RequiredInt64 $record 'dayCounter' "$recordPath.dayCounter"
        time = ConvertTo-Clock ([int](Get-RequiredInt64 $record 'dayMinutes' "$recordPath.dayMinutes"))
    }
}

# Reputation map validation: every mapped store name must exist in the vendored DB.
$dbNames = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
$initials = [Collections.Generic.Dictionary[string, long]]::new([StringComparer]::Ordinal)
foreach ($row in $repDb) {
    if ($row -isnot [hashtable] -or $row.name -isnot [string] -or [string]::IsNullOrEmpty($row.name) -or -not $dbNames.Add($row.name)) { Fail 'vendored reputation DB has invalid names' }
    $initial = 0L
    if ($row.initial_value -is [int] -or $row.initial_value -is [long]) { $initial = [long]$row.initial_value }
    elseif ($row.initial_value -is [double] -and [double]::IsFinite($row.initial_value) -and [math]::Truncate($row.initial_value) -eq $row.initial_value -and $row.initial_value -ge [long]::MinValue -and $row.initial_value -le [long]::MaxValue) { $initial = [long]$row.initial_value }
    elseif ($row.initial_value -is [decimal] -and [decimal]::Truncate($row.initial_value) -eq $row.initial_value -and $row.initial_value -ge [long]::MinValue -and $row.initial_value -le [long]::MaxValue) { $initial = [long]$row.initial_value }
    else { continue }
    $initials.Add($row.name, $initial)
}
foreach ($storeName in @($reputationMap.Values) + @($copStyleMap.Values)) {
    if (-not $dbNames.Contains($storeName) -or -not $initials.ContainsKey($storeName)) { Fail "reputation mapping names unknown store variable: $storeName" }
}

function Get-ReputationValue([string] $storeName) {
    $store = $dump.tlv.variables
    if ($store.ContainsKey($storeName)) {
        if ($store[$storeName] -isnot [int] -and $store[$storeName] -isnot [long]) { Fail "reputation source has wrong kind: $storeName" }

        return [long]$store[$storeName]
    }

    return $initials[$storeName]
}

# Skills: direct children of characterSheet carrying skillType (spec section 6 discriminator).
$skills = @()
function Find-UniqueVendorEntry([object[]] $Entries, [string] $Type, [string] $Description) {
    $matches = @($Entries | Where-Object { [string]::Equals($_.skill_type, $Type, [StringComparison]::Ordinal) })
    if ($matches.Count -ne 1) { Fail "$Description has no unique vendor entry: $Type" }

    return $matches[0]
}
foreach ($key in $world.characterSheet.Keys) {
    $obj = $world.characterSheet[$key]
    if ($obj -isnot [hashtable] -or -not $obj.ContainsKey('skillType')) { continue }
    if ($obj.skillType -isnot [string] -or $obj.abilityType -isnot [string]) { Fail 'skill source type has wrong kind' }
    $entry = Find-UniqueVendorEntry $skillMap.skills $obj.skillType 'skill key'
    $ability = Find-UniqueVendorEntry $skillMap.abilities $obj.abilityType 'ability type'
    $skills += @{
        name = $entry.display_name
        value = Get-RequiredInt64 $obj 'value' "characterSheet.$($obj.skillType).value"
        group = $ability.display_name
    }
}

# Objectives from the journal (spec 6.2).
$tasks = $world.aquiredJournalTasks
$objectives = @()
foreach ($id in $tasks.TaskAquisitions.Keys) {
    $resolution = $tasks.TaskResolutions[$id]
    $resolved = $null
    $status = 'active'
    if ($resolution -is [hashtable] -and $null -ne $resolution.dayCounter) {
        $status = 'done'; $resolved = ConvertTo-Stamp $resolution "TaskResolutions.$id"
    }
    $subs = @()
    $subMap = $tasks.SubtaskAquisitions[$id]
    if ($subMap -is [hashtable]) {
        foreach ($subId in $subMap.Keys) {
            $subs += @{
                id = $subId; title = ConvertTo-Title $subId
                status = ($status -eq 'done' ? 'done' : 'active')
                acquired = ConvertTo-Stamp $subMap[$subId] "SubtaskAquisitions.$id.$subId"
                resolved = $null; subobjectives = $null
            }
        }
    }
    $objectives += @{
        id = $id; title = ConvertTo-Title $id; status = $status
        acquired = ConvertTo-Stamp $tasks.TaskAquisitions[$id] "TaskAquisitions.$id"; resolved = $resolved
        subobjectives = $subs
    }
}

# Inventory (owned/equipped/highlights, spec 6.2 ownership rules). The ownership
# arrays are mapped sub-fields, so their ABSENCE is fail-closed (an empty array is
# legitimate and passes; Get-RequiredField rejects only a missing or null container).
$owned = @(Get-RequiredField $world.characterSheet 'gainedItems' 'characterSheet.gainedItems')
# The catalog map is ORDINAL (spec 6.2): the highlight predicate compares an owned id
# against the exact catalog name, and a default hashtable's case-insensitive lookup
# would let a case-differing owned id mis-match the catalog.
$freshCatalog = [hashtable]::new([StringComparer]::Ordinal)
foreach ($item in $world.inventoryState.itemListState) {
    if ($item -is [hashtable] -and $item.ContainsKey('itemName') -and $item.ContainsKey('isFresh')) {
        $freshCatalog[$item.itemName] = [bool]$item.isFresh
    }
}
$highlights = @($owned | ? { $freshCatalog.ContainsKey($_) -and $freshCatalog[$_] })

function ConvertTo-OrdinalSorted([string[]] $Values) {
    $sorted = [Collections.Generic.List[string]]::new()
    $sorted.AddRange($Values)
    $sorted.Sort([StringComparer]::Ordinal)

    # Return the array as one object (comma operand) so an empty result stays an
    # empty array rather than unrolling to $null, which would serialize as null.
    return ,$sorted.ToArray()
}

# Thoughts from the characterSheet owned arrays only (spec 6.3); same fail-closed
# absence rule as the item arrays. All four emitted arrays are ordinal-sorted
# (spec 6.3) because the validator requires each strictly ascending and globally
# unique, while real dumps carry these arrays in raw, non-pre-sorted source order.
$cooking = ConvertTo-OrdinalSorted @(Get-RequiredField $world.characterSheet 'cookingThoughts' 'characterSheet.cookingThoughts')
$fixed = ConvertTo-OrdinalSorted @(Get-RequiredField $world.characterSheet 'fixedThoughts' 'characterSheet.fixedThoughts')
$forgotten = ConvertTo-OrdinalSorted @(Get-RequiredField $world.characterSheet 'forgottenThoughts' 'characterSheet.forgottenThoughts')
# known := gainedThoughts minus the other three (spec 6.3). PowerShell's -notin is
# case/culture-insensitive membership, so build one ORDINAL exclusion set and test each
# gained id against it; a case-differing variant must survive the subtraction.
$excludedThoughtIds = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
foreach ($thoughtId in $cooking + $fixed + $forgotten) { [void] $excludedThoughtIds.Add($thoughtId) }
$known = ConvertTo-OrdinalSorted @(Get-RequiredField $world.characterSheet 'gainedThoughts' 'characterSheet.gainedThoughts' | ? { -not $excludedThoughtIds.Contains($_) })

$store = $dump.tlv.variables
function Get-DayPhase([string] $name) {
    if ($store.ContainsKey($name)) {
        if ($store[$name] -isnot [bool]) { Fail "day-phase source has wrong kind: $name" }

        return $store[$name]
    }
    return $false   # literal historical initial value (spec 6.3); NOT a DB lookup
}

$time = $world.sunshineClockTimeHolder.time
$pc = $world.playerCharacter
$money = Get-RequiredInt64 $pc 'Money' 'world.playerCharacter.Money'
# Checked Decimal amount derivation (spec 6.1): plain `/` division would emit an
# Int64 for divisible balances and a Double otherwise, giving inconsistent JSON
# number types and float rounding for large balances. The core digest validator
# re-derives amount as [decimal]minorUnits/[decimal]minorUnitsPerUnit, so only a
# Decimal keeps every balance publication-consistent.
$moneyAmount = [decimal]$money / [decimal]100
$digest = [ordered]@{
    schemaVersion = $mapperSchemaVersion
    adapterVersion = $adapterVersionValue
    game = 'disco_elysium'
    generatedAt = [DateTime]::UtcNow.ToString('o')
    source = @{ domainId = $SourceDomainId; saveFile = $SourceName; savedAt = $SavedAt; byteLength = $sourceLengthValue; contentSha256 = $SourceSha256 }
    session = @{
        day = Get-RequiredInt64 $time 'dayCounter' 'sunshineClockTimeHolder.time.dayCounter'
        time = ConvertTo-Clock ([int](Get-RequiredInt64 $time 'dayMinutes' 'sunshineClockTimeHolder.time.dayMinutes'))
        location = $header.areaId; playtimeNote = $null
    }
    character = @{
        level = Get-RequiredInt64 $pc 'Level' 'world.playerCharacter.Level' $true
        xp = Get-RequiredInt64 $pc 'XpAmount' 'world.playerCharacter.XpAmount' $true
        unspentPoints = Get-RequiredInt64 $pc 'SkillPoints' 'world.playerCharacter.SkillPoints' $true
        money = @{ amount = $moneyAmount; minorUnits = $money; minorUnitsPerUnit = 100; currency = 'real' }
        vitals = @(
            @{ name = 'health'; value = $enduranceValue },
            @{ name = 'morale'; value = $volitionValue }
        )
        skills = $skills
    }
    objectives = $objectives
    inventory = @{
        owned = $owned
        equipped = @(Get-RequiredField $world.characterSheet 'equippedItems' 'characterSheet.equippedItems')
        highlights = $highlights
    }
    extra = [ordered]@{
        party = @{
            kimInParty = Get-RequiredBoolean $header.partyState 'isKimInParty' 'partyState.isKimInParty'
            cunoInParty = Get-RequiredBoolean $header.partyState 'isCunoInParty' 'partyState.isCunoInParty'
        }
        reputation = [ordered]@{
            communist = Get-ReputationValue $reputationMap.communist
            moralist = Get-ReputationValue $reputationMap.moralist
            ultraliberal = Get-ReputationValue $reputationMap.ultraliberal
            nationalist = Get-ReputationValue $reputationMap.nationalist
            kim = Get-ReputationValue $reputationMap.kim
            copStyle = [ordered]@{
                sorry = Get-ReputationValue $copStyleMap.sorry
                superstar = Get-ReputationValue $copStyleMap.superstar
                apocalypse = Get-ReputationValue $copStyleMap.apocalypse
                boring = Get-ReputationValue $copStyleMap.boring
                art = Get-ReputationValue $copStyleMap.art
            }
        }
        thoughts = @{ cooking = $cooking; fixed = $fixed; forgotten = $forgotten; known = $known }
        whiteChecks = @{
            retryable = @($world.failedWhiteChecksHolder.WhiteCheckCache.Keys).Count
            seenOnly = @($world.failedWhiteChecksHolder.SeenWhiteCheckCache.Values | ? { $_ -is [hashtable] -and $_['isOnlySeen'] -eq $true }).Count
        }
        dayPhase = @{ hasSlept = Get-DayPhase 'auto.daychange_has_slept'; canSleep = Get-DayPhase 'auto.daychange_can_sleep' }
    }
}

try {
    if ([IO.File]::Exists($OutPath)) { Fail 'digest destination already exists' }
    $json = ConvertTo-CompanionJson -InputObject $digest -Budget digest
    $validated = Read-DigestDocument -Json $json
    Import-Module "$PSScriptRoot\Validate-Digest.psm1" -Force -DisableNameChecking
    Assert-AdapterDigestSemantics -Document $validated
    $nonce = [guid]::NewGuid().ToString('N')
    $sibling = "$OutPath.$nonce.tmp"
    $stream = [IO.FileStream]::new($sibling, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try {
        $bytes = [Text.UTF8Encoding]::new($false, $true).GetBytes($json)
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Flush($true)
    }
    finally {
        $stream.Dispose()
    }
    [IO.File]::Move($sibling, $OutPath, $false)
} catch {
    if ($null -ne $sibling -and [IO.File]::Exists($sibling)) {
        Remove-Item -LiteralPath $sibling -Force -ErrorAction SilentlyContinue
    }

    Fail 'digest validation or publication failed'
}
exit 0
