#Requires -Version 7.5

[CmdletBinding()]
param(
    [Parameter()]
    [ValidateSet('All', 'WarningAndAge', 'ResultProtocol', 'FoundResultSemantics', 'NoStateOnConfigFailure', 'DuplicateSurfaceMatrix', 'AmbientWalkPast')]
    [string] $Only = 'All'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

Import-Module (Join-Path $PSScriptRoot 'TestSupport.psm1') -Force
$coreRoot = Split-Path $PSScriptRoot -Parent
Import-Module (Join-Path $coreRoot 'DigestDiff.psm1') -Force

# Arrange
$validWarnings = '[{"code":"walk-max-saves-clamped","detail":null}]'

# Act
$warnings = @(Read-WalkWarningArray -Json $validWarnings)

# Assert
Assert-Equal -Expected 1 -Actual $warnings.Count -Message 'The walk warning reader retains one warning.'
Assert-Equal -Expected 'walk-max-saves-clamped' -Actual $warnings[0].code -Message 'The walk warning reader preserves the code.'
Assert-ThrowsType -TypeName 'CompanionDocumentValidationException' -Action { Read-WalkWarningArray -Json '[{"code":"walk-max-saves-clamped","detail":"unexpected"}]' }

# Arrange
$newest = [datetime]'2026-08-10T12:00:00.0000000Z'
$atBoundary = [datetime]'2026-08-07T12:00:00.0000000Z'
$beyondBoundary = $atBoundary.AddTicks(-1)

# Act
$atBoundaryIsOld = Invoke-InCompanionModule -ScriptBlock { param($Newest, $Candidate) Test-WalkOverAge -Newest $Newest -Candidate $Candidate -MaxAgeHours 72 } -ArgumentList $newest, $atBoundary
$beyondBoundaryIsOld = Invoke-InCompanionModule -ScriptBlock { param($Newest, $Candidate) Test-WalkOverAge -Newest $Newest -Candidate $Candidate -MaxAgeHours 72 } -ArgumentList $newest, $beyondBoundary

# Assert
Assert-False -Condition $atBoundaryIsOld -Message 'An exact age boundary remains eligible.'
Assert-True -Condition $beyondBoundaryIsOld -Message 'One tick beyond the age boundary stops traversal.'
if ($Only -eq 'WarningAndAge') {
    Write-Output 'PASS: walk'
    exit 0
}

# Arrange
$baselineIdentity = [pscustomobject]@{ domainId = ('a' * 64); saveFile = 'older.ntwtf.zip'; savedAt = '2026-08-10T10:00:00.0000000Z' }
$targetIdentity = [pscustomobject]@{ domainId = ('a' * 64); saveFile = 'newer.ntwtf.zip'; savedAt = '2026-08-10T11:00:00.0000000Z' }

# Act
$receipt = Invoke-InCompanionModule -ScriptBlock { param($Baseline, $Target) [WalkPairReceipt]::new(1, 0, $Baseline, $Target, $false) } -ArgumentList $baselineIdentity, $targetIdentity

# Assert
Assert-Equal -Expected 1 -Actual $receipt.BaselineIndex -Message 'A receipt records its adjacent baseline index.'
Assert-ThrowsType -TypeName 'ArgumentException' -Action { Invoke-InCompanionModule -ScriptBlock { param($Baseline, $Target) [WalkPairReceipt]::new(2, 0, $Baseline, $Target, $false) } -ArgumentList $baselineIdentity, $targetIdentity }

# Arrange
$config = Invoke-InCompanionModule -ScriptBlock {
    $value = [AdapterConfig]::new()
    $value.Game = 'example'
    $value.AdapterVersion = 2L
    $value.SourceDomainId = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
    $value.WalkPolicyId = 'abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd'
    $value.DiffExcludePaths = @()
    $value.AmbientExtraPaths = @()

    return $value
}
$dry = '{"provenance":{"game":"example","adapterVersion":2,"sourceDomainId":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef","walkPolicyId":"abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd"},"found":false,"walkedSaves":0,"boundHit":"exhausted","span":null,"diff":null}'

try {
    # Act
    $dryResult = Read-WalkResultDocument -Json $dry -EffectiveMaxSaves 2 -AdapterConfig $config

    # Assert
    Assert-False -Condition $dryResult.RootElement.GetProperty('found').GetBoolean() -Message 'A zero-save exhausted walk is a valid dry result.'
Assert-ThrowsType -TypeName 'CompanionDocumentValidationException' -Action { Read-WalkResultDocument -Json ($dry.Replace('"boundHit":"exhausted"', '"boundHit":"saves"')) -EffectiveMaxSaves 2 -AdapterConfig $config }
}
finally {
    $config.Dispose()
}
if ($Only -eq 'DuplicateSurfaceMatrix') {
    $duplicateWalk = $dry.Replace('"found":false', '"found":false,"found":false')
    $duplicateConfig = Invoke-InCompanionModule -ScriptBlock {
        $value = [AdapterConfig]::new()
        $value.Game = 'example'
        $value.AdapterVersion = 2L
        $value.SourceDomainId = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
        $value.WalkPolicyId = 'abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd'
        $value.DiffExcludePaths = @()
        $value.AmbientExtraPaths = @()
        return $value
    }
    try {
        Assert-ThrowsType -TypeName 'CompanionDocumentValidationException' -Action { Read-WalkResultDocument -Json $duplicateWalk -EffectiveMaxSaves 2 -AdapterConfig $duplicateConfig }
    }
    finally {
        $duplicateConfig.Dispose()
    }
    Write-Output 'PASS: walk'
    exit 0
}
if ($Only -eq 'ResultProtocol') {
    Write-Output 'PASS: walk'
    exit 0
}

function New-WalkTestDigest {
    param([Parameter(Mandatory)] [string] $SaveFile, [Parameter(Mandatory)] [string] $SavedAt, [Parameter(Mandatory)] [long] $Xp, [Parameter()] [string] $GeneratedAt = '2026-08-10T12:00:00.0000000Z')

    return "{`"schemaVersion`":2,`"adapterVersion`":2,`"game`":`"example`",`"generatedAt`":`"$GeneratedAt`",`"source`":{`"domainId`":`"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef`",`"saveFile`":`"$SaveFile`",`"savedAt`":`"$SavedAt`",`"byteLength`":1,`"contentSha256`":`"abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd`"},`"session`":{`"day`":1,`"time`":`"08:09`",`"location`":`"place`",`"playtimeNote`":null},`"character`":{`"level`":1,`"xp`":$Xp,`"unspentPoints`":0,`"money`":{`"amount`":1,`"minorUnits`":100,`"minorUnitsPerUnit`":100,`"currency`":`"real`"},`"vitals`": [{`"name`":`"health`",`"value`":1}],`"skills`": [{`"name`":`"Logic`",`"value`":1,`"group`":`"Intellect`"}]},`"objectives`": [{`"id`":`"TASK.example`",`"title`":`"example`",`"status`":`"active`",`"acquired`":{`"day`":1,`"time`":`"08:09`"},`"resolved`":null,`"subobjectives`":[]}],`"inventory`":{`"owned`": [`"item`"],`"equipped`": [`"item`"],`"highlights`":[]},`"extra`":{}}"
}

# Arrange
$eventfulConfig = Invoke-InCompanionModule -ScriptBlock {
    $value = [AdapterConfig]::new()
    $value.Game = 'example'
    $value.AdapterVersion = 2L
    $value.SourceDomainId = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
    $value.WalkPolicyId = 'abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd'
    $value.DiffExcludePaths = @()
    $value.AmbientExtraPaths = @()

    return $value
}
$eventfulBaseline = Read-DigestDocument -Json (New-WalkTestDigest -SaveFile 'older.ntwtf.zip' -SavedAt '2026-08-10T10:00:00.0000000Z' -Xp 0)
$eventfulTarget = Read-DigestDocument -Json (New-WalkTestDigest -SaveFile 'newer.ntwtf.zip' -SavedAt '2026-08-10T11:00:00.0000000Z' -Xp 1 -GeneratedAt '2026-08-10T12:01:00.0000000Z')

try {
    # Act
    $eventfulDiff = Compare-Digests -Baseline $eventfulBaseline -Target $eventfulTarget -AdapterConfig $eventfulConfig
    $eventfulResult = [ordered]@{
        provenance = [ordered]@{ game = 'example'; adapterVersion = 2L; sourceDomainId = $eventfulConfig.SourceDomainId; walkPolicyId = $eventfulConfig.WalkPolicyId }
        found = $true
        walkedSaves = 2L
        boundHit = $null
        span = [ordered]@{
            from = [ordered]@{ domainId = $eventfulConfig.SourceDomainId; saveFile = 'older.ntwtf.zip'; savedAt = '2026-08-10T10:00:00.0000000Z' }
            to = [ordered]@{ domainId = $eventfulConfig.SourceDomainId; saveFile = 'newer.ntwtf.zip'; savedAt = '2026-08-10T11:00:00.0000000Z' }
        }
        diff = $eventfulDiff.RootElement.Clone()
    }
    $eventfulJson = ConvertTo-CompanionJson -InputObject $eventfulResult -Budget diff
    $eventfulDocument = Read-WalkResultDocument -Json $eventfulJson -EffectiveMaxSaves 3 -AdapterConfig $eventfulConfig
    $evidence = Invoke-InCompanionModule -ArgumentList @($eventfulBaseline, $eventfulTarget, $eventfulDiff, $eventfulConfig) -ScriptBlock {
        param($Baseline, $Target, $Diff, $Config)
        [WalkTraversalEvidence]::new(@($Target.RootElement.GetProperty('source'), $Baseline.RootElement.GetProperty('source')), 3, 72, @((New-WalkPairReceipt -BaselineIndex 1 -TargetIndex 0 -BaselineSource ([pscustomobject]@{ digest = $Baseline; sourceIdentity = $Baseline.RootElement.GetProperty('source') }) -TargetSource ([pscustomobject]@{ digest = $Target; sourceIdentity = $Target.RootElement.GetProperty('source') }) -Diff $Diff -AdapterConfig $Config)))
    }

    # Assert
    Assert-True -Condition $eventfulDocument.RootElement.GetProperty('found').GetBoolean() -Message 'An eventful adjacent pair produces a found result.'
    Invoke-InCompanionModule -ArgumentList @($eventfulDocument, $evidence, $eventfulConfig) -ScriptBlock { param($Document, $Evidence, $Config) Assert-WalkResultSemantics -Result $Document -TraversalEvidence $Evidence -AdapterConfig $Config }
    Assert-ThrowsType -TypeName 'CompanionDocumentValidationException' -Action {
        Invoke-InCompanionModule -ArgumentList @($eventfulDocument, $evidence, $eventfulConfig) -ScriptBlock { param($Document, $Evidence, $Config) $Evidence.Receipts[0].TargetIndex = 1; Assert-WalkResultSemantics -Result $Document -TraversalEvidence $Evidence -AdapterConfig $Config }
    }
}
finally {
    $eventfulConfig.Dispose()
}
if ($Only -eq 'FoundResultSemantics') {
    Write-Output 'PASS: walk'
    exit 0
}

# Immediate-age dry walk: the newest save's immediate predecessor is already over the
# age bound, so the walk stops with boundHit 'age' and walkedSaves 0. The closing
# semantics re-check must validate against the over-age predecessor (Candidates[1]),
# not the newest candidate itself.
$ageConfig = Invoke-InCompanionModule -ScriptBlock {
    $value = [AdapterConfig]::new()
    $value.Game = 'example'
    $value.AdapterVersion = 2L
    $value.SourceDomainId = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
    $value.WalkPolicyId = 'abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd'
    $value.DiffExcludePaths = @()
    $value.AmbientExtraPaths = @()

    return $value
}
$ageDry = '{"provenance":{"game":"example","adapterVersion":2,"sourceDomainId":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef","walkPolicyId":"abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd"},"found":false,"walkedSaves":0,"boundHit":"age","span":null,"diff":null}'
try {
    $ageDocument = Read-WalkResultDocument -Json $ageDry -EffectiveMaxSaves 2 -AdapterConfig $ageConfig
    Invoke-InCompanionModule -ArgumentList @($ageDocument, $ageConfig) -ScriptBlock {
        param($Document, $Config)

        $candidates = @(
            [ordered]@{ domainId = $Config.SourceDomainId; saveFile = 'newest.ntwtf.zip'; savedAt = '2026-08-10T12:00:00.0000000Z' }
            [ordered]@{ domainId = $Config.SourceDomainId; saveFile = 'oldest.ntwtf.zip'; savedAt = '2026-08-06T12:00:00.0000000Z' }
        )
        Assert-WalkResultSemantics -Result $Document -TraversalEvidence ([WalkTraversalEvidence]::new($candidates, 2, 72, @())) -AdapterConfig $Config
    }
}
finally {
    $ageConfig.Dispose()
}

if ($Only -eq 'AmbientWalkPast') {
    function Assert-SingleWalkJson {
        param([Parameter(Mandatory)] [AllowEmptyString()] [string] $Text, [Parameter(Mandatory)] [string] $Message)

        try {
            $value = $Text | ConvertFrom-Json -AsHashtable -DateKind String -ErrorAction Stop
        } catch {
            throw [System.InvalidOperationException]::new("Assertion failed: $Message. Output could not be parsed as JSON: $($_.Exception.Message)")
        }

        Assert-True -Condition ($value -is [hashtable]) -Message $Message

        return $value
    }

    $stubRoot = New-ScratchCompanionRoot -Prefix 'walk-ambient'
    $stubCore = Join-Path $stubRoot 'core'
    $stubSaves = Join-Path $stubRoot 'saves'
    $stubAdapter = Join-Path $stubRoot 'adapters/stub'
    $stubPkgCore = Join-Path $stubAdapter 'releases/2/schema-2/core'
    $stubPkgAdapter = Join-Path $stubAdapter 'releases/2/schema-2/adapters/stub'
    [void] [IO.Directory]::CreateDirectory($stubCore)
    [void] [IO.Directory]::CreateDirectory($stubSaves)
    [void] [IO.Directory]::CreateDirectory($stubPkgCore)
    [void] [IO.Directory]::CreateDirectory($stubPkgAdapter)
    # The walk entry script runs from a scratch core sibling so its default
    # companion root (Split-Path $PSScriptRoot -Parent) is the stub root and its
    # module import resolves beside it; the adapter package lives under the stub
    # adapter's release root at {artifactRoot}.
    Copy-Item -LiteralPath (Join-Path $coreRoot 'Find-LastEventfulSpan.ps1') -Destination (Join-Path $stubCore 'Find-LastEventfulSpan.ps1')
    Copy-Item -LiteralPath (Join-Path $coreRoot 'DigestDiff.psm1') -Destination (Join-Path $stubCore 'DigestDiff.psm1')
    Copy-Item -LiteralPath (Join-Path $coreRoot 'EntryFence.psm1') -Destination (Join-Path $stubCore 'EntryFence.psm1')
    Copy-Item -LiteralPath (Join-Path $coreRoot 'private') -Destination (Join-Path $stubCore 'private') -Recurse

    # The walk resolves {artifactRoot} beneath the stub adapter's release root. The
    # packaged stub mapper keeps the companion-shaped ..\..\core\DigestDiff.psm1
    # import so the in-release relative path is exercised, but it builds its digest
    # with built-ins only, so the release-local module is an empty placeholder.
    $packagedDump = @'
param([string] $Save, [string] $Dump)
[System.IO.File]::Copy($Save, $Dump, $true)
'@
    [IO.File]::WriteAllText((Join-Path $stubPkgAdapter 'stub-dump.ps1'), $packagedDump.TrimStart("`r", "`n"), [Text.UTF8Encoding]::new($false, $true))
    [IO.File]::WriteAllText((Join-Path $stubPkgCore 'DigestDiff.psm1'), "`n", [Text.UTF8Encoding]::new($false, $true))
    [IO.File]::WriteAllText((Join-Path $stubPkgAdapter 'Validate-Digest.psm1'), "function Assert-AdapterDigestSemantics { param([Parameter(Mandatory)] [object] `$Document) }`nExport-ModuleMember -Function Assert-AdapterDigestSemantics`n", [Text.UTF8Encoding]::new($false, $true))
    $packagedDigest = @'
param([string] $DumpPath, [string] $OutPath, [string] $AdapterVersion, [string] $SourceDomainId, [string] $SaveName, [string] $SavedAt, [string] $SourceLength, [string] $SourceSha256)
Import-Module "$PSScriptRoot\..\..\core\DigestDiff.psm1" -Force -DisableNameChecking
$extra = [ordered]@{ dayPhase = [ordered]@{ hasSlept = $false }; noisy = [ordered]@{ n = 0 }; solid = 0 }
$xp = 10
if ($SaveName -match 's-a\.zip$') { $extra.dayPhase.hasSlept = $true; $extra.noisy.n = 1 }
if ($SaveName -match 's-b\.zip$') { $extra.dayPhase.hasSlept = $true; $extra.noisy.n = 1; $xp = 25 }
$digest = [ordered]@{
    schemaVersion = 2; adapterVersion = [long] $AdapterVersion; game = 'stubgame'
    generatedAt = [DateTime]::UtcNow.ToString('o')
    source = [ordered]@{ domainId = $SourceDomainId; saveFile = $SaveName; savedAt = $SavedAt; byteLength = [long] $SourceLength; contentSha256 = $SourceSha256 }
    session = [ordered]@{ day = 1; time = '08:00'; location = 'loc'; playtimeNote = $null }
    character = [ordered]@{ level = 1; xp = $xp; unspentPoints = 0
        money = [ordered]@{ amount = 1.0; minorUnits = 100; minorUnitsPerUnit = 100; currency = 'x' }
        vitals = @(); skills = @() }
    objectives = @(); inventory = [ordered]@{ owned = @(); equipped = @(); highlights = @() }
    extra = $extra
}
[System.IO.File]::WriteAllText($OutPath, ($digest | ConvertTo-Json -Depth 8 -Compress), [Text.UTF8Encoding]::new($false))
'@
    [IO.File]::WriteAllText((Join-Path $stubPkgAdapter 'Build-Digest.ps1'), $packagedDigest.TrimStart("`r", "`n"), [Text.UTF8Encoding]::new($false, $true))

    $stubConfigPath = Join-Path $stubAdapter 'adapter.json'

    $stageSaves = {
        param($SaveDir)
        Get-ChildItem -Path (Join-Path $SaveDir 's-*.zip') -File -ErrorAction SilentlyContinue | Remove-Item -Force -Confirm:$false
        $stampVersion = [DateTime]::UtcNow
        foreach ($fixture in @(
                @{ Name = 's-b.zip'; Time = $stampVersion.AddMinutes(-2) }
                @{ Name = 's-base.zip'; Time = $stampVersion.AddMinutes(-1) }
                @{ Name = 's-a.zip'; Time = $stampVersion })) {
            $path = Join-Path $SaveDir $fixture.Name
            Set-Content -LiteralPath $path -Value $fixture.Name
            (Get-Item -LiteralPath $path).LastWriteTimeUtc = $fixture.Time
        }
    }
    $newConfig = {
        param($SaveDir, [string[]] $DiffExclude, [string[]] $Ambient)
        [ordered]@{
            game = 'stubgame'
            adapterVersion = 2L
            saveDirectory = $SaveDir
            saveGlob = 's-*.zip'
            maxSourceBytes = 1048576
            dumpCommand = @('pwsh', '-NoProfile', '-File', '{artifactRoot}/adapters/stub/stub-dump.ps1', '{save}', '{dump}')
            dumpEntrypointIndex = 3
            digestCommand = @('pwsh', '-NoProfile', '-File', '{artifactRoot}/adapters/stub/Build-Digest.ps1', '-DumpPath', '{dump}', '-OutPath', '{digest}', '-AdapterVersion', '{adapterVersion}', '-SourceDomainId', '{sourceDomainId}', '-SaveName', '{saveName}', '-SavedAt', '{savedAt}', '-SourceLength', '{sourceLength}', '-SourceSha256', '{sourceSha256}')
            digestEntrypointIndex = 3
            diffExcludePaths = $DiffExclude
            ambientExtraPaths = $Ambient
        }
    }
    $writeConfig = {
        param($Config, $Path)
        [IO.File]::WriteAllText($Path, (ConvertTo-CompanionJson -InputObject $Config -Budget config), [Text.UTF8Encoding]::new($false, $true))
    }
    $walkArgs = @('-File', (Join-Path $stubCore 'Find-LastEventfulSpan.ps1'))

    $stubConfig = & $newConfig $stubSaves @('/extra/noisy') @('/extra/dayPhase')
    & $stageSaves $stubSaves
    & $writeConfig $stubConfig $stubConfigPath
    $default = Invoke-BoundedPwsh -Arguments $walkArgs -WorkingDirectory $stubRoot
    Assert-Equal -Actual $default.ExitCode -Expected 0 -Message 'Default stub walk exits 0.'
    $defaultJson = Assert-SingleWalkJson -Text $default.StdOut -Message 'Default stub stdout is exactly one JSON object.'
    Assert-True -Condition $defaultJson.found -Message 'Default stub walk finds an eventful span.'
    Assert-Equal -Actual ([long] $defaultJson.walkedSaves) -Expected ([long] 3) -Message 'Default stub walk passes the ambient first pair (walkedSaves 3).'
    Assert-OrdinalEqual -Actual $defaultJson.span.from.saveFile -Expected 's-b.zip' -Message 'Default stub span.from names the second pair baseline s-b.zip.'
    Assert-OrdinalEqual -Actual $defaultJson.span.to.saveFile -Expected 's-base.zip' -Message 'Default stub span.to names the second pair current s-base.zip.'

    & $stageSaves $stubSaves
    & $writeConfig (& $newConfig $stubSaves @('/extra/noisy') @()) $stubConfigPath
    $ambientRun = Invoke-BoundedPwsh -Arguments $walkArgs -WorkingDirectory $stubRoot
    Assert-Equal -Actual $ambientRun.ExitCode -Expected 0 -Message 'Ambient-empty stub walk exits 0.'
    $ambientJson = Assert-SingleWalkJson -Text $ambientRun.StdOut -Message 'Ambient-empty stub stdout is exactly one JSON object.'
    Assert-True -Condition $ambientJson.found -Message 'Ambient-empty stub walk finds the first pair.'
    Assert-Equal -Actual ([long] $ambientJson.walkedSaves) -Expected ([long] 2) -Message 'Ambient-empty stub walk stops at the first pair (walkedSaves 2).'

    & $stageSaves $stubSaves
    & $writeConfig (& $newConfig $stubSaves @() @('/extra/dayPhase')) $stubConfigPath
    $excludeRun = Invoke-BoundedPwsh -Arguments $walkArgs -WorkingDirectory $stubRoot
    Assert-Equal -Actual $excludeRun.ExitCode -Expected 0 -Message 'Exclude-empty stub walk exits 0.'
    $excludeJson = Assert-SingleWalkJson -Text $excludeRun.StdOut -Message 'Exclude-empty stub stdout is exactly one JSON object.'
    Assert-True -Condition $excludeJson.found -Message 'Exclude-empty stub walk finds the first pair.'
    Assert-Equal -Actual ([long] $excludeJson.walkedSaves) -Expected ([long] 2) -Message 'Exclude-empty stub walk stops at the first pair (walkedSaves 2).'

    Write-Output 'PASS: walk'
    exit 0
}

# Arrange
$scratchRoot = New-ScratchCompanionRoot -Prefix 'walk-staged'
$scratchCore = Join-Path $scratchRoot 'core'
Copy-Item -LiteralPath $coreRoot -Destination $scratchCore -Recurse
Copy-Item -LiteralPath (Join-Path $coreRoot 'Find-LastEventfulSpan.ps1') -Destination (Join-Path $scratchCore 'Find-LastEventfulSpan.ps1')
[void] [IO.Directory]::CreateDirectory((Join-Path $scratchRoot 'adapters'))
$stateBefore = Get-TreeFingerprint -Path (Join-Path $scratchRoot 'state')

# Act
$staged = Invoke-BoundedPwsh -Arguments @('-File', (Join-Path $scratchCore 'Find-LastEventfulSpan.ps1')) -WorkingDirectory $scratchRoot
$stateAfter = Get-TreeFingerprint -Path (Join-Path $scratchRoot 'state')

# Assert
Assert-Equal -Expected 1 -Actual $staged.ExitCode -Message 'The staged walk reports an invalid adapter as a failure.'
Assert-Equal -Expected 'find-span: [config]' -Actual $staged.StdErr.Trim() -Message 'The staged walk uses the exact configuration frame.'
Assert-TreeFingerprintEqual -Expected $stateBefore -Actual $stateAfter -Message 'The staged walk does not create or modify state.'

Write-Output 'PASS: walk'
