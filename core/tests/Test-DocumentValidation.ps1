#Requires -Version 7.5

[CmdletBinding()]
param(
    [Parameter()]
    [ValidateSet('All', 'DigestAdmission', 'DiffAdmission', 'DocumentEmission', 'SourceIdentity', 'WarningSink', 'NullDetailWarning', 'DuplicateSurfaceMatrix', 'SchemaMirror')]
    [string] $Only = 'All'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Import-Module (Join-Path (Split-Path $PSScriptRoot -Parent) 'DigestDiff.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'TestSupport.psm1') -Force

$script:DigestJson = @'
{"schemaVersion":2,"adapterVersion":2,"game":"example","generatedAt":"2026-08-10T12:00:00.0000000Z","source":{"domainId":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef","saveFile":"B.ntwtf.zip","savedAt":"2026-08-10T11:00:00.0000000Z","byteLength":1,"contentSha256":"abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd"},"session":{"day":1,"time":"08:09","location":"place","playtimeNote":null},"character":{"level":1,"xp":0,"unspentPoints":0,"money":{"amount":1.25,"minorUnits":125,"minorUnitsPerUnit":100,"currency":"real"},"vitals":[{"name":"health","value":1}],"skills":[{"name":"Logic","value":1,"group":"Intellect"}]},"objectives":[{"id":"TASK.example","title":"example","status":"active","acquired":{"day":1,"time":"08:09"},"resolved":null,"subobjectives":[]}],"inventory":{"owned":["item"],"equipped":["item"],"highlights":[]},"extra":{"case":{"x":1,"X":2}}}
'@

$script:DiffJson = @'
{"schemaVersion":2,"adapterVersion":2,"game":"example","hasChanges":false,"hasUnrepresentedChanges":false,"baselineGeneratedAt":null,"currentGeneratedAt":"2026-08-10T12:00:00.0000000Z","currentSource":{"domainId":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef","saveFile":"B.ntwtf.zip","savedAt":"2026-08-10T11:00:00.0000000Z","byteLength":1,"contentSha256":"abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd"},"sessionChange":null,"objectives":{"added":[],"removed":[],"statusChanged":[]},"character":{"levelDelta":0,"xpDelta":0,"moneyDelta":0,"skillChanges":[]},"inventory":{"gained":[],"lost":[],"equippedChanged":false},"extraChanges":[]}
'@

function Test-DigestAdmissionIsExact {
    $document = @(Read-DigestDocument -Json $script:DigestJson)[-1]
    Assert-True -Condition ($null -ne $document.RootElement) -Message 'valid digest returns an admitted JSON document'
    foreach ($invalid in @(
            $script:DigestJson.Replace('"game":"example",', ''),
            $script:DigestJson.Replace('"game":"example"', '"game":"example","unexpected":true'),
            $script:DigestJson.Replace('"byteLength":1', '"byteLength":0'),
            $script:DigestJson.Replace('"saveFile":"B.ntwtf.zip"', '"saveFile":"folder/B.ntwtf.zip"'),
            $script:DigestJson.Replace('"amount":1.25', '"amount":1.24'),
            $script:DigestJson.Replace('"generatedAt":"2026-08-10T12:00:00.0000000Z"', '"generatedAt":"2026-08-10T12:00:00Z"'),
            $script:DigestJson.Replace('"item"],"equipped"', '"item","item"],"equipped"'))) {
        Assert-ThrowsType -TypeName 'CompanionDocumentValidationException' -Action { Read-DigestDocument -Json $invalid }
    }
}

function Test-DiffAdmissionIsExact {
    $document = @(Read-DiffDocument -Json $script:DiffJson)[-1]
    Assert-True -Condition ($null -ne $document.RootElement) -Message 'valid diff returns an admitted JSON document'
    foreach ($invalid in @(
            $script:DiffJson.Replace('"hasChanges":false', '"hasChanges":true'),
            $script:DiffJson.Replace('"extraChanges":[]', '"extraChanges":[{"path":"/extra/x","fromPresent":false,"toPresent":false,"from":null,"to":null}]'),
            $script:DiffJson.Replace('"currentSource":{', '"currentSource":{"unexpected":1,'),
            $script:DiffJson.Replace('"moneyDelta":0', '"moneyDelta":"0"'))) {
        Assert-ThrowsType -TypeName 'CompanionDocumentValidationException' -Action { Read-DiffDocument -Json $invalid }
    }
}

function Test-SuccessfulAdmissionEmitsOnlyTheDocument {
    $digestValues = @(Read-DigestDocument -Json $script:DigestJson)
    $diffValues = @(Read-DiffDocument -Json $script:DiffJson)
    Assert-Equal -Actual $digestValues.Count -Expected 1 -Message 'digest admission emits exactly one pipeline value'
    Assert-Equal -Actual $diffValues.Count -Expected 1 -Message 'diff admission emits exactly one pipeline value'
    Assert-True -Condition ($null -ne $digestValues[0].RootElement -and $null -ne $diffValues[0].RootElement) -Message 'the sole values are admitted documents'
}

function Test-SourceIdentityOrdering {
    $left = [pscustomobject]@{ domainId = 'a'; saveFile = 'B.ntwtf.zip'; savedAt = [datetime]::Parse('2026-08-10T11:00:00.0000000Z', [cultureinfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind) }
    $right = [pscustomobject]@{ domainId = 'a'; saveFile = 'A.ntwtf.zip'; savedAt = $left.savedAt }
    $result = Compare-SourceIdentity -Left $left -Right $right
    Assert-True -Condition $result.comparable -Message 'same domain identities are comparable'
    Assert-Equal -Actual $result.order -Expected 1 -Message 'ordinally later filename is newer on an equal timestamp'
    $other = [pscustomobject]@{ domainId = 'b'; saveFile = 'A.ntwtf.zip'; savedAt = $left.savedAt }
    $incomparable = Compare-SourceIdentity -Left $left -Right $other
    Assert-False -Condition $incomparable.comparable -Message 'different domains are incomparable'
    Assert-True -Condition ($null -eq $incomparable.order) -Message 'incomparable source ordering is null'
}

function Test-WarningSinkIsProfileBoundAndImmutable {
    $sink = Invoke-InCompanionModule -ScriptBlock { New-CompanionWarningSink -Profile Cycle }
    Invoke-InCompanionModule -ScriptBlock { param($Value) $Value.Add('pipeline-baseline-absent', $null) } -ArgumentList $sink
    Invoke-InCompanionModule -ScriptBlock { param($Value) $Value.Add('pipeline-baseline-absent', $null) } -ArgumentList $sink
    $warnings = Invoke-InCompanionModule -ScriptBlock { param($Value) Write-Output -NoEnumerate $Value.Freeze() } -ArgumentList $sink
    Assert-Equal -Actual $warnings.Count -Expected 1 -Message 'warning sink deduplicates ordinal code-detail pairs'
    $frozenAgain = Invoke-InCompanionModule -ScriptBlock { param($Value) Write-Output -NoEnumerate $Value.Freeze() } -ArgumentList $sink
    Assert-True -Condition ([object]::ReferenceEquals($warnings, $frozenAgain)) -Message 'freeze returns a stable wrapper'
    Assert-ThrowsType -TypeName 'CompanionDocumentValidationException' -Action { Invoke-InCompanionModule -ScriptBlock { param($Value) Add-CompanionWarning -Sink $Value -Code 'walk-max-saves-clamped' -Detail $null } -ArgumentList $sink }
    Assert-ThrowsType -TypeName 'CompanionDocumentValidationException' -Action { Invoke-InCompanionModule -ScriptBlock { param($Value) Add-CompanionWarning -Sink $Value -Code 'pipeline-baseline-absent' -Detail $null } -ArgumentList $sink }
}

function Test-NullDetailWarningStoresNullAndSurvivesRoundTrip {
    $sink = Invoke-InCompanionModule -ScriptBlock { New-CompanionWarningSink -Profile TurnAttempt }
    Invoke-InCompanionModule -ScriptBlock { param($Value) Add-CompanionWarning -Sink $Value -Code 'pipeline-current-self-healed' -Detail $null } -ArgumentList $sink
    $warnings = Invoke-InCompanionModule -ScriptBlock { param($Value) Write-Output -NoEnumerate $Value.Freeze() } -ArgumentList $sink
    Assert-Equal -Actual $warnings.Count -Expected 1 -Message 'null-detail self-healed warning is stored once'
    Assert-True -Condition ($null -eq $warnings[0].detail) -Message 'null-detail warning stores null detail, not the empty string'

    # Replay the warning through the envelope code/detail shape to prove a null detail
    # re-admits exactly once rather than failing the null-detail admission restriction.
    $replayed = Invoke-InCompanionModule -ScriptBlock { New-CompanionWarningSink -Profile TurnAttempt }
    Invoke-InCompanionModule -ScriptBlock { param($Sink, $Code, $Detail) Add-CompanionWarning -Sink $Sink -Code $Code -Detail $Detail } -ArgumentList $replayed, $warnings[0].code, $warnings[0].detail
    $replayedWarnings = Invoke-InCompanionModule -ScriptBlock { param($Value) Write-Output -NoEnumerate $Value.Freeze() } -ArgumentList $replayed
    Assert-Equal -Actual $replayedWarnings.Count -Expected 1 -Message 'null-detail self-healed warning survives a round trip exactly once'
    Assert-True -Condition ($null -eq $replayedWarnings[0].detail) -Message 'round-tripped null-detail warning retains null detail'
}

function Get-SectionBody {
    param([Parameter(Mandatory)] [string] $Text, [Parameter(Mandatory)] [string] $Heading)

    $lines = $Text.Split("`n")
    $start = -1
    for ($index = 0; $index -lt $lines.Length; $index++) {
        if ($lines[$index].StartsWith($Heading, [System.StringComparison]::Ordinal)) { $start = $index; break }
    }
    if ($start -lt 0) { return $null }

    $body = [System.Collections.Generic.List[string]]::new()
    for ($index = $start + 1; $index -lt $lines.Length; $index++) {
        if ($lines[$index] -match '^### [0-9]+\.' -or $lines[$index] -match '^## [0-9]+\.') { break }
        $body.Add($lines[$index])
    }

    # Normalize only the section's final newline: drop trailing blank lines so a
    # lone terminal newline before the next heading is not treated as content.
    while ($body.Count -gt 0 -and $body[$body.Count - 1] -eq '') { $body.RemoveAt($body.Count - 1) }

    return ($body -join "`n")
}

function Test-SchemaMirror {
    $specPath = Join-Path (Split-Path $PSScriptRoot -Parent) '../.nightshift/features/state-extraction.md'
    $schemaPath = Join-Path (Split-Path $PSScriptRoot -Parent) 'digest-schema.md'
    $specBytes = [IO.File]::ReadAllBytes($specPath)
    $schemaBytes = [IO.File]::ReadAllBytes($schemaPath)
    $specText = [Text.UTF8Encoding]::new($false, $true).GetString($specBytes)
    $schemaText = [Text.UTF8Encoding]::new($false, $true).GetString($schemaBytes)

    foreach ($section in @('### 6.1 Digest schema', '### 7.2 Diff shape')) {
        $specBody = Get-SectionBody -Text $specText -Heading $section
        $schemaBody = Get-SectionBody -Text $schemaText -Heading $section
        Assert-True -Condition ($null -ne $specBody -and $null -ne $schemaBody) -Message "mirror sections $section are present in both files"
        Assert-OrdinalEqual -Actual $schemaBody -Expected $specBody -Message "schema section $section mirrors the spec case-sensitively (final-newline normalized)"
    }
}

function Test-DuplicatePropertiesFailAtDigestAndDiffSurfaces {
    foreach ($invalidDigest in @(
            $script:DigestJson.Replace('"day":1,"time"', '"day":1,"day":2,"time"'),
            $script:DigestJson.Replace('"x":1,"X":2', '"x":1,"x":2'))) {
        $caught = $null
        try { Read-DigestDocument -Json $invalidDigest } catch { $caught = $_.Exception }
        Assert-True -Condition ($null -ne $caught -and $caught.GetType().Name -in @('CompanionJsonParseException', 'CompanionDocumentValidationException')) -Message 'digest duplicate reaches the fail-closed content boundary'
    }

    foreach ($invalidDiff in @(
            $script:DiffJson.Replace('"extraChanges":[]', '"extraChanges":[{"path":"/extra/x","fromPresent":true,"toPresent":false,"from":{"x":1,"x":2},"to":null}]'),
            $script:DiffJson.Replace('"extraChanges":[]', '"extraChanges":[{"path":"/extra/x","fromPresent":false,"toPresent":true,"from":null,"to":{"x":1,"\\u0078":2}}]'))) {
        $caught = $null
        try { Read-DiffDocument -Json $invalidDiff } catch { $caught = $_.Exception }
        Assert-True -Condition ($null -ne $caught -and $caught.GetType().Name -in @('CompanionJsonParseException', 'CompanionDocumentValidationException')) -Message 'diff duplicate reaches the fail-closed content boundary'
    }
}

$tests = [ordered]@{
    DigestAdmission = ${function:Test-DigestAdmissionIsExact}
    DiffAdmission = ${function:Test-DiffAdmissionIsExact}
    DocumentEmission = ${function:Test-SuccessfulAdmissionEmitsOnlyTheDocument}
    SourceIdentity = ${function:Test-SourceIdentityOrdering}
    WarningSink = ${function:Test-WarningSinkIsProfileBoundAndImmutable}
    NullDetailWarning = ${function:Test-NullDetailWarningStoresNullAndSurvivesRoundTrip}
    DuplicateSurfaceMatrix = ${function:Test-DuplicatePropertiesFailAtDigestAndDiffSurfaces}
    SchemaMirror = ${function:Test-SchemaMirror}
}

if ($Only -eq 'All') {
    foreach ($test in $tests.Values) {
        & $test
    }
}
else {
    & $tests[$Only]
}

Write-Output 'PASS: Document validation'
