#Requires -Version 7.5

[CmdletBinding()]
param(
    [Parameter()]
    [ValidateSet('All', 'MapperSemanticOutput', 'MapperPublication', 'MapperCharacterClosure', 'MapperSkillCompleteness', 'MapperThoughtOrdering', 'MapperOrdinalCaseSensitivity', 'MapperMoneyDecimal', 'MapperReputationSemantics', 'MapperReputationDataSafety')]
    [string] $Only = 'All'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
Import-Module (Join-Path $root 'core/DigestDiff.psm1') -Force
$mapper = Join-Path $PSScriptRoot 'Build-Digest.ps1'
$script:SkillKeyMap = Get-Content -Raw (Join-Path $PSScriptRoot 'game_data/skill_key_map.json') | ConvertFrom-Json -AsHashtable
$scratch = Join-Path $root ('.tmp/build-digest-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $scratch | Out-Null

function Assert([bool] $Condition, [string] $Message) {
    if (-not $Condition) {
        throw "Assertion failed: $Message"
    }

    Write-Host "ok: $Message"
}

function Test-MapperReputationDataSafety {
    $rows = Get-Content -Raw (Join-Path $PSScriptRoot 'game_data/variables_reputation.json') | ConvertFrom-Json -AsHashtable
    Assert (@($rows | Where-Object { $_.Contains('description') }).Count -eq 0) 'vendored reputation rows exclude spoiler-unsafe designer descriptions'
}

function New-Variables {
    $variables = @{'character.books_read_counter' = 0 }
    for ($index = 1; $index -le 1131; $index++) {
        $variables[('TASK.fixture_{0}' -f $index)] = $false
    }

    return $variables
}

function New-ValidDump {
    $sheet = [ordered]@{ gainedItems = @(); equippedItems = @(); gainedThoughts = @(); cookingThoughts = @(); fixedThoughts = @(); forgottenThoughts = @() }
    foreach ($skill in $script:SkillKeyMap.skills) {
        $sheet[$skill.save_key] = @{ skillType = $skill.skill_type; abilityType = $skill.ability; value = 1 }
    }

    return [ordered]@{
        source = @{ zipName = 'fixture.zip'; byteLength = 1; contentSha256 = ('b' * 64); entries = @('fixture') }
        header = @{ areaId = 'test-area'; partyState = @{ isKimInParty = $false; isCunoInParty = $false } }
        world = @{ sunshineClockTimeHolder = @{ time = @{ dayCounter = 1; dayMinutes = 480 } }; playerCharacter = @{ Money = 0; Level = 0; XpAmount = 0; SkillPoints = 0 }; characterSheet = $sheet; aquiredJournalTasks = @{ TaskAquisitions = @{}; TaskResolutions = @{}; SubtaskAquisitions = @{} }; inventoryState = @{ itemListState = @() }; failedWhiteChecksHolder = @{ WhiteCheckCache = @{}; SeenWhiteCheckCache = @{} } }
        states = @{ areaStates = @{}; shownOrbs = @{} }
        tlv = @{ variables = New-Variables }
    }
}

function Invoke-Mapper([hashtable] $Dump) {
    $id = [guid]::NewGuid().ToString('N')
    $dumpPath = Join-Path $scratch "$id.dump.json"
    $outPath = Join-Path $scratch "$id.digest.json"
    [IO.File]::WriteAllText($dumpPath, ($Dump | ConvertTo-Json -Depth 64 -Compress), [Text.UTF8Encoding]::new($false))
    $psi = [Diagnostics.ProcessStartInfo]::new()
    $psi.FileName = 'pwsh'
    $psi.UseShellExecute = $false
    $psi.RedirectStandardError = $true
    $psi.RedirectStandardOutput = $true
    foreach ($argument in @('-NoProfile', '-File', $mapper, '-DumpPath', $dumpPath, '-SourceDomainId', ('a' * 64), '-SourceName', 'fixture.ntwtf.zip', '-SavedAt', '2026-08-10T00:00:00.0000000Z', '-SourceLength', '1', '-SourceSha256', ('b' * 64), '-AdapterVersion', '2', '-OutPath', $outPath)) { $psi.ArgumentList.Add($argument) }
    $process = [Diagnostics.Process]::Start($psi)
    $stdout = $process.StandardOutput.ReadToEndAsync()
    $stderr = $process.StandardError.ReadToEndAsync()
    $process.WaitForExit()
    return @{ ExitCode = $process.ExitCode; StdOut = $stdout.GetAwaiter().GetResult(); StdErr = $stderr.GetAwaiter().GetResult(); OutPath = $outPath }
}

function Assert-MapperFailedWithoutPublication {
    param(
        [Parameter(Mandatory)] [hashtable] $Dump,
        [Parameter(Mandatory)] [string] $Message
    )

    $run = Invoke-Mapper $Dump
    Assert ($run.ExitCode -eq 1 -and -not [IO.File]::Exists($run.OutPath)) $Message
}

function Test-MapperSemanticOutput {
    $valid = Invoke-Mapper (New-ValidDump)
    Assert ($valid.ExitCode -eq 0) 'valid variables-only fixture exits successfully'
    Assert ([IO.File]::Exists($valid.OutPath)) 'valid fixture publishes exactly one digest'
    Assert ($valid.StdOut.Length -eq 0) 'mapper keeps stdout empty'
    $digestJson = [IO.File]::ReadAllText($valid.OutPath, [Text.UTF8Encoding]::new($false, $true))
    $document = Read-DigestDocument -Json $digestJson
    Assert ($document.RootElement.GetProperty('game').GetString() -ceq 'disco_elysium') 'mapper publishes a core-admitted DE digest'
}

function Test-MapperCharacterClosure {
    # Character numeric closure: level, XP, and unspent points accept 0 and
    # Int64 maximum, and reject -1 before publication.
    foreach ($field in @(@{ name = 'Level'; value = 0L }, @{ name = 'Level'; value = [long]::MaxValue }, @{ name = 'XpAmount'; value = 0L }, @{ name = 'XpAmount'; value = [long]::MaxValue }, @{ name = 'SkillPoints'; value = 0L }, @{ name = 'SkillPoints'; value = [long]::MaxValue })) {
        $fixture = New-ValidDump
        $fixture.world.playerCharacter[$field.name] = $field.value
        $run = Invoke-Mapper $fixture
        Assert ($run.ExitCode -eq 0) "valid character field $($field.name)=$($field.value) publishes a digest"
        Assert ([IO.File]::Exists($run.OutPath)) "valid character field $($field.name)=$($field.value) publishes exactly one digest"
    }

    foreach ($field in @('Level', 'XpAmount', 'SkillPoints')) {
        $negative = New-ValidDump
        $negative.world.playerCharacter[$field] = -1L
        $run = Invoke-Mapper $negative
        Assert ($run.ExitCode -eq 1) "negative character field $field is rejected before publication"
        Assert (-not [IO.File]::Exists($run.OutPath)) "negative character field $field leaves no digest output"

        $stringy = New-ValidDump
        $stringy.world.playerCharacter[$field] = '1'
        $run = Invoke-Mapper $stringy
        Assert ($run.ExitCode -eq 1) "string character field $field is rejected without coercion"
    }
}

function Test-MapperSkillCompleteness {
    $skillMap = $script:SkillKeyMap

    $valid = Invoke-Mapper (New-ValidDump)
    Assert ($valid.ExitCode -eq 0) 'the positive fixture supplies exactly one source object for every vendored skill type'

    foreach ($index in @(0, 1)) {
        $removed = New-ValidDump
        $removed.world.characterSheet.Remove($skillMap.skills[$index].save_key)
        Assert-MapperFailedWithoutPublication -Dump $removed -Message "removed skill type $($skillMap.skills[$index].skill_type) fails before digest publication"
    }

    $duplicated = New-ValidDump
    $duplicated.world.characterSheet['duplicate_extra'] = @{ skillType = $skillMap.skills[0].skill_type; abilityType = $skillMap.skills[0].ability; value = 1 }
    Assert-MapperFailedWithoutPublication -Dump $duplicated -Message 'duplicated skillType under another direct child fails before digest publication'

    $unknown = New-ValidDump
    $unknown.world.characterSheet['unknown_skill'] = @{ skillType = 'UNKNOWN_SKILL_TYPE'; abilityType = 'Logic'; value = 1 }
    Assert-MapperFailedWithoutPublication -Dump $unknown -Message 'an unknown skill type fails before digest publication'
}

function Test-MapperThoughtOrdering {
    # A non-empty, non-sorted real-order thought dump must round-trip through the
    # mapper into four ordinal-ascending, globally-unique emitted arrays (spec 6.3).
    $fixture = New-ValidDump
    $sheet = $fixture.world.characterSheet
    $sheet.gainedThoughts = @('z', 'a', 'c', 'y', 'b')
    $sheet.cookingThoughts = @('c', 'a')
    $sheet.fixedThoughts = @('z')
    $sheet.forgottenThoughts = @('d')
    $run = Invoke-Mapper $fixture
    Assert ($run.ExitCode -eq 0) 'a non-empty, non-sorted thought dump publishes a digest'
    $document = Read-DigestDocument -Json ([IO.File]::ReadAllText($run.OutPath, [Text.UTF8Encoding]::new($false, $true)))
    $thoughts = $document.RootElement.GetProperty('extra').GetProperty('thoughts')
    $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($name in 'cooking', 'fixed', 'forgotten', 'known') {
        $items = @($thoughts.GetProperty($name).EnumerateArray() | ForEach-Object { $_.GetString() })
        Assert ($items.Count -gt 0) "thought array $name is non-empty"
        $previous = $null
        foreach ($id in $items) {
            if ($null -ne $previous -and [string]::CompareOrdinal($previous, $id) -ge 0) {
                throw "thought array $name is not ordinal-ascending: $($items -join ',')"
            }
            if (-not $seen.Add($id)) {
                throw "thought id $id is duplicated across arrays"
            }
            $previous = $id
        }
    }
    $known = @($thoughts.GetProperty('known').EnumerateArray() | ForEach-Object { $_.GetString() })
    Assert ([string]::Join(',', $known) -ceq 'b,y') 'known isolates gained minus cooking/fixed/forgotten in ordinal order'
}

function Test-MapperOrdinalCaseSensitivity {
    # Case-colliding ids exercise the ordinal contract (spec 6.2/6.3): PowerShell's -notin
    # and a default hashtable are case-insensitive, and would subtract a case-differing
    # gained thought or highlight a case-differing owned item against the catalog.
    $fixture = New-ValidDump
    $sheet = $fixture.world.characterSheet
    $sheet.gainedThoughts = @('TASK.Thing', 'TASK.thing')
    $sheet.cookingThoughts = @('TASK.Thing')
    $sheet.fixedThoughts = @()
    $sheet.forgottenThoughts = @()
    $sheet.gainedItems = @('Item', 'item')
    $fixture.world.inventoryState.itemListState = @(@{ itemName = 'Item'; isFresh = $true })
    $run = Invoke-Mapper $fixture
    Assert ($run.ExitCode -eq 0) 'a case-colliding thought and item dump publishes a digest'
    $document = Read-DigestDocument -Json ([IO.File]::ReadAllText($run.OutPath, [Text.UTF8Encoding]::new($false, $true)))
    $thoughts = $document.RootElement.GetProperty('extra').GetProperty('thoughts')
    $cooking = @($thoughts.GetProperty('cooking').EnumerateArray() | ForEach-Object { $_.GetString() })
    Assert ([string]::Join(',', $cooking) -ceq 'TASK.Thing') 'the exact-case cooked member is emitted verbatim'
    $known = @($thoughts.GetProperty('known').EnumerateArray() | ForEach-Object { $_.GetString() })
    Assert ([string]::Join(',', $known) -ceq 'TASK.thing') 'known subtraction is ordinal: a lowercase variant survives an uppercase cooked member'
    $highlights = @($document.RootElement.GetProperty('inventory').GetProperty('highlights').EnumerateArray() | ForEach-Object { $_.GetString() })
    Assert ([string]::Join(',', $highlights) -ceq 'Item') 'inventory highlight lookup is ordinal: a case-differing owned id does not match the catalog'
}

function Test-MapperMoneyDecimal {
    foreach ($case in @(
        @{ name = 'non-divisible balance'; balance = 155L; amount = '1.55' },
        @{ name = 'divisible balance'; balance = 100L; amount = '1' },
        @{ name = 'large balance'; balance = [long]::MaxValue; amount = '92233720368547758.07' }
    )) {
        $fixture = New-ValidDump
        $fixture.world.playerCharacter.Money = $case.balance
        $run = Invoke-Mapper $fixture
        Assert ($run.ExitCode -eq 0) "$($case.name) publishes a digest"
        $document = Read-DigestDocument -Json ([IO.File]::ReadAllText($run.OutPath, [Text.UTF8Encoding]::new($false, $true)))
        $amountText = $document.RootElement.GetProperty('character').GetProperty('money').GetProperty('amount').GetRawText()
        Assert ($amountText -ceq $case.amount) "$($case.name) emits amount $($case.amount)"
    }
}

function Test-MapperReputationSemantics {
    # Claim 11 (Reputation mapping): the complete semantic fixture gives every
    # mapped axis a distinct sentinel store value and asserts every one of the ten
    # digest paths against the exact 6.3 source row, so another valid-but-wrong
    # store name cannot pass. A wrong-kind store value is rejected without coercion.
    # The misspelled-mapping-entry, duplicate-vendor-name, and bad-initial-value
    # clauses need a vendored-DB or mapper-source fixture seam that does not exist
    # in the fixed mapper CLI and remain spec-deferred
    # (bugs/mapper-reputation-observability.md).
    $sentinel = [ordered]@{
        'reputation.communist' = 17
        'reputation.moralist' = -3
        'reputation.ultraliberal' = 0
        'reputation.revacholian_nationhood' = 42
        'reputation.kim' = -4
        'reputation.sorry_cop' = 5
        'reputation.superstar_cop' = 6
        'reputation.apocalypse_cop' = 7
        'reputation.boring_cop' = 8
        'reputation.art_cop' = 9
    }
    $fixture = New-ValidDump
    foreach ($name in $sentinel.Keys) {
        $fixture.tlv.variables[$name] = $sentinel[$name]
    }

    $run = Invoke-Mapper $fixture
    Assert ($run.ExitCode -eq 0) 'a complete reputation sentinel fixture publishes a digest'
    $document = Read-DigestDocument -Json ([IO.File]::ReadAllText($run.OutPath, [Text.UTF8Encoding]::new($false, $true)))
    $reputation = $document.RootElement.GetProperty('extra').GetProperty('reputation')
    Assert ($reputation.GetProperty('communist').GetInt64() -eq 17) 'communist reads its exact store variable'
    Assert ($reputation.GetProperty('moralist').GetInt64() -eq -3) 'moralist reads its exact store variable'
    Assert ($reputation.GetProperty('ultraliberal').GetInt64() -eq 0) 'ultraliberal reads its exact store variable'
    Assert ($reputation.GetProperty('nationalist').GetInt64() -eq 42) 'nationalist reads reputation.revacholian_nationhood'
    Assert ($reputation.GetProperty('kim').GetInt64() -eq -4) 'kim reads its exact store variable'
    $copStyle = $reputation.GetProperty('copStyle')
    foreach ($name in 'sorry', 'superstar', 'apocalypse', 'boring', 'art') {
        $expected = [long] $sentinel["reputation.${name}_cop"]
        Assert ($copStyle.GetProperty($name).GetInt64() -eq $expected) "copStyle.$name reads reputation.${name}_cop"
    }

    $wrongKind = New-ValidDump
    $wrongKind.tlv.variables['reputation.kim'] = '1'
    Assert-MapperFailedWithoutPublication -Dump $wrongKind -Message 'a string reputation store value is rejected without coercion'
}

function Test-MapperPublication {
    $badRoot = New-ValidDump
    $badRoot.extra = @{}
    Assert-MapperFailedWithoutPublication -Dump $badRoot -Message 'extra dump root member is rejected before publication'

    $badKind = New-ValidDump
    $badKind.tlv.variables['TASK.fixture_1'] = 'false'
    Assert-MapperFailedWithoutPublication -Dump $badKind -Message 'string task flag is rejected without coercion'

    $badReceipt = New-ValidDump
    $badReceipt.source.contentSha256 = ('c' * 64)
    Assert-MapperFailedWithoutPublication -Dump $badReceipt -Message 'miswired dump receipt is rejected before publication'

    $badParty = New-ValidDump
    $badParty.header.partyState.isKimInParty = 'false'
    Assert-MapperFailedWithoutPublication -Dump $badParty -Message 'string party Boolean is rejected without coercion'

    $badNumber = New-ValidDump
    $badNumber.world.playerCharacter.Level = '1'
    Assert-MapperFailedWithoutPublication -Dump $badNumber -Message 'string character integer is rejected without coercion'

    $badJournal = New-ValidDump
    $badJournal.world.aquiredJournalTasks.TaskAquisitions['TASK.one'] = @{ dayCounter = 1; dayMinutes = 480 }
    Assert-MapperFailedWithoutPublication -Dump $badJournal -Message 'journal acquisition and resolution key mismatch is rejected'

    $badSubtask = New-ValidDump
    $badSubtask.world.aquiredJournalTasks.SubtaskAquisitions['TASK.orphan'] = @{}
    Assert-MapperFailedWithoutPublication -Dump $badSubtask -Message 'orphan subtask parent is rejected'

    $badCatalog = New-ValidDump
    $badCatalog.world.inventoryState.itemListState = @(@{ itemName = 'item'; isFresh = $true }, @{ itemName = 'item'; isFresh = $false })
    Assert-MapperFailedWithoutPublication -Dump $badCatalog -Message 'duplicate catalog item name is rejected'

    $badReputation = New-ValidDump
    $badReputation.tlv.variables['reputation.kim'] = '1'
    Assert-MapperFailedWithoutPublication -Dump $badReputation -Message 'string reputation value is rejected without coercion'

    $badSeenCheck = New-ValidDump
    $badSeenCheck.world.failedWhiteChecksHolder.SeenWhiteCheckCache['check'] = @{ isOnlySeen = 'true' }
    Assert-MapperFailedWithoutPublication -Dump $badSeenCheck -Message 'string seen-check Boolean is rejected without coercion'

    foreach ($skill in $script:SkillKeyMap.skills) {
        $badSkill = New-ValidDump
        $badSkill.world.characterSheet[$skill.save_key].value = '1'
        Assert-MapperFailedWithoutPublication -Dump $badSkill -Message "string $($skill.skill_type) skill value is rejected without coercion"
    }
}

try {
    $tests = [ordered]@{
        MapperSemanticOutput = ${function:Test-MapperSemanticOutput}
        MapperPublication = ${function:Test-MapperPublication}
        MapperCharacterClosure = ${function:Test-MapperCharacterClosure}
        MapperSkillCompleteness = ${function:Test-MapperSkillCompleteness}
        MapperThoughtOrdering = ${function:Test-MapperThoughtOrdering}
        MapperOrdinalCaseSensitivity = ${function:Test-MapperOrdinalCaseSensitivity}
        MapperMoneyDecimal = ${function:Test-MapperMoneyDecimal}
        MapperReputationSemantics = ${function:Test-MapperReputationSemantics}
        MapperReputationDataSafety = ${function:Test-MapperReputationDataSafety}
    }

    if ($Only -eq 'All') {
        foreach ($test in $tests.Values) {
            & $test
        }
    }
    else {
        & $tests[$Only]
    }
}
finally {
    Remove-Item -LiteralPath $scratch -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host 'all Build-Digest assertions passed'
