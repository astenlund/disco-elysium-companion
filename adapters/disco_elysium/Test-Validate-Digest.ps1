#Requires -Version 7.5

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
Import-Module (Join-Path $root 'core/DigestDiff.psm1') -Force

$validatorPath = Join-Path $PSScriptRoot 'Validate-Digest.psm1'
$coreModule = Get-Module DigestDiff
function Invoke-Validator {
    param([Parameter(Mandatory)] [object] $Document)

    & $coreModule {
        param($Path, $ValidatedDocument)

        Import-Module $Path -Force
        Assert-AdapterDigestSemantics -Document $ValidatedDocument
    } $validatorPath $Document
}
function Assert-MutationRejected {
    param(
        [Parameter(Mandatory)] [object[]] $Mutations,
        [Parameter(Mandatory)] [string] $BaseJson
    )

    foreach ($mutation in $Mutations) {
        $candidate = (Read-CompanionJson -Json $BaseJson -Budget digest).Materialized
        & $mutation.Apply $candidate
        $candidateDocument = Read-DigestDocument -Json (ConvertTo-CompanionJson -InputObject $candidate -Budget digest)
        try {
            Invoke-Validator -Document $candidateDocument
            throw "$($mutation.Name) was accepted"
        }
        catch {
            if (-not [string]::Equals($_.Exception.GetType().Name, 'AdapterDigestValidationException', [StringComparison]::Ordinal)) {
                throw
            }
        }

        Write-Host "ok: rejects $($mutation.Name)"
    }
}

$skillMap = Read-CompanionJson -Path (Join-Path $PSScriptRoot 'game_data/skill_key_map.json') -Budget config
$skills = foreach ($skill in $skillMap.Materialized.skills) {
    $ability = $skillMap.Materialized.abilities | Where-Object { [string]::Equals($_.skill_type, $skill.ability, [StringComparison]::Ordinal) }
    @{ name = $skill.display_name; value = 1; group = $ability.display_name }
}

$digest = [ordered]@{
    schemaVersion = 2; adapterVersion = 2; game = 'disco_elysium'; generatedAt = '2026-08-10T00:00:00.0000000Z'
    source = @{ domainId = ('a' * 64); saveFile = 'fixture.ntwtf.zip'; savedAt = '2026-08-10T00:00:00.0000000Z'; byteLength = 1; contentSha256 = ('b' * 64) }
    session = @{ day = 1; time = '08:00'; location = 'test'; playtimeNote = $null }
    character = @{ level = 0; xp = 0; unspentPoints = 0; money = @{ amount = [decimal]0; minorUnits = 0; minorUnitsPerUnit = 100; currency = 'real' }; vitals = @(@{ name = 'health'; value = 1 }, @{ name = 'morale'; value = 1 }); skills = @($skills) }
    objectives = @(); inventory = @{ owned = @(); equipped = @(); highlights = @() }
    extra = @{ party = @{ kimInParty = $false; cunoInParty = $false }; reputation = @{ communist = 0; moralist = 0; ultraliberal = 0; nationalist = 0; kim = 0; copStyle = @{ sorry = 0; superstar = 0; apocalypse = 0; boring = 0; art = 0 } }; thoughts = @{ cooking = @(); fixed = @(); forgotten = @(); known = @() }; whiteChecks = @{ retryable = 0; seenOnly = 0 }; dayPhase = @{ hasSlept = $false; canSleep = $false } }
}

$document = Read-DigestDocument -Json (ConvertTo-CompanionJson -InputObject $digest -Budget digest)
try {
    Invoke-Validator -Document $document
    Write-Host 'ok: accepts a core-valid DE digest with canonical DE invariants'
}
catch {
    throw "valid DE digest rejected: $($_.Exception.GetType().FullName): $($_.Exception.Message)"
}

$digest.character.money.currency = 'REAL'
$invalid = Read-DigestDocument -Json (ConvertTo-CompanionJson -InputObject $digest -Budget digest)
try {
    Invoke-Validator -Document $invalid
    throw 'ordinal currency mutation was accepted'
}
catch {
    if (-not [string]::Equals($_.Exception.GetType().Name, 'AdapterDigestValidationException', [StringComparison]::Ordinal)) {
        throw
    }

    Write-Host 'ok: rejects case-distinct currency'
}

$digest.character.money.currency = 'real'
$validJson = ConvertTo-CompanionJson -InputObject $digest -Budget digest
$mutations = @(
    @{ Name = 'non-null playtime note'; Apply = { param($value) $value.session.playtimeNote = 'note' } },
    @{ Name = 'wrong minor units divisor'; Apply = { param($value) $value.character.money.minorUnitsPerUnit = 1 } },
    @{ Name = 'reordered vitals'; Apply = { param($value) $value.character.vitals = @($value.character.vitals[1], $value.character.vitals[0]) } },
    @{ Name = 'wrong vital name'; Apply = { param($value) $value.character.vitals[0].name = 'Health' } },
    @{ Name = 'missing skill'; Apply = { param($value) $value.character.skills = @($value.character.skills | Select-Object -Skip 1) } },
    @{ Name = 'wrong skill group'; Apply = { param($value) $value.character.skills[0].group = 'Wrong' } },
    @{ Name = 'extra root member'; Apply = { param($value) $value.extra.unexpected = 1 } },
    @{ Name = 'wrong party kind'; Apply = { param($value) $value.extra.party.kimInParty = 1 } },
    @{ Name = 'missing reputation member'; Apply = { param($value) $value.extra.reputation.Remove('kim') } },
    @{ Name = 'wrong cop style kind'; Apply = { param($value) $value.extra.reputation.copStyle.art = '0' } },
    @{ Name = 'thought overlap'; Apply = { param($value) $value.extra.thoughts.cooking = @('thought'); $value.extra.thoughts.known = @('thought') } },
    @{ Name = 'unsorted thoughts'; Apply = { param($value) $value.extra.thoughts.known = @('z', 'a') } },
    @{ Name = 'empty thought identifier'; Apply = { param($value) $value.extra.thoughts.known = @('') } },
    @{ Name = 'negative retryable check count'; Apply = { param($value) $value.extra.whiteChecks.retryable = -1 } },
    @{ Name = 'wrong day phase kind'; Apply = { param($value) $value.extra.dayPhase.hasSlept = 'false' } }
)
Assert-MutationRejected -Mutations $mutations -BaseJson $validJson

$objectiveCandidate = (Read-CompanionJson -Json $validJson -Budget digest).Materialized
$objectiveCandidate.objectives = @(@{ id = 'TASK.example_task'; title = 'example task'; status = 'active'; acquired = @{ day = 1; time = '08:00' }; resolved = $null; subobjectives = @(@{ id = 'TASK.child_task'; title = 'child task'; status = 'active'; acquired = @{ day = 1; time = '08:00' }; resolved = $null; subobjectives = $null }) })
$objectiveJson = ConvertTo-CompanionJson -InputObject $objectiveCandidate -Budget digest
Invoke-Validator -Document (Read-DigestDocument -Json $objectiveJson)
$objectiveMutations = @(
    @{ Name = 'invalid objective namespace'; Apply = { param($value) $value.objectives[0].id = 'task.example' } },
    @{ Name = 'wrong objective title'; Apply = { param($value) $value.objectives[0].title = 'wrong' } },
    @{ Name = 'unsupported objective status'; Apply = { param($value) $value.objectives[0].status = 'failed' } },
    @{ Name = 'active objective resolution'; Apply = { param($value) $value.objectives[0].resolved = @{ day = 1; time = '08:01' } } },
    @{ Name = 'subobjective status mismatch'; Apply = { param($value) $value.objectives[0].subobjectives[0].status = 'done' } },
    @{ Name = 'subobjective resolution'; Apply = { param($value) $value.objectives[0].subobjectives[0].resolved = @{ day = 1; time = '08:01' } } }
)
Assert-MutationRejected -Mutations $objectiveMutations -BaseJson $objectiveJson

Write-Host 'all Validate-Digest assertions passed'
