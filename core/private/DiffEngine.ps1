function New-DiffObject {
    return [Collections.Specialized.OrderedDictionary]::new()
}

function Get-DiffProperty {
    param([Parameter(Mandatory)] [Text.Json.JsonElement] $Element, [Parameter(Mandatory)] [string] $Name)

    return Get-Property -Element $Element -Name $Name
}

function Get-DiffStringMap {
    param([Parameter(Mandatory)] [Text.Json.JsonElement] $Array, [Parameter(Mandatory)] [string] $Key)

    $map = [Collections.Generic.Dictionary[string, Text.Json.JsonElement]]::new([StringComparer]::Ordinal)
    foreach ($item in $Array.EnumerateArray()) {
        $name = (Get-DiffProperty -Element $item -Name $Key).GetString()
        $map.Add($name, $item)
    }

    return $map
}

function Get-DiffSortedUnion {
    # Accepts skill/vitals maps (Dictionary[string, JsonElement]) and objective maps
    # (Dictionary[string, object]); only .Keys and .ContainsKey are used.
    param([Parameter(Mandatory)] [object] $Left, [Parameter(Mandatory)] [object] $Right)

    $names = [Collections.Generic.List[string]]::new()
    foreach ($name in $Left.Keys) { $names.Add($name) }
    foreach ($name in $Right.Keys) { if (-not $Left.ContainsKey($name)) { $names.Add($name) } }
    $names.Sort([StringComparer]::Ordinal)

    return $names
}

function Get-OrdinalSortedStrings {
    # Per 7.2, inventory gained/lost and objective/extra composite keys sort ORDINALLY, not
    # with culture-aware Sort-Object. Sort-Object has no ordinal mode, so collect into a
    # List[string] and sort with [StringComparer]::Ordinal (the Get-DiffSortedUnion pattern).
    # The parameter is untyped because PowerShell unrolls single-element and empty string[]
    # arguments to scalars during binding, which would make $Values.Count throw.
    param([Parameter(Mandatory)] [AllowNull()] $Values)

    $list = [Collections.Generic.List[string]]::new()
    foreach ($value in @($Values)) { $list.Add([string] $value) }
    $list.Sort([StringComparer]::Ordinal)

    # The leading comma prevents PowerShell from unrolling a single-element result to a
    # scalar string on return (which would make a caller's .Count throw).
    return , $list.ToArray()
}

function ConvertTo-DiffPointer {
    param([Parameter(Mandatory)] [string] $Token)

    return $Token.Replace('~', '~0').Replace('/', '~1')
}

function ConvertFrom-DiffPointer {
    param([Parameter(Mandatory)] [string] $Pointer)

    return @($Pointer.Substring(1).Split('/') | ForEach-Object { $_.Replace('~1', '/').Replace('~0', '~') })
}

function Test-DiffPointerPrefix {
    param([Parameter(Mandatory)] [string] $Ancestor, [Parameter(Mandatory)] [string] $Descendant)

    return $Descendant.Length -gt $Ancestor.Length -and $Descendant.StartsWith($Ancestor + '/', [StringComparison]::Ordinal)
}

function Resolve-DiffExtraPointer {
    param([Parameter(Mandatory)] [Text.Json.JsonElement] $Baseline, [Parameter(Mandatory)] [Text.Json.JsonElement] $Target, [Parameter(Mandatory)] [string] $Pointer)

    $tokens = ConvertFrom-DiffPointer -Pointer $Pointer
    if ($tokens.Count -lt 2 -or -not [string]::Equals($tokens[0], 'extra', [StringComparison]::Ordinal)) { return $false }
    $left = Get-DiffProperty -Element $Baseline -Name 'extra'
    $right = Get-DiffProperty -Element $Target -Name 'extra'
    for ($index = 1; $index -lt $tokens.Count; $index++) {
        foreach ($side in @($left, $right)) {
            if ($side.ValueKind -ne [Text.Json.JsonValueKind]::Undefined -and $side.ValueKind -ne [Text.Json.JsonValueKind]::Object) { return $false }
        }
        $found = $false
        foreach ($side in @($left, $right)) {
            if ($side.ValueKind -eq [Text.Json.JsonValueKind]::Object) {
                $child = [Text.Json.JsonElement]::new()
                if ($side.TryGetProperty($tokens[$index], [ref] $child)) { $found = $true }
            }
        }
        if (-not $found) { return $false }
        if ($index -eq $tokens.Count - 1) { return $true }
        $nextLeft = [Text.Json.JsonElement]::new()
        $nextRight = [Text.Json.JsonElement]::new()
        if ($left.ValueKind -eq [Text.Json.JsonValueKind]::Object -and $left.TryGetProperty($tokens[$index], [ref] $nextLeft)) { $left = $nextLeft } else { $left = [Text.Json.JsonElement]::new() }
        if ($right.ValueKind -eq [Text.Json.JsonValueKind]::Object -and $right.TryGetProperty($tokens[$index], [ref] $nextRight)) { $right = $nextRight } else { $right = [Text.Json.JsonElement]::new() }
    }
    return $false
}

function Get-DiffExtraChanges {
    param([Parameter(Mandatory)] [Text.Json.JsonElement] $Baseline, [Parameter(Mandatory)] [Text.Json.JsonElement] $Target, [string[]] $ExcludedPaths = @())

    $frontier = [Collections.Generic.List[string]]::new()
    foreach ($path in $ExcludedPaths) {
        if (Resolve-DiffExtraPointer -Baseline $Baseline -Target $Target -Pointer $path) {
            if (-not ($frontier | Where-Object { Test-DiffPointerPrefix -Ancestor $_ -Descendant $path })) { $frontier.Add($path) }
        }
    }
    $frontier.Sort([StringComparer]::Ordinal)
    $changes = [Collections.Generic.List[object]]::new()
    $excludedChanged = [Collections.Generic.List[bool]]::new(); $excludedChanged.Add($false)
    function Visit-DiffExtra {
        param([Text.Json.JsonElement] $From, [bool] $FromPresent, [Text.Json.JsonElement] $To, [bool] $ToPresent, [string] $Path)
        $isExcluded = $frontier.Contains($Path)
        if ($isExcluded) {
            if (-not ($FromPresent -and $ToPresent -and [Text.Json.JsonElement]::DeepEquals($From, $To))) { $excludedChanged[0] = $true }
            return
        }
        if ($FromPresent -and $ToPresent -and $From.ValueKind -eq [Text.Json.JsonValueKind]::Object -and $To.ValueKind -eq [Text.Json.JsonValueKind]::Object) {
            $keys = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
            foreach ($property in $From.EnumerateObject()) { [void] $keys.Add($property.Name) }
            foreach ($property in $To.EnumerateObject()) { [void] $keys.Add($property.Name) }
            $ordered = Get-OrdinalSortedStrings ([string[]]@($keys))
            if ($ordered.Count -eq 0 -and -not [Text.Json.JsonElement]::DeepEquals($From, $To)) { $changes.Add([ordered]@{ path = $Path; fromPresent = $true; toPresent = $true; from = $From.Clone(); to = $To.Clone() }) }
            foreach ($key in $ordered) {
                $left = [Text.Json.JsonElement]::new(); $right = [Text.Json.JsonElement]::new()
                $hasLeft = $From.TryGetProperty($key, [ref] $left); $hasRight = $To.TryGetProperty($key, [ref] $right)
                Visit-DiffExtra -From $left -FromPresent $hasLeft -To $right -ToPresent $hasRight -Path ($Path + '/' + (ConvertTo-DiffPointer $key))
            }
            return
        }
        if (-not ($FromPresent -and $ToPresent -and [Text.Json.JsonElement]::DeepEquals($From, $To))) {
            $changes.Add([ordered]@{ path = $Path; fromPresent = $FromPresent; toPresent = $ToPresent; from = if ($FromPresent) { $From.Clone() } else { $null }; to = if ($ToPresent) { $To.Clone() } else { $null } })
        }
    }
    Visit-DiffExtra -From (Get-DiffProperty $Baseline 'extra') -FromPresent $true -To (Get-DiffProperty $Target 'extra') -ToPresent $true -Path '/extra'
    $changesArray = $changes
    if ($changes.Count -gt 1) {
        $pathKeys = [string[]]@($changes | ForEach-Object { $_.path })
        $pathItems = [object[]]@($changes)
        [Array]::Sort[string, object]($pathKeys, $pathItems, [StringComparer]::Ordinal)
        $changesArray = [Collections.Generic.List[object]]::new([object[]]$pathItems)
    }

    return [pscustomobject]@{ Changes = @($changesArray); ExcludedChanged = $excludedChanged[0] }
}

function New-EmptyDiff {
    param([Parameter(Mandatory)] [CompanionJsonValue] $Target)

    $root = $Target.RootElement
    $diff = New-DiffObject
    $diff['schemaVersion'] = (Get-CoreSchemaVersion); $diff['adapterVersion'] = (Get-DiffProperty $root 'adapterVersion').GetInt64(); $diff['game'] = (Get-DiffProperty $root 'game').GetString(); $diff['hasChanges'] = $false; $diff['hasUnrepresentedChanges'] = $false; $diff['baselineGeneratedAt'] = $null; $diff['currentGeneratedAt'] = (Get-DiffProperty $root 'generatedAt').GetString(); $diff['currentSource'] = (Get-DiffProperty $root 'source').Clone(); $diff['sessionChange'] = $null
    $objectives = New-DiffObject; $objectives['added'] = @(); $objectives['removed'] = @(); $objectives['statusChanged'] = @(); $diff['objectives'] = $objectives
    $character = New-DiffObject; $character['levelDelta'] = 0L; $character['xpDelta'] = 0L; $character['moneyDelta'] = [decimal]0; $character['skillChanges'] = @(); $diff['character'] = $character
    $inventory = New-DiffObject; $inventory['gained'] = @(); $inventory['lost'] = @(); $inventory['equippedChanged'] = $false; $diff['inventory'] = $inventory; $diff['extraChanges'] = @()
    return Read-DiffDocument -Json (ConvertTo-CompanionJson -InputObject $diff -Budget diff)
}

function Get-DiffStringSet {
    param([Parameter(Mandatory)] [Text.Json.JsonElement] $Array)

    $set = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($item in $Array.EnumerateArray()) { [void] $set.Add($item.GetString()) }
    return $set
}

function Get-DiffObjectiveMap {
    param([Parameter(Mandatory)] [Text.Json.JsonElement] $Objectives)

    $map = [Collections.Generic.Dictionary[string, object]]::new([StringComparer]::Ordinal)
    foreach ($objective in $Objectives.EnumerateArray()) {
        $id = (Get-DiffProperty $objective 'id').GetString()
        $map.Add(([char]0 + $id), [pscustomobject]@{ parent = $null; value = $objective })
        foreach ($child in (Get-DiffProperty $objective 'subobjectives').EnumerateArray()) {
            $childId = (Get-DiffProperty $child 'id').GetString()
            $map.Add(($id + [char]0 + $childId), [pscustomobject]@{ parent = $id; value = $child })
        }
    }
    return $map
}

function Test-DiffElementChange {
    param([Parameter(Mandatory)] [Text.Json.JsonElement] $Left, [Parameter(Mandatory)] [Text.Json.JsonElement] $Right)

    return -not [Text.Json.JsonElement]::DeepEquals($Left, $Right)
}

function Test-DiffOmittedFixedChange {
    param(
        [Parameter(Mandatory)] [Text.Json.JsonElement] $Left,
        [Parameter(Mandatory)] [Text.Json.JsonElement] $Right,
        [Parameter(Mandatory)] [Collections.Generic.Dictionary[string, Text.Json.JsonElement]] $SkillsLeft,
        [Parameter(Mandatory)] [Collections.Generic.Dictionary[string, Text.Json.JsonElement]] $SkillsRight,
        [Parameter(Mandatory)] [Collections.Generic.Dictionary[string, object]] $ObjectivesLeft,
        [Parameter(Mandatory)] [Collections.Generic.Dictionary[string, object]] $ObjectivesRight
    )

    $leftSession = Get-DiffProperty $Left 'session'; $rightSession = Get-DiffProperty $Right 'session'; $leftCharacter = Get-DiffProperty $Left 'character'; $rightCharacter = Get-DiffProperty $Right 'character'
    if ((Test-DiffElementChange (Get-DiffProperty $leftSession 'playtimeNote') (Get-DiffProperty $rightSession 'playtimeNote')) -or (Test-DiffElementChange (Get-DiffProperty $leftCharacter 'unspentPoints') (Get-DiffProperty $rightCharacter 'unspentPoints'))) { return $true }
    $leftVitals = Get-DiffStringMap (Get-DiffProperty $leftCharacter 'vitals') 'name'; $rightVitals = Get-DiffStringMap (Get-DiffProperty $rightCharacter 'vitals') 'name'
    foreach ($name in (Get-DiffSortedUnion $leftVitals $rightVitals)) {
        if (-not $leftVitals.ContainsKey($name) -or -not $rightVitals.ContainsKey($name)) { return $true }
        if (Test-DiffElementChange (Get-DiffProperty $leftVitals[$name] 'value') (Get-DiffProperty $rightVitals[$name] 'value')) { return $true }
    }
    foreach ($name in (Get-DiffSortedUnion $SkillsLeft $SkillsRight)) {
        if (-not $SkillsLeft.ContainsKey($name) -or -not $SkillsRight.ContainsKey($name)) { return $true }
        if (Test-DiffElementChange (Get-DiffProperty $SkillsLeft[$name] 'group') (Get-DiffProperty $SkillsRight[$name] 'group')) { return $true }
    }
    foreach ($key in $ObjectivesLeft.Keys) {
        if ($ObjectivesRight.ContainsKey($key)) {
            foreach ($field in 'title', 'acquired', 'resolved') { if (Test-DiffElementChange (Get-DiffProperty $ObjectivesLeft[$key].value $field) (Get-DiffProperty $ObjectivesRight[$key].value $field)) { return $true } }
        }
    }
    return $false
}

function Compare-Digests {
    param([AllowNull()] [CompanionJsonValue] $Baseline, [Parameter(Mandatory)] [CompanionJsonValue] $Target, [Parameter(Mandatory)] [AdapterCompatibilityConfig] $AdapterConfig, [AllowNull()] [CompanionWarningSink] $WarningSink)

    if ($null -eq $Baseline) { return New-EmptyDiff -Target $Target }
    $left = $Baseline.RootElement; $right = $Target.RootElement
    $leftMoney = Get-DiffProperty (Get-DiffProperty $left 'character') 'money'; $rightMoney = Get-DiffProperty (Get-DiffProperty $right 'character') 'money'
    if (-not [string]::Equals((Get-DiffProperty $leftMoney 'currency').GetString(), (Get-DiffProperty $rightMoney 'currency').GetString(), [StringComparison]::Ordinal) -or (Get-DiffProperty $leftMoney 'minorUnitsPerUnit').GetInt64() -ne (Get-DiffProperty $rightMoney 'minorUnitsPerUnit').GetInt64()) { throw [CompanionDiffCompatibilityException]::new('Digest money units are incompatible.') }
    $resolved = [Collections.Generic.List[string]]::new()
    foreach ($path in $AdapterConfig.DiffExcludePaths) { if (Resolve-DiffExtraPointer $left $right $path) { $resolved.Add($path) } elseif ($null -ne $WarningSink) { Add-CompanionWarning -Sink $WarningSink -Code 'diff-exclude-path-unused' -Detail $path } }
    $extraResult = Get-DiffExtraChanges -Baseline $left -Target $right -ExcludedPaths ([string[]] $resolved)
    $sessionLeft = Get-DiffProperty $left 'session'; $sessionRight = Get-DiffProperty $right 'session'; $locationChanged = -not [string]::Equals((Get-DiffProperty $sessionLeft 'location').GetString(), (Get-DiffProperty $sessionRight 'location').GetString(), [StringComparison]::Ordinal); $sessionChanged = (Get-DiffProperty $sessionLeft 'day').GetInt64() -ne (Get-DiffProperty $sessionRight 'day').GetInt64() -or -not [string]::Equals((Get-DiffProperty $sessionLeft 'time').GetString(), (Get-DiffProperty $sessionRight 'time').GetString(), [StringComparison]::Ordinal) -or $locationChanged
    $characterLeft = Get-DiffProperty $left 'character'; $characterRight = Get-DiffProperty $right 'character'
    $levelDelta = (Get-DiffProperty $characterRight 'level').GetInt64() - (Get-DiffProperty $characterLeft 'level').GetInt64(); $xpDelta = (Get-DiffProperty $characterRight 'xp').GetInt64() - (Get-DiffProperty $characterLeft 'xp').GetInt64()
    $moneyDelta = ([decimal]([Numerics.BigInteger](Get-DiffProperty $rightMoney 'minorUnits').GetInt64() - [Numerics.BigInteger](Get-DiffProperty $leftMoney 'minorUnits').GetInt64())) / [decimal](Get-DiffProperty $rightMoney 'minorUnitsPerUnit').GetInt64()
    $skillLeft = Get-DiffStringMap (Get-DiffProperty $characterLeft 'skills') 'name'; $skillRight = Get-DiffStringMap (Get-DiffProperty $characterRight 'skills') 'name'; $skillChanges = [Collections.Generic.List[object]]::new()
    foreach ($name in (Get-DiffSortedUnion $skillLeft $skillRight)) { $from = $null; $to = $null; if ($skillLeft.ContainsKey($name)) { $from = (Get-DiffProperty $skillLeft[$name] 'value').GetInt64() }; if ($skillRight.ContainsKey($name)) { $to = (Get-DiffProperty $skillRight[$name] 'value').GetInt64() }; if ($null -eq $from -or $null -eq $to -or $from -ne $to) { $skillChanges.Add([ordered]@{ name = $name; from = $from; to = $to }) } }
    $diff = New-DiffObject; $diff['schemaVersion'] = (Get-CoreSchemaVersion); $diff['adapterVersion'] = (Get-DiffProperty $right 'adapterVersion').GetInt64(); $diff['game'] = (Get-DiffProperty $right 'game').GetString(); $diff['hasChanges'] = $false; $diff['baselineGeneratedAt'] = (Get-DiffProperty $left 'generatedAt').GetString(); $diff['currentGeneratedAt'] = (Get-DiffProperty $right 'generatedAt').GetString(); $diff['currentSource'] = (Get-DiffProperty $right 'source').Clone()
    $diff['sessionChange'] = if ($sessionChanged) { [ordered]@{ from = [ordered]@{ day = (Get-DiffProperty $sessionLeft 'day').GetInt64(); time = (Get-DiffProperty $sessionLeft 'time').GetString() }; to = [ordered]@{ day = (Get-DiffProperty $sessionRight 'day').GetInt64(); time = (Get-DiffProperty $sessionRight 'time').GetString() }; locationChanged = $locationChanged } } else { $null }
    $leftObjectives = Get-DiffObjectiveMap (Get-DiffProperty $left 'objectives'); $rightObjectives = Get-DiffObjectiveMap (Get-DiffProperty $right 'objectives')
    $added = [Collections.Generic.List[object]]::new(); $removed = [Collections.Generic.List[object]]::new(); $statusChanged = [Collections.Generic.List[object]]::new()
    $objectiveKeys = Get-DiffSortedUnion $leftObjectives $rightObjectives
    foreach ($key in $objectiveKeys) {
        if (-not $leftObjectives.ContainsKey($key)) { $entry = $rightObjectives[$key]; $added.Add([ordered]@{ id = (Get-DiffProperty $entry.value 'id').GetString(); status = (Get-DiffProperty $entry.value 'status').GetString(); parentId = $entry.parent }); continue }
        if (-not $rightObjectives.ContainsKey($key)) { $entry = $leftObjectives[$key]; $removed.Add([ordered]@{ id = (Get-DiffProperty $entry.value 'id').GetString(); lastStatus = (Get-DiffProperty $entry.value 'status').GetString(); parentId = $entry.parent }); continue }
        $before = $leftObjectives[$key]; $after = $rightObjectives[$key]; $beforeStatus = (Get-DiffProperty $before.value 'status').GetString(); $afterStatus = (Get-DiffProperty $after.value 'status').GetString(); if (-not [string]::Equals($beforeStatus, $afterStatus, [StringComparison]::Ordinal)) { $statusChanged.Add([ordered]@{ id = (Get-DiffProperty $after.value 'id').GetString(); from = $beforeStatus; to = $afterStatus; parentId = $after.parent }) }
    }
    $objectives = New-DiffObject; $objectives['added'] = $added.ToArray(); $objectives['removed'] = $removed.ToArray(); $objectives['statusChanged'] = $statusChanged.ToArray(); $diff['objectives'] = $objectives
    $character = New-DiffObject; $character['levelDelta'] = $levelDelta; $character['xpDelta'] = $xpDelta; $character['moneyDelta'] = $moneyDelta; $character['skillChanges'] = ($skillChanges.ToArray()); $diff['character'] = $character
    $inventoryLeft = Get-DiffProperty $left 'inventory'; $inventoryRight = Get-DiffProperty $right 'inventory'; $ownedLeft = Get-DiffStringSet (Get-DiffProperty $inventoryLeft 'owned'); $ownedRight = Get-DiffStringSet (Get-DiffProperty $inventoryRight 'owned'); $gained = Get-OrdinalSortedStrings ([string[]]@($ownedRight | Where-Object { -not $ownedLeft.Contains($_) })); $lost = Get-OrdinalSortedStrings ([string[]]@($ownedLeft | Where-Object { -not $ownedRight.Contains($_) })); $equippedChanged = -not [Text.Json.JsonElement]::DeepEquals((Get-DiffProperty $inventoryLeft 'equipped'), (Get-DiffProperty $inventoryRight 'equipped'))
    $inventory = New-DiffObject; $inventory['gained'] = $gained; $inventory['lost'] = $lost; $inventory['equippedChanged'] = $equippedChanged; $diff['inventory'] = $inventory; $diff['extraChanges'] = $extraResult.Changes
    $highlightChanged = -not [Text.Json.JsonElement]::DeepEquals((Get-DiffProperty $inventoryLeft 'highlights'), (Get-DiffProperty $inventoryRight 'highlights'))
    $diff['hasUnrepresentedChanges'] = [bool]($extraResult.ExcludedChanged -or $highlightChanged -or (Test-DiffOmittedFixedChange -Left $left -Right $right -SkillsLeft $skillLeft -SkillsRight $skillRight -ObjectivesLeft $leftObjectives -ObjectivesRight $rightObjectives))
    $diff['hasChanges'] = $null -ne $diff['sessionChange'] -or $added.Count -ne 0 -or $removed.Count -ne 0 -or $statusChanged.Count -ne 0 -or $levelDelta -ne 0 -or $xpDelta -ne 0 -or $moneyDelta -ne 0 -or $skillChanges.Count -ne 0 -or $gained.Count -ne 0 -or $lost.Count -ne 0 -or $equippedChanged -or $extraResult.Changes.Count -ne 0
    return Read-DiffDocument -Json (ConvertTo-CompanionJson -InputObject $diff -Budget diff)
}

function Test-UneventfulDiff {
    param([Parameter(Mandatory)] [CompanionJsonValue] $Diff, [Parameter(Mandatory)] [AdapterCompatibilityConfig] $AdapterConfig)

    $root = $Diff.RootElement
    if (-not $root.GetProperty('hasChanges').GetBoolean()) { return $true }
    if ($root.GetProperty('sessionChange').ValueKind -ne [Text.Json.JsonValueKind]::Null) { return $false }
    $character = $root.GetProperty('character'); $inventory = $root.GetProperty('inventory'); $objectives = $root.GetProperty('objectives')
    if ($character.GetProperty('levelDelta').GetInt64() -ne 0 -or $character.GetProperty('xpDelta').GetInt64() -ne 0 -or $character.GetProperty('moneyDelta').GetDecimal() -ne 0 -or $character.GetProperty('skillChanges').GetArrayLength() -ne 0 -or $inventory.GetProperty('gained').GetArrayLength() -ne 0 -or $inventory.GetProperty('lost').GetArrayLength() -ne 0 -or $inventory.GetProperty('equippedChanged').GetBoolean() -or $objectives.GetProperty('added').GetArrayLength() -ne 0 -or $objectives.GetProperty('removed').GetArrayLength() -ne 0 -or $objectives.GetProperty('statusChanged').GetArrayLength() -ne 0) { return $false }
    foreach ($change in $root.GetProperty('extraChanges').EnumerateArray()) {
        $path = $change.GetProperty('path').GetString()
        $ambient = $false
        foreach ($configuredPath in $AdapterConfig.AmbientExtraPaths) {
            if ([string]::Equals($configuredPath, $path, [StringComparison]::Ordinal) -or (Test-DiffPointerPrefix -Ancestor $configuredPath -Descendant $path)) {
                $ambient = $true
                break
            }
        }
        if (-not $ambient) { return $false }
    }
    return $true
}

function Assert-DiffSemantics {
    param([Parameter(Mandatory)] [CompanionJsonValue] $Diff, [AllowNull()] [CompanionJsonValue] $Baseline, [Parameter(Mandatory)] [CompanionJsonValue] $Target, [Parameter(Mandatory)] [AdapterCompatibilityConfig] $AdapterConfig)

    $recomputed = Compare-Digests -Baseline $Baseline -Target $Target -AdapterConfig $AdapterConfig
    if (-not [Text.Json.JsonElement]::DeepEquals($Diff.RootElement, $recomputed.RootElement)) { throw [CompanionDiffSemanticException]::new('Diff does not match its digest pair.') }
}
