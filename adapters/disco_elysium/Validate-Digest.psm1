Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Fail-AdapterDigestValidation {
    throw [AdapterDigestValidationException]::new('Disco Elysium digest semantic validation failed.')
}

function Get-AdapterProperty {
    param([Parameter(Mandatory)] [System.Text.Json.JsonElement] $Element, [Parameter(Mandatory)] [string] $Name)

    $value = [System.Text.Json.JsonElement]::new()
    if ($Element.ValueKind -ne [System.Text.Json.JsonValueKind]::Object -or -not $Element.TryGetProperty($Name, [ref] $value)) {
        Fail-AdapterDigestValidation
    }

    return $value
}

function Test-AdapterExactFields {
    param([Parameter(Mandatory)] [System.Text.Json.JsonElement] $Element, [Parameter(Mandatory)] [string[]] $Names)

    if ($Element.ValueKind -ne [System.Text.Json.JsonValueKind]::Object) {
        Fail-AdapterDigestValidation
    }

    $actual = @($Element.EnumerateObject() | ForEach-Object Name)
    if ($actual.Count -ne $Names.Count) {
        Fail-AdapterDigestValidation
    }
    foreach ($name in $Names) {
        $null = Get-AdapterProperty -Element $Element -Name $name
    }
}

function Test-AdapterBoolean {
    param([Parameter(Mandatory)] [System.Text.Json.JsonElement] $Element)

    if ($Element.ValueKind -ne [System.Text.Json.JsonValueKind]::True -and $Element.ValueKind -ne [System.Text.Json.JsonValueKind]::False) {
        Fail-AdapterDigestValidation
    }
}

function Test-AdapterInteger {
    param([Parameter(Mandatory)] [System.Text.Json.JsonElement] $Element, [switch] $Nonnegative)

    $value = 0L
    if ($Element.ValueKind -ne [System.Text.Json.JsonValueKind]::Number -or -not $Element.TryGetInt64([ref] $value) -or $Element.GetRawText() -notmatch '^-?(0|[1-9][0-9]*)$' -or ($Nonnegative -and $value -lt 0)) {
        Fail-AdapterDigestValidation
    }

    return $value
}

function Get-AdapterString {
    param([Parameter(Mandatory)] [System.Text.Json.JsonElement] $Element, [switch] $AllowEmpty)

    if ($Element.ValueKind -ne [System.Text.Json.JsonValueKind]::String) {
        Fail-AdapterDigestValidation
    }

    $value = $Element.GetString()
    if (-not $AllowEmpty -and [string]::IsNullOrEmpty($value)) {
        Fail-AdapterDigestValidation
    }

    return $value
}

function Get-ExpectedSkillGroups {
    return [ordered]@{
        'Logic' = 'Intellect'; 'Encyclopedia' = 'Intellect'; 'Rhetoric' = 'Intellect'; 'Drama' = 'Intellect'; 'Conceptualization' = 'Intellect'; 'Visual Calculus' = 'Intellect'
        'Volition' = 'Psyche'; 'Inland Empire' = 'Psyche'; 'Empathy' = 'Psyche'; 'Authority' = 'Psyche'; 'Suggestion' = 'Psyche'; 'Esprit de Corps' = 'Psyche'
        'Endurance' = 'Fysique'; 'Pain Threshold' = 'Fysique'; 'Physical Instrument' = 'Fysique'; 'Shivers' = 'Fysique'; 'Electrochemistry' = 'Fysique'; 'Half Light' = 'Fysique'
        'Hand/Eye Coordination' = 'Motorics'; 'Perception' = 'Motorics'; 'Reaction Speed' = 'Motorics'; 'Savoir Faire' = 'Motorics'; 'Interfacing' = 'Motorics'; 'Composure' = 'Motorics'
    }
}

function Assert-AdapterDigestSemantics {
    [CmdletBinding()]
    param([Parameter(Mandatory)] [object] $Document)

    try {
        $root = $Document.RootElement
        if ((Test-AdapterInteger (Get-AdapterProperty $root 'schemaVersion')) -ne 2 -or (Test-AdapterInteger (Get-AdapterProperty $root 'adapterVersion')) -ne 2 -or -not [string]::Equals((Get-AdapterString (Get-AdapterProperty $root 'game')), 'disco_elysium', [StringComparison]::Ordinal)) {
            Fail-AdapterDigestValidation
        }

        $session = Get-AdapterProperty $root 'session'
        if ((Get-AdapterProperty $session 'playtimeNote').ValueKind -ne [System.Text.Json.JsonValueKind]::Null) {
            Fail-AdapterDigestValidation
        }

        $character = Get-AdapterProperty $root 'character'
        $money = Get-AdapterProperty $character 'money'
        if ((Test-AdapterInteger (Get-AdapterProperty $money 'minorUnitsPerUnit')) -ne 100 -or -not [string]::Equals((Get-AdapterString (Get-AdapterProperty $money 'currency')), 'real', [StringComparison]::Ordinal)) {
            Fail-AdapterDigestValidation
        }

        $vitals = Get-AdapterProperty $character 'vitals'
        if ($vitals.ValueKind -ne [System.Text.Json.JsonValueKind]::Array -or $vitals.GetArrayLength() -ne 2) {
            Fail-AdapterDigestValidation
        }
        $vitalNames = @($vitals.EnumerateArray() | ForEach-Object { Get-AdapterString (Get-AdapterProperty $_ 'name') })
        if (-not [string]::Equals($vitalNames[0], 'health', [StringComparison]::Ordinal) -or -not [string]::Equals($vitalNames[1], 'morale', [StringComparison]::Ordinal)) {
            Fail-AdapterDigestValidation
        }

        $skills = Get-AdapterProperty $character 'skills'
        if ($skills.ValueKind -ne [System.Text.Json.JsonValueKind]::Array -or $skills.GetArrayLength() -ne 24) {
            Fail-AdapterDigestValidation
        }
        $skillNames = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
        $expectedGroups = Get-ExpectedSkillGroups
        foreach ($skill in $skills.EnumerateArray()) {
            $name = Get-AdapterString (Get-AdapterProperty $skill 'name')
            if (-not $skillNames.Add($name) -or -not $expectedGroups.Contains($name)) {
                Fail-AdapterDigestValidation
            }
            if (-not [string]::Equals((Get-AdapterString (Get-AdapterProperty $skill 'group')), $expectedGroups[$name], [StringComparison]::Ordinal)) {
                Fail-AdapterDigestValidation
            }
            $null = Test-AdapterInteger (Get-AdapterProperty $skill 'value')
        }

        foreach ($objective in (Get-AdapterProperty $root 'objectives').EnumerateArray()) {
            $id = Get-AdapterString (Get-AdapterProperty $objective 'id')
            if ($id -notmatch '^TASK\..+$' -or -not [string]::Equals((Get-AdapterString (Get-AdapterProperty $objective 'title') -AllowEmpty), (($id -replace '^TASK\.', '') -replace '_', ' '), [StringComparison]::Ordinal)) {
                Fail-AdapterDigestValidation
            }
            $status = Get-AdapterString (Get-AdapterProperty $objective 'status')
            $resolved = Get-AdapterProperty $objective 'resolved'
            if (($status -ne 'active' -and $status -ne 'done') -or ($status -eq 'active' -and $resolved.ValueKind -ne [System.Text.Json.JsonValueKind]::Null) -or ($status -eq 'done' -and $resolved.ValueKind -eq [System.Text.Json.JsonValueKind]::Null)) {
                Fail-AdapterDigestValidation
            }
            foreach ($subobjective in (Get-AdapterProperty $objective 'subobjectives').EnumerateArray()) {
                $subId = Get-AdapterString (Get-AdapterProperty $subobjective 'id')
                if ($subId -notmatch '^TASK\..+$' -or -not [string]::Equals((Get-AdapterString (Get-AdapterProperty $subobjective 'title') -AllowEmpty), (($subId -replace '^TASK\.', '') -replace '_', ' '), [StringComparison]::Ordinal) -or -not [string]::Equals((Get-AdapterString (Get-AdapterProperty $subobjective 'status')), $status, [StringComparison]::Ordinal) -or (Get-AdapterProperty $subobjective 'resolved').ValueKind -ne [System.Text.Json.JsonValueKind]::Null) {
                    Fail-AdapterDigestValidation
                }
            }
        }

        $extra = Get-AdapterProperty $root 'extra'
        Test-AdapterExactFields $extra @('party', 'reputation', 'thoughts', 'whiteChecks', 'dayPhase')
        $party = Get-AdapterProperty $extra 'party'
        Test-AdapterExactFields $party @('kimInParty', 'cunoInParty')
        foreach ($name in 'kimInParty', 'cunoInParty') { Test-AdapterBoolean (Get-AdapterProperty $party $name) }
        $reputation = Get-AdapterProperty $extra 'reputation'
        Test-AdapterExactFields $reputation @('communist', 'moralist', 'ultraliberal', 'nationalist', 'kim', 'copStyle')
        foreach ($name in 'communist', 'moralist', 'ultraliberal', 'nationalist', 'kim') { $null = Test-AdapterInteger (Get-AdapterProperty $reputation $name) }
        $copStyle = Get-AdapterProperty $reputation 'copStyle'
        Test-AdapterExactFields $copStyle @('sorry', 'superstar', 'apocalypse', 'boring', 'art')
        foreach ($name in 'sorry', 'superstar', 'apocalypse', 'boring', 'art') { $null = Test-AdapterInteger (Get-AdapterProperty $copStyle $name) }
        $thoughts = Get-AdapterProperty $extra 'thoughts'
        Test-AdapterExactFields $thoughts @('cooking', 'fixed', 'forgotten', 'known')
        $thoughtIds = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
        foreach ($name in 'cooking', 'fixed', 'forgotten', 'known') {
            $previous = $null
            foreach ($item in (Get-AdapterProperty $thoughts $name).EnumerateArray()) {
                $id = Get-AdapterString $item
                if (-not $thoughtIds.Add($id) -or ($null -ne $previous -and [string]::CompareOrdinal($previous, $id) -ge 0)) {
                    Fail-AdapterDigestValidation
                }
                $previous = $id
            }
        }
        $checks = Get-AdapterProperty $extra 'whiteChecks'
        Test-AdapterExactFields $checks @('retryable', 'seenOnly')
        foreach ($name in 'retryable', 'seenOnly') { $null = Test-AdapterInteger (Get-AdapterProperty $checks $name) -Nonnegative }
        $dayPhase = Get-AdapterProperty $extra 'dayPhase'
        Test-AdapterExactFields $dayPhase @('hasSlept', 'canSleep')
        foreach ($name in 'hasSlept', 'canSleep') { Test-AdapterBoolean (Get-AdapterProperty $dayPhase $name) }
    }
    catch [AdapterDigestValidationException] {
        throw
    }
    catch [CompanionContentException] {
        throw [AdapterDigestValidationException]::new('Disco Elysium digest semantic validation failed.', $_.Exception)
    }
}

Export-ModuleMember -Function Assert-AdapterDigestSemantics
