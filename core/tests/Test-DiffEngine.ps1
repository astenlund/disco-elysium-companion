#Requires -Version 7.5

[CmdletBinding()]
param(
    [Parameter()]
    [ValidateSet('All', 'CanonicalBuckets', 'Exclusions', 'Compatibility', 'Objectives', 'OmittedFields', 'RepresentedFlag', 'PointerResolution', 'ExtraTransitions', 'ObjectiveCollisions', 'MoneyExactness', 'SemanticRejection')]
    [string] $Only = 'All'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Import-Module (Join-Path (Split-Path $PSScriptRoot -Parent) 'DigestDiff.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'TestSupport.psm1') -Force

function New-DigestJson {
    param(
        [Parameter()] [string] $GeneratedAt = '2026-08-10T12:00:00.0000000Z',
        [Parameter()] [string] $SavedAt = '2026-08-10T11:00:00.0000000Z',
        [Parameter()] [string] $SaveFile = 'A.ntwtf.zip',
        [Parameter()] [long] $Level = 1,
        [Parameter()] [long] $Xp = 0,
        [Parameter()] [long] $Money = 100,
        [Parameter()] [string] $Day = '1',
        [Parameter()] [string] $Time = '08:09',
        [Parameter()] [string] $Location = 'place',
        [Parameter()] [string] $Extra = '{"case":{"x":1,"X":2},"list":[1,2],"a/b":{"~key":1}}'
    )

    $amount = ([decimal] $Money / 100).ToString([Globalization.CultureInfo]::InvariantCulture)
    return @"
{"schemaVersion":2,"adapterVersion":2,"game":"example","generatedAt":"$GeneratedAt","source":{"domainId":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef","saveFile":"$SaveFile","savedAt":"$SavedAt","byteLength":1,"contentSha256":"abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd"},"session":{"day":$Day,"time":"$Time","location":"$Location","playtimeNote":null},"character":{"level":$Level,"xp":$Xp,"unspentPoints":0,"money":{"amount":$amount,"minorUnits":$Money,"minorUnitsPerUnit":100,"currency":"real"},"vitals":[{"name":"health","value":1}],"skills":[{"name":"Logic","value":1,"group":"Intellect"}]},"objectives":[{"id":"TASK.example","title":"example","status":"active","acquired":{"day":1,"time":"08:09"},"resolved":null,"subobjectives":[]}],"inventory":{"owned":["item"],"equipped":["item"],"highlights":[]},"extra":$Extra}
"@
}

function New-TestAdapterConfig {
    param([string[]] $DiffExcludePaths = @(), [string[]] $AmbientExtraPaths = @())

    $policy = [pscustomobject]@{ Paths = [string[]] $DiffExcludePaths; Ambient = [string[]] $AmbientExtraPaths }
    return Invoke-InCompanionModule -ScriptBlock {
        param($Policy)

        $config = [AdapterConfig]::new()
        $config.Game = 'example'
        $config.AdapterVersion = 2
        $config.DiffExcludePaths = $Policy.Paths
        $config.AmbientExtraPaths = $Policy.Ambient

        return $config
    } -ArgumentList $policy
}

function Test-CompareDigestsReportsCanonicalBuckets {
    $baseline = Read-DigestDocument -Json (New-DigestJson)
    $target = Read-DigestDocument -Json (New-DigestJson -GeneratedAt '2026-08-10T12:01:00.0000000Z' -SavedAt '2026-08-10T11:01:00.0000000Z' -SaveFile 'B.ntwtf.zip' -Level 2 -Xp 12 -Money 50 -Day 2 -Time '09:10' -Location 'other' -Extra '{"case":{"x":3,"X":2},"list":[2,1],"a/b":{"~key":2}}')
    $config = New-TestAdapterConfig
    try {
        $diff = Compare-Digests -Baseline $baseline -Target $target -AdapterConfig $config
        $root = $diff.RootElement
        Assert-True -Condition ((Invoke-InCompanionModule { param($Value) (Get-Property $Value hasChanges).GetBoolean() } -ArgumentList $root)) -Message 'represented changes set hasChanges'
        Assert-Equal -Actual $root.GetProperty('character').GetProperty('levelDelta').GetInt64() -Expected 1L -Message 'level delta is represented'
        Assert-Equal -Actual $root.GetProperty('character').GetProperty('moneyDelta').GetDecimal() -Expected ([decimal]-0.5) -Message 'money delta is decimal minor-unit difference'
        Assert-Equal -Actual $root.GetProperty('extraChanges').GetArrayLength() -Expected 3 -Message 'extra object and array leaves are represented'
        Assert-OrdinalEqual -Actual $root.GetProperty('extraChanges')[0].GetProperty('path').GetString() -Expected '/extra/a~1b/~0key' -Message 'RFC 6901 paths are ordinally sorted and escaped'
        Assert-True -Condition ($root.GetProperty('sessionChange').GetProperty('locationChanged').GetBoolean()) -Message 'session location movement is represented as a fact'
        Assert-DiffSemantics -Diff $diff -Baseline $baseline -Target $target -AdapterConfig $config
    }
    finally {
        $config.Dispose()
    }
}

function Test-MoneyExactness {
    $config = New-TestAdapterConfig
    try {
        for ($index = 0; $index -lt 3000; $index++) {
            $baselineCents = [long](($index * 104729L) % 2000001L - 1000000L)
            $targetCents = [long](($index * 130363L) % 2000001L - 1000000L)
            $baseline = Read-DigestDocument -Json (New-DigestJson -Money $baselineCents)
            $target = Read-DigestDocument -Json (New-DigestJson -Money $targetCents -GeneratedAt '2026-08-10T12:01:00.0000000Z')
            $diff = Compare-Digests -Baseline $baseline -Target $target -AdapterConfig $config
            $money = $diff.RootElement.GetProperty('character').GetProperty('moneyDelta')
            Assert-Equal -Actual $money.GetDecimal() -Expected (([decimal] $targetCents - [decimal] $baselineCents) / 100) -Message 'money delta is derived from integer minor-unit subtraction'
            $raw = $money.GetRawText()
            $point = $raw.IndexOf('.', [StringComparison]::Ordinal)
            Assert-True -Condition ($point -lt 0 -or $raw.Length - $point - 1 -le 2) -Message 'money delta serializes to no more than two decimals'
        }

        foreach ($pair in @(@([long]::MinValue, [long]::MaxValue), @([long]::MaxValue, [long]::MinValue))) {
            $baseline = Read-DigestDocument -Json (New-DigestJson -Money $pair[0])
            $target = Read-DigestDocument -Json (New-DigestJson -Money $pair[1] -GeneratedAt '2026-08-10T12:01:00.0000000Z')
            $diff = Compare-Digests -Baseline $baseline -Target $target -AdapterConfig $config
            Assert-Equal -Actual $diff.RootElement.GetProperty('character').GetProperty('moneyDelta').GetDecimal() -Expected (([decimal] $pair[1] - [decimal] $pair[0]) / 100) -Message 'Int64 endpoint minor-unit deltas do not overflow'
        }

        $baseline = Read-DigestDocument -Json (New-DigestJson -Extra '{"numeric":9007199254740992.0}')
        $target = Read-DigestDocument -Json (New-DigestJson -GeneratedAt '2026-08-10T12:01:00.0000000Z' -Extra '{"numeric":9007199254740993.0}')
        Assert-Equal -Actual (Compare-Digests -Baseline $baseline -Target $target -AdapterConfig $config).RootElement.GetProperty('extraChanges').GetArrayLength() -Expected 1 -Message 'adjacent Decimal values remain distinct when Double would collapse them'

        $baseline = Read-DigestDocument -Json (New-DigestJson -Extra '{"numeric":1.0}')
        $target = Read-DigestDocument -Json (New-DigestJson -GeneratedAt '2026-08-10T12:01:00.0000000Z' -Extra '{"numeric":1e0}')
        Assert-Equal -Actual (Compare-Digests -Baseline $baseline -Target $target -AdapterConfig $config).RootElement.GetProperty('extraChanges').GetArrayLength() -Expected 0 -Message 'numerically equal JSON lexemes compare equal'
    }
    finally {
        $config.Dispose()
    }
}

function Test-DiffSemanticRejection {
    $baseline = Read-DigestDocument -Json (New-DigestJson)
    $target = Read-DigestDocument -Json (New-DigestJson -GeneratedAt '2026-08-10T12:01:00.0000000Z')
    $config = New-TestAdapterConfig
    try {
        $reset = New-EmptyDiff -Target $target
        Assert-ThrowsType -TypeName 'CompanionDiffSemanticException' -Action { Assert-DiffSemantics -Diff $reset -Baseline $baseline -Target $target -AdapterConfig $config }
    }
    finally {
        $config.Dispose()
    }
}

function Test-ExclusionsAndAmbientPolicyAreIndependent {
    $baseline = Read-DigestDocument -Json (New-DigestJson)
    $target = Read-DigestDocument -Json (New-DigestJson -GeneratedAt '2026-08-10T12:01:00.0000000Z' -Extra '{"case":{"x":1,"X":2},"list":[2,1],"a/b":{"~key":1}}')
    $config = New-TestAdapterConfig -DiffExcludePaths @('/extra/list', '/extra/missing') -AmbientExtraPaths @('/extra/list')
    try {
        $sink = Invoke-InCompanionModule -ScriptBlock { New-CompanionWarningSink -Profile GetDiff }
        $diff = Compare-Digests -Baseline $baseline -Target $target -AdapterConfig $config -WarningSink $sink
        Assert-False -Condition $diff.RootElement.GetProperty('hasChanges').GetBoolean() -Message 'an effective exclusion removes represented extra change'
        Assert-True -Condition $diff.RootElement.GetProperty('hasUnrepresentedChanges').GetBoolean() -Message 'an effective exclusion preserves unrepresented change provenance'
        $warnings = Invoke-InCompanionModule -ScriptBlock { param($Value) Write-Output -NoEnumerate $Value.Freeze() } -ArgumentList $sink
        Assert-Equal -Actual $warnings.Count -Expected 1 -Message 'one ineffective exclusion creates one warning'
        Assert-OrdinalEqual -Actual $warnings[0].detail -Expected '/extra/missing' -Message 'unused warning names the unresolved pointer'
        Assert-True -Condition (Test-UneventfulDiff -Diff $diff -AdapterConfig $config) -Message 'ambient policy permits an excluded unrepresented-only diff'
        Assert-DiffSemantics -Diff $diff -Baseline $baseline -Target $target -AdapterConfig $config
    }
    finally {
        $config.Dispose()
    }
}

function Test-CompatibilityAndResetContracts {
    $baseline = Read-DigestDocument -Json (New-DigestJson)
    $currencyMismatch = Read-DigestDocument -Json ((New-DigestJson -GeneratedAt '2026-08-10T12:01:00.0000000Z').Replace('"currency":"real"', '"currency":"other"'))
    $config = New-TestAdapterConfig
    try {
        Assert-ThrowsType -TypeName 'CompanionDiffCompatibilityException' -Action { Compare-Digests -Baseline $baseline -Target $currencyMismatch -AdapterConfig $config }
        $reset = New-EmptyDiff -Target $baseline
        Assert-False -Condition $reset.RootElement.GetProperty('hasChanges').GetBoolean() -Message 'reset diff has no represented changes'
        Assert-True -Condition ($reset.RootElement.GetProperty('baselineGeneratedAt').ValueKind -eq [Text.Json.JsonValueKind]::Null) -Message 'reset diff has a null baseline timestamp'
        Assert-DiffSemantics -Diff $reset -Baseline $null -Target $baseline -AdapterConfig $config
    }
    finally {
        $config.Dispose()
    }
}

function Test-ObjectivesInventoryAndOmittedFields {
    $baselineJson = New-DigestJson
    $targetJson = $baselineJson.Replace('"status":"active"', '"status":"done"').Replace('"owned":["item"],"equipped":["item"],"highlights":[]', '"owned":["item","new"],"equipped":["new"],"highlights":["item"]')
    $baseline = Read-DigestDocument -Json $baselineJson
    $target = Read-DigestDocument -Json $targetJson
    $config = New-TestAdapterConfig
    try {
        $diff = Compare-Digests -Baseline $baseline -Target $target -AdapterConfig $config
        Assert-Equal -Actual $diff.RootElement.GetProperty('objectives').GetProperty('statusChanged').GetArrayLength() -Expected 1 -Message 'objective status changes are represented'
        Assert-Equal -Actual $diff.RootElement.GetProperty('inventory').GetProperty('gained').GetArrayLength() -Expected 1 -Message 'owned inventory gains are itemized'
        Assert-True -Condition $diff.RootElement.GetProperty('inventory').GetProperty('equippedChanged').GetBoolean() -Message 'equipped inventory change is retained as a fact'
        Assert-True -Condition $diff.RootElement.GetProperty('hasUnrepresentedChanges').GetBoolean() -Message 'highlight changes retain unrepresented provenance'
        Assert-DiffSemantics -Diff $diff -Baseline $baseline -Target $target -AdapterConfig $config
    }
    finally { $config.Dispose() }
}

function Test-OmittedFixedFieldsAreProvenanceOnly {
    $baselineJson = New-DigestJson
    $targetJson = $baselineJson.Replace('"playtimeNote":null', '"playtimeNote":"changed"').Replace('"unspentPoints":0', '"unspentPoints":1').Replace('"name":"health","value":1', '"name":"health","value":2').Replace('"group":"Intellect"', '"group":"Psyche"').Replace('"title":"example"', '"title":"changed"').Replace('"resolved":null', '"resolved":{"day":1,"time":"08:10"}')
    $baseline = Read-DigestDocument -Json $baselineJson
    $target = Read-DigestDocument -Json $targetJson
    $config = New-TestAdapterConfig
    try {
        $diff = Compare-Digests -Baseline $baseline -Target $target -AdapterConfig $config
        Assert-False -Condition $diff.RootElement.GetProperty('hasChanges').GetBoolean() -Message 'omitted fixed fields do not manufacture represented changes'
        Assert-True -Condition $diff.RootElement.GetProperty('hasUnrepresentedChanges').GetBoolean() -Message 'omitted fixed field changes preserve provenance'
    }
    finally { $config.Dispose() }
}

function Test-DiffAdmissionRecomputesRepresentedFlag {
    $baseline = Read-DigestDocument -Json (New-DigestJson)
    $target = Read-DigestDocument -Json (New-DigestJson -GeneratedAt '2026-08-10T12:01:00.0000000Z' -Xp 1)
    $config = New-TestAdapterConfig
    try {
        $diff = Compare-Digests -Baseline $baseline -Target $target -AdapterConfig $config
        $invalid = ConvertTo-CompanionJson -InputObject ([ordered]@{ schemaVersion = 2L; adapterVersion = 2L; game = 'example'; hasChanges = $false; hasUnrepresentedChanges = $false; baselineGeneratedAt = $baseline.RootElement.GetProperty('generatedAt').GetString(); currentGeneratedAt = $target.RootElement.GetProperty('generatedAt').GetString(); currentSource = $target.RootElement.GetProperty('source').Clone(); sessionChange = $null; objectives = [ordered]@{ added = @(); removed = @(); statusChanged = @() }; character = [ordered]@{ levelDelta = 0L; xpDelta = 1L; moneyDelta = [decimal]0; skillChanges = @() }; inventory = [ordered]@{ gained = @(); lost = @(); equippedChanged = $false }; extraChanges = @() }) -Budget diff
        Assert-ThrowsType -TypeName 'CompanionDocumentValidationException' -Action { Read-DiffDocument -Json $invalid }
    }
    finally { $config.Dispose() }
}

function Test-ExcludePointerResolutionUsesRawDiffAddressability {
    $baseline = Read-DigestDocument -Json (New-DigestJson -Extra '{"branch":{"old":{"value":1}},"list":[1],"Case":1}')
    $target = Read-DigestDocument -Json (New-DigestJson -GeneratedAt '2026-08-10T12:01:00.0000000Z' -Extra '{"branch":{"new":{"value":2}},"list":{"child":1},"case":1}')
    $config = New-TestAdapterConfig -DiffExcludePaths @('/extra/branch/new/value', '/extra/list/child', '/extra/case', '/extra/missing', '/extra/branch')
    try {
        $sink = Invoke-InCompanionModule -ScriptBlock { New-CompanionWarningSink -Profile GetDiff }
        $diff = Compare-Digests -Baseline $baseline -Target $target -AdapterConfig $config -WarningSink $sink
        $warnings = Invoke-InCompanionModule -ScriptBlock { param($Value) Write-Output -NoEnumerate $Value.Freeze() } -ArgumentList $sink
        Assert-Equal -Actual $warnings.Count -Expected 2 -Message 'atomic and missing paths are the only unresolved exclusions'
        Assert-True -Condition $diff.RootElement.GetProperty('hasUnrepresentedChanges').GetBoolean() -Message 'resolved ancestor exclusion retains provenance'
        Assert-Equal -Actual $diff.RootElement.GetProperty('extraChanges').GetArrayLength() -Expected 2 -Message 'only the effective ancestor branch and exact-case path are filtered'
    }
    finally { $config.Dispose() }
}

function Test-ExtraTypeTransitionsAndObjectiveCompositeKeys {
    $baseline = Read-DigestDocument -Json (New-DigestJson -Extra '{"scalar":1,"array":[1],"null":null}')
    $target = Read-DigestDocument -Json (New-DigestJson -GeneratedAt '2026-08-10T12:01:00.0000000Z' -Extra '{"scalar":[1],"array":1,"null":{"value":1}}')
    $config = New-TestAdapterConfig
    try {
        $diff = Compare-Digests -Baseline $baseline -Target $target -AdapterConfig $config
        $changes = @($diff.RootElement.GetProperty('extraChanges').EnumerateArray())
        Assert-Equal -Actual $changes.Count -Expected 3 -Message 'scalar, array, and null type transitions each remain atomic extra changes'
        Assert-True -Condition (@($changes | Where-Object { $_.GetProperty('path').GetString() -eq '/extra/scalar' }).Count -eq 1) -Message 'scalar to array retains its own pointer'
        Assert-True -Condition (@($changes | Where-Object { $_.GetProperty('path').GetString() -eq '/extra/array' }).Count -eq 1) -Message 'array to scalar retains its own pointer'
        Assert-True -Condition (@($changes | Where-Object { $_.GetProperty('path').GetString() -eq '/extra/null' }).Count -eq 1) -Message 'null to object retains its own pointer'
    }
    finally { $config.Dispose() }
}

function Test-ObjectiveCompositeKeyKeepsTopLevelAndChildCollisions {
    $baselineObjective = '"id":"TASK.example","title":"example","status":"active","acquired":{"day":1,"time":"08:09"},"resolved":null,"subobjectives":[]'
    $baselineReplacement = '"id":"TASK.shared","title":"top","status":"active","acquired":{"day":1,"time":"08:09"},"resolved":null,"subobjectives":[{"id":"TASK.shared","title":"child","status":"active","acquired":{"day":1,"time":"08:09"},"resolved":null,"subobjectives":null}]'
    $targetReplacement = '"id":"TASK.shared","title":"top","status":"done","acquired":{"day":1,"time":"08:09"},"resolved":null,"subobjectives":[{"id":"TASK.shared","title":"child","status":"done","acquired":{"day":1,"time":"08:09"},"resolved":null,"subobjectives":null}]'
    $baseline = Read-DigestDocument -Json ((New-DigestJson).Replace($baselineObjective, $baselineReplacement))
    $target = Read-DigestDocument -Json ((New-DigestJson -GeneratedAt '2026-08-10T12:01:00.0000000Z').Replace($baselineObjective, $targetReplacement))
    $config = New-TestAdapterConfig
    try {
        $diff = Compare-Digests -Baseline $baseline -Target $target -AdapterConfig $config
        $changes = @($diff.RootElement.GetProperty('objectives').GetProperty('statusChanged').EnumerateArray())
        Assert-Equal -Actual $changes.Count -Expected 2 -Message 'same id at top level and under a parent creates two composite-key changes'
        Assert-True -Condition (@($changes | Where-Object { $_.GetProperty('parentId').ValueKind -eq [Text.Json.JsonValueKind]::Null }).Count -eq 1) -Message 'top-level collision member is retained'
        Assert-True -Condition (@($changes | Where-Object { $_.GetProperty('parentId').GetString() -eq 'TASK.shared' }).Count -eq 1) -Message 'subobjective collision member is retained'
    }
    finally { $config.Dispose() }
}

$tests = [ordered]@{
    CanonicalBuckets = ${function:Test-CompareDigestsReportsCanonicalBuckets}
    Exclusions = ${function:Test-ExclusionsAndAmbientPolicyAreIndependent}
    Compatibility = ${function:Test-CompatibilityAndResetContracts}
    Objectives = ${function:Test-ObjectivesInventoryAndOmittedFields}
    OmittedFields = ${function:Test-OmittedFixedFieldsAreProvenanceOnly}
    RepresentedFlag = ${function:Test-DiffAdmissionRecomputesRepresentedFlag}
    PointerResolution = ${function:Test-ExcludePointerResolutionUsesRawDiffAddressability}
    ExtraTransitions = ${function:Test-ExtraTypeTransitionsAndObjectiveCompositeKeys}
    ObjectiveCollisions = ${function:Test-ObjectiveCompositeKeyKeepsTopLevelAndChildCollisions}
    MoneyExactness = ${function:Test-MoneyExactness}
    SemanticRejection = ${function:Test-DiffSemanticRejection}
}

if ($Only -eq 'All') {
    foreach ($test in $tests.Values) {
        & $test
    }
}
else {
    & $tests[$Only]
}

Write-Output 'PASS: Diff engine'
