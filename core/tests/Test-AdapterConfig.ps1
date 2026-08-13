#Requires -Version 7.5

[CmdletBinding()]
param(
    [Parameter()]
    [ValidateSet('All', 'StateProfile', 'ProfileFailures', 'CommandGrammar', 'ConfigAdmission', 'ValidatorFaultBoundary', 'ValidatorBoundaryMatrix', 'DuplicateSurfaceMatrix', 'AmbientExtraPaths', 'WalkPolicyFraming', 'LeaseOrder', 'EntrypointMatrix', 'WarmHold')]
    [string] $Only = 'All'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Import-Module (Join-Path (Split-Path $PSScriptRoot -Parent) 'DigestDiff.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'TestSupport.psm1') -Force

function New-AdapterFixture {
    param(
        [Parameter(Mandatory)] [string] $Root,
        [Parameter()] [string] $Name = 'example',
        [Parameter()] [string] $AdapterJson = '{"game":"example","adapterVersion":-9223372036854775808,"saveDirectory":"C:\\saves","saveGlob":"*.zip","maxSourceBytes":1,"dumpCommand":["{artifactRoot}/adapters/example/tool.exe","{save}","{dump}","{digest}","{adapterVersion}","{sourceDomainId}","{saveName}","{savedAt}","{sourceLength}","{sourceSha256}"],"dumpEntrypointIndex":0,"digestCommand":["pwsh","-NoProfile","-File","{artifactRoot}/adapters/example/Build-Digest.ps1","{dump}","{digest}","{adapterVersion}","{sourceDomainId}","{saveName}","{savedAt}","{sourceLength}","{sourceSha256}"],"digestEntrypointIndex":3,"diffExcludePaths":["/extra/a~1b"],"ambientExtraPaths":["/extra/dayPhase"]}',
        [Parameter()] [string] $ValidatorModule = "function Assert-AdapterDigestSemantics { param([Parameter(Mandatory)] [System.Text.Json.JsonElement] `$RootElement) }`nExport-ModuleMember -Function Assert-AdapterDigestSemantics`n"
    )

    $adapterRoot = Join-Path $Root "adapters/$Name"
    [void] [IO.Directory]::CreateDirectory($adapterRoot)
    [IO.File]::WriteAllText((Join-Path $adapterRoot 'adapter.json'), $AdapterJson, [Text.UTF8Encoding]::new($false))
    $releaseRoot = Join-Path $adapterRoot 'releases/-9223372036854775808/schema-2'
    [void] [IO.Directory]::CreateDirectory((Join-Path $releaseRoot "adapters/$Name"))
    [void] [IO.Directory]::CreateDirectory((Join-Path $releaseRoot 'core'))
    [IO.File]::WriteAllText((Join-Path $releaseRoot "adapters/$Name/Validate-Digest.psm1"), $ValidatorModule, [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText((Join-Path $releaseRoot "adapters/$Name/Build-Digest.ps1"), "`n", [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText((Join-Path $releaseRoot "adapters/$Name/tool.exe"), "fixture`n", [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText((Join-Path $releaseRoot 'core/DigestDiff.psm1'), "`n", [Text.UTF8Encoding]::new($false))
}

function Test-StateProfileAdmitsIdentityAndDisposesLease {
    $root = New-ScratchCompanionRoot -Prefix 'adapter-config'
    New-AdapterFixture -Root $root

    $before = @(Get-Module | Where-Object { $_.Path -like '*Validate-Digest.psm1' }).Count
    $config = Get-AdapterConfig -CompanionRoot $root -Profile StateCompatibility
    try {
        Assert-Equal -Actual $config.AdapterVersion -Expected ([long]::MinValue) -Message 'the full signed Int64 adapter domain is preserved'
        Assert-True -Condition ($config.SourceDomainId -match '^[0-9a-f]{64}$') -Message 'source domain is a lowercase hash'
        Assert-True -Condition ($config.ConfigReceipt -match '^[0-9a-f]{64}$') -Message 'config receipt is a lowercase hash'
        Assert-True -Condition ($config.ArtifactRoot.EndsWith(('releases' + [IO.Path]::DirectorySeparatorChar + '-9223372036854775808' + [IO.Path]::DirectorySeparatorChar + 'schema-2'), [StringComparison]::Ordinal)) -Message 'release root uses canonical Int64 formatting'
    }
    finally {
        $config.Dispose()
    }
    $after = @(Get-Module | Where-Object { $_.Path -like '*Validate-Digest.psm1' }).Count
    Assert-Equal -Actual $after -Expected $before -Message 'disposing the snapshot unloads its validator module'
}

function Test-ProfileSplitAndConfigurationFailures {
    $root = New-ScratchCompanionRoot -Prefix 'adapter-config'
    New-AdapterFixture -Root $root -AdapterJson '{"game":"example","adapterVersion":-9223372036854775808,"saveDirectory":"C:\\does-not-exist","saveGlob":"*.zip","dumpCommand":[],"digestCommand":[]}'
    $config = Get-AdapterConfig -CompanionRoot $root -Profile StateCompatibility
    $config.Dispose()
    Assert-ThrowsType -TypeName 'AdapterConfigurationException' -Action { Get-AdapterConfig -CompanionRoot $root -Profile Acquisition }

    $unsafeRoot = New-ScratchCompanionRoot -Prefix 'adapter-config'
    New-AdapterFixture -Root $unsafeRoot
    Assert-ThrowsType -TypeName 'AdapterConfigurationException' -Action { Get-AdapterConfig -CompanionRoot $unsafeRoot -Adapter '../example' -Profile StateCompatibility }

    $extraRoot = New-ScratchCompanionRoot -Prefix 'adapter-config'
    New-AdapterFixture -Root $extraRoot -AdapterJson '{"game":"example","adapterVersion":0,"saveDirectory":"C:\\saves","saveGlob":"*.zip","unknown":true}'
    Assert-ThrowsType -TypeName 'AdapterConfigurationException' -Action { Get-AdapterConfig -CompanionRoot $extraRoot -Profile StateCompatibility }
}

function Test-CommandGrammarRejectsUnknownAndMissingPlaceholders {
    $root = New-ScratchCompanionRoot -Prefix 'adapter-config'
    New-AdapterFixture -Root $root -AdapterJson '{"game":"example","adapterVersion":0,"saveDirectory":"C:\\saves","saveGlob":"*.zip","maxSourceBytes":1,"dumpCommand":["{artifactRoot}/adapters/example/tool.exe","{savedat}"],"dumpEntrypointIndex":0,"digestCommand":["{artifactRoot}/adapters/example/Build-Digest.ps1","{digest}"],"digestEntrypointIndex":0}'
    Assert-ThrowsType -TypeName 'AdapterConfigurationException' -Action { Get-AdapterConfig -CompanionRoot $root -Profile Acquisition }
}

function Test-ConfigAdmission {
    Test-StateProfileAdmitsIdentityAndDisposesLease
    Test-ProfileSplitAndConfigurationFailures
    Test-CommandGrammarRejectsUnknownAndMissingPlaceholders
}

function Test-ValidatorFaultBoundary {
    $result = Invoke-InCompanionModule {
        $config = [AdapterCompatibilityConfig]::new()
        $config.AdapterVersion = 2L
        $config.Game = 'example'
        $config.SourceDomainId = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
        $digest = [ordered]@{
            schemaVersion = 2L; adapterVersion = $config.AdapterVersion; game = $config.Game; generatedAt = '2026-08-10T12:00:00.0000000Z'
            source = [ordered]@{ domainId = $config.SourceDomainId; saveFile = 'fixture.ntwtf.zip'; savedAt = '2026-08-10T11:00:00.0000000Z'; byteLength = 1L; contentSha256 = ('a' * 64) }
            session = [ordered]@{ day = 1L; time = '08:09'; location = 'fixture'; playtimeNote = $null }
            character = [ordered]@{ level = 1L; xp = 0L; unspentPoints = 0L; money = [ordered]@{ amount = [decimal]1; minorUnits = 100L; minorUnitsPerUnit = 100L; currency = 'real' }; vitals = @([ordered]@{ name = 'health'; value = 1L }); skills = @([ordered]@{ name = 'Logic'; value = 1L; group = 'Intellect' }) }
            objectives = @(); inventory = [ordered]@{ owned = @(); equipped = @() ; highlights = @() }; extra = [ordered]@{}
        }
        $document = Read-DigestDocument -Json (ConvertTo-CompanionJson -InputObject $digest -Budget digest)
        $config.Validator = { param($Unused) throw [AdapterDigestValidationException]::new('expected rejection') }
        try { Assert-AdapterDigestDocument -Document $document -AdapterConfig $config } catch { $expectedType = $_.Exception.GetType().Name }

        $sentinel = [InvalidOperationException]::new('unexpected validator fault')
        $config.Validator = { param($Unused) throw $sentinel }
        try { Assert-AdapterDigestDocument -Document $document -AdapterConfig $config } catch { $sameException = [object]::ReferenceEquals($_.Exception, $sentinel) }
        return [pscustomobject]@{ ExpectedType = $expectedType; SameException = $sameException }
    }

    Assert-Equal -Actual $result.ExpectedType -Expected 'AdapterDigestValidationException' -Message 'Expected semantic rejections retain their typed exception.'
    Assert-True -Condition $result.SameException -Message 'Unexpected validator faults escape unchanged.'
}

function Test-ValidatorBoundaryMatrix {
    Assert-ThrowsType -TypeName 'CompanionJsonParseException' -Action { Read-CompanionJson -Json '{' -Budget config }
    Assert-ThrowsType -TypeName 'CompanionDocumentValidationException' -Action { Read-DigestDocument -Json '{}' }
    Test-ValidatorFaultBoundary
    Test-ReleaseOwnedAdapterValidationType

    foreach ($probe in @(
            [pscustomobject]@{ path = (Join-Path $PSScriptRoot 'Test-DiffEngine.ps1'); selector = 'Compatibility' },
            [pscustomobject]@{ path = (Join-Path $PSScriptRoot 'Test-DiffEngine.ps1'); selector = 'SemanticRejection' },
            [pscustomobject]@{ path = (Join-Path $PSScriptRoot 'Test-TurnContext.ps1'); selector = 'DiagnosticProtocol' })) {
        $result = Invoke-BoundedPwsh -Arguments @('-File', $probe.path, '-Only', $probe.selector) -WorkingDirectory (Split-Path $PSScriptRoot -Parent)
        Assert-Equal -Actual $result.ExitCode -Expected 0 -Message "Boundary probe $($probe.selector) passes its exact named-type assertions."
    }
}

function Test-ReleaseOwnedAdapterValidationType {
    $root = New-ScratchCompanionRoot -Prefix 'adapter-validator-boundary'
    $validatorModule = "function Assert-AdapterDigestSemantics { param([Parameter(Mandatory)] `$Document) throw [AdapterDigestValidationException]::new('release rejection') }`nExport-ModuleMember -Function Assert-AdapterDigestSemantics`n"
    New-AdapterFixture -Root $root -ValidatorModule $validatorModule
    $digest = [ordered]@{
        schemaVersion = 2L; adapterVersion = [long]::MinValue; game = 'example'; generatedAt = '2026-08-10T12:00:00.0000000Z'
        source = [ordered]@{ domainId = $null; saveFile = 'fixture.ntwtf.zip'; savedAt = '2026-08-10T11:00:00.0000000Z'; byteLength = 1L; contentSha256 = ('a' * 64) }
        session = [ordered]@{ day = 1L; time = '08:09'; location = 'fixture'; playtimeNote = $null }
        character = [ordered]@{ level = 1L; xp = 0L; unspentPoints = 0L; money = [ordered]@{ amount = [decimal]1; minorUnits = 100L; minorUnitsPerUnit = 100L; currency = 'real' }; vitals = @([ordered]@{ name = 'health'; value = 1L }); skills = @([ordered]@{ name = 'Logic'; value = 1L; group = 'Intellect' }) }
        objectives = @(); inventory = [ordered]@{ owned = @(); equipped = @(); highlights = @() }; extra = [ordered]@{}
    }
    $result = Invoke-InCompanionModule -ArgumentList @($root, $digest) -ScriptBlock {
        param($Root, $Digest)
        $config = Get-AdapterConfig -CompanionRoot $Root -Profile StateCompatibility
        $Digest.source.domainId = $config.SourceDomainId
        $json = ConvertTo-CompanionJson -InputObject $Digest -Budget digest
        $document = Read-DigestDocument -Json $json
        try { Assert-AdapterDigestDocument -Document $document -AdapterConfig $config } catch { return [pscustomobject]@{ Type = $_.Exception.GetType().Name; BaseType = $_.Exception.GetType().BaseType.Name } } finally { $config.Dispose() }
    }
    Assert-Equal -Actual $result.Type -Expected 'AdapterDigestValidationException' -Message 'A package validator throws the running core adapter-validation subtype.'
    Assert-Equal -Actual $result.BaseType -Expected 'CompanionContentException' -Message 'The package validator type retains the core content-exception base type.'
    $validatorPath = Join-Path $root 'adapters/example/releases/-9223372036854775808/schema-2/adapters/example/Validate-Digest.psm1'
    Assert-False -Condition ((Get-Content -Raw -LiteralPath $validatorPath) -match '(?m)^\s*class\s+AdapterDigestValidationException\b') -Message 'The package validator declares no private AdapterDigestValidationException type.'
}

function Test-DuplicatePropertiesFailAtAdapterConfigSurface {
    $root = New-ScratchCompanionRoot -Prefix 'adapter-config-duplicate'
    $duplicate = '{"game":"example","game":"other","adapterVersion":-9223372036854775808,"saveDirectory":"C:\\saves","saveGlob":"*.zip","maxSourceBytes":1,"dumpCommand":["{artifactRoot}/adapters/example/tool.exe","{save}","{dump}","{digest}","{adapterVersion}","{sourceDomainId}","{saveName}","{savedAt}","{sourceLength}","{sourceSha256}"],"dumpEntrypointIndex":0,"digestCommand":["pwsh","-NoProfile","-File","{artifactRoot}/adapters/example/Build-Digest.ps1","{dump}","{digest}","{adapterVersion}","{sourceDomainId}","{saveName}","{savedAt}","{sourceLength}","{sourceSha256}"],"digestEntrypointIndex":3,"diffExcludePaths":[],"ambientExtraPaths":[]}'
    New-AdapterFixture -Root $root -AdapterJson $duplicate
    Assert-ThrowsType -TypeName 'AdapterConfigurationException' -Action { Get-AdapterConfig -CompanionRoot $root -Profile StateCompatibility }
}

function Test-AmbientExtraPathsValidation {
    $base = '{"game":"example","adapterVersion":-9223372036854775808,"saveDirectory":"C:\\saves","saveGlob":"*.zip","maxSourceBytes":1,"dumpCommand":["{artifactRoot}/adapters/example/tool.exe","{save}","{dump}","{digest}","{adapterVersion}","{sourceDomainId}","{saveName}","{savedAt}","{sourceLength}","{sourceSha256}"],"dumpEntrypointIndex":0,"digestCommand":["pwsh","-NoProfile","-File","{artifactRoot}/adapters/example/Build-Digest.ps1","{dump}","{digest}","{adapterVersion}","{sourceDomainId}","{saveName}","{savedAt}","{sourceLength}","{sourceSha256}"],"digestEntrypointIndex":3,"diffExcludePaths":[],"ambientExtraPaths":[]}'

    # The acquisition profile resolves a real save directory (the existence check) before
    # it reaches the ambientExtraPaths/diffExcludePaths pointer rules, so every pointer
    # rejection case below must use a resolvable savedir; otherwise the missing-directory
    # exception would mask the pointer check this test is meant to cover.
    $saveDir = Join-Path (New-ScratchCompanionRoot -Prefix 'ambient-extra') 'saves'
    [void] [IO.Directory]::CreateDirectory($saveDir)
    $baseWithSaveDir = $base.Replace('C:\\saves', $saveDir.Replace('\', '\\'))

    foreach ($invalid in @(
            $baseWithSaveDir.Replace('"ambientExtraPaths":[]', '"ambientExtraPaths":"extra.dayPhase"'),
            $baseWithSaveDir.Replace('"ambientExtraPaths":[]', '"ambientExtraPaths":["/extra/1"]'),
            $baseWithSaveDir.Replace('"ambientExtraPaths":[]', '"ambientExtraPaths":["session.day"]'),
            $baseWithSaveDir.Replace('"ambientExtraPaths":[]', '"ambientExtraPaths":["/extra/a~b"]'),
            $baseWithSaveDir.Replace('"ambientExtraPaths":[]', '"ambientExtraPaths":["/extra/a~2b"]'),
            $baseWithSaveDir.Replace('"ambientExtraPaths":[]', '"ambientExtraPaths":["/extra/dayPhase","/extra/dayPhase"]'))) {
        $root = New-ScratchCompanionRoot -Prefix 'ambient-extra-invalid'
        New-AdapterFixture -Root $root -AdapterJson $invalid
        Assert-ThrowsType -TypeName 'AdapterConfigurationException' -Action { Get-AdapterConfig -CompanionRoot $root -Profile Acquisition }
    }
    # The diffExcludePaths surface shares the exact pointer grammar with ambientExtraPaths.
    $excludeRoot = New-ScratchCompanionRoot -Prefix 'exclude-invalid'
    New-AdapterFixture -Root $excludeRoot -AdapterJson $baseWithSaveDir.Replace('"diffExcludePaths":[]', '"diffExcludePaths":["/extra/a~b"]')
    Assert-ThrowsType -TypeName 'AdapterConfigurationException' -Action { Get-AdapterConfig -CompanionRoot $excludeRoot -Profile Acquisition }

    # Canonical pointers, including valid RFC 6901 escapes, are admitted at the acquisition
    # boundary; the profile needs a resolvable save directory to reach the pointer rules.
    foreach ($valid in @(
            $baseWithSaveDir.Replace('"ambientExtraPaths":[]', '"ambientExtraPaths":["/extra/dayPhase"]'),
            $baseWithSaveDir.Replace('"ambientExtraPaths":[]', '"ambientExtraPaths":["/extra/a~1b"]'),
            $baseWithSaveDir.Replace('"ambientExtraPaths":[]', '"ambientExtraPaths":["/extra/a~0b"]'),
            $baseWithSaveDir.Replace('"ambientExtraPaths":[]', '"ambientExtraPaths":["/extra/dayPhase/hasSlept"]'))) {
        $root = New-ScratchCompanionRoot -Prefix 'ambient-extra-valid-item'
        New-AdapterFixture -Root $root -AdapterJson $valid
        $config = Get-AdapterConfig -CompanionRoot $root -Profile Acquisition
        try {
            Assert-True -Condition ($config.AmbientExtraPaths.Count -ge 1) -Message 'valid canonical pointers are admitted at the acquisition boundary'
        }
        finally {
            $config.Dispose()
        }
    }

    $stateProfileRoot = New-ScratchCompanionRoot -Prefix 'ambient-extra-state'
    New-AdapterFixture -Root $stateProfileRoot -AdapterJson $base
    $config = Get-AdapterConfig -CompanionRoot $stateProfileRoot -Profile StateCompatibility
    try {
        Assert-True -Condition ($null -ne $config) -Message 'StateCompatibility admits the acquisition-owned ambientExtraPaths member opaquely.'
    }
    finally {
        $config.Dispose()
    }
}

function Test-WalkPolicyIdFramesPolicyOrderInsensitively {
    $result = Invoke-InCompanionModule {
        $idA = Get-AdapterWalkPolicyId -DiffExcludePaths @('/extra/b', '/extra/a') -AmbientExtraPaths @('/extra/y', '/extra/x')
        $idB = Get-AdapterWalkPolicyId -DiffExcludePaths @('/extra/a', '/extra/b') -AmbientExtraPaths @('/extra/x', '/extra/y')
        $idGrown = Get-AdapterWalkPolicyId -DiffExcludePaths @('/extra/a', '/extra/b') -AmbientExtraPaths @('/extra/x', '/extra/y', '/extra/z')
        $idMoved = Get-AdapterWalkPolicyId -DiffExcludePaths @('/extra/x', '/extra/y', '/extra/z') -AmbientExtraPaths @('/extra/a', '/extra/b')
        return [pscustomobject]@{ A = $idA; B = $idB; Grown = $idGrown; Moved = $idMoved }
    }
    Assert-OrdinalEqual -Actual $result.A -Expected $result.B -Message 'walkPolicyId is order-insensitive within each policy set'
    Assert-True -Condition ($result.A -match '^[0-9a-f]{64}$') -Message 'walkPolicyId is a lowercase SHA-256'
    Assert-False -Condition ($result.B -ceq $result.Grown) -Message 'walkPolicyId changes when a policy set grows'
    Assert-False -Condition ($result.Grown -ceq $result.Moved) -Message 'moving a pointer between the two policy sets changes walkPolicyId'
}

function Test-AcquisitionValidationFailsBeforeValidatorImport {
    # Spec section 8: every non-module rule for the selected profile resolves before the
    # validator lease is acquired, so an invalid acquisition-only config never imports a
    # validator module that later must be torn down.
    $root = New-ScratchCompanionRoot -Prefix 'adapter-lease-order'
    $saveDir = Join-Path $root 'saves'
    [void] [IO.Directory]::CreateDirectory($saveDir)
    $marker = Join-Path $root 'validator-import-marker.txt'
    $validatorModule = "[IO.File]::WriteAllText('$marker', 'imported')`nfunction Assert-AdapterDigestSemantics { param([Parameter(Mandatory)] [System.Text.Json.JsonElement] `$RootElement) }`nExport-ModuleMember -Function Assert-AdapterDigestSemantics`n"
    $badJson = '{"game":"example","adapterVersion":-9223372036854775808,"saveDirectory":"' + $saveDir.Replace('\', '\\') + '","saveGlob":"*.zip","maxSourceBytes":0,"dumpCommand":["{artifactRoot}/adapters/example/tool.exe","{save}","{dump}","{digest}","{adapterVersion}","{sourceDomainId}","{saveName}","{savedAt}","{sourceLength}","{sourceSha256}"],"dumpEntrypointIndex":0,"digestCommand":["pwsh","-NoProfile","-File","{artifactRoot}/adapters/example/Build-Digest.ps1","{dump}","{digest}","{adapterVersion}","{sourceDomainId}","{saveName}","{savedAt}","{sourceLength}","{sourceSha256}"],"digestEntrypointIndex":3,"diffExcludePaths":[],"ambientExtraPaths":[]}'
    New-AdapterFixture -Root $root -AdapterJson $badJson -ValidatorModule $validatorModule
    $before = @(Get-Module | Where-Object { $_.Path -like '*Validate-Digest.psm1' }).Count
    Assert-ThrowsType -TypeName 'AdapterConfigurationException' -Action { Get-AdapterConfig -CompanionRoot $root -Profile Acquisition }
    Assert-False -Condition ([IO.File]::Exists($marker)) -Message 'an invalid acquisition-only config fails before the validator module is ever imported'
    $after = @(Get-Module | Where-Object { $_.Path -like '*Validate-Digest.psm1' }).Count
    Assert-Equal -Actual $after -Expected $before -Message 'an invalid acquisition-only config leaves the loaded validator module count at its start'
}

function Test-AdapterEntrypointValidationRejections {
    $root = New-ScratchCompanionRoot -Prefix 'adapter-entrypoint'
    $artifactRoot = Join-Path $root 'artifact'
    [void] [IO.Directory]::CreateDirectory($artifactRoot)
    [IO.File]::WriteAllText((Join-Path $artifactRoot 'tool.exe'), "fixture`n", [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText((Join-Path $artifactRoot 'script.ps1'), "`n", [Text.UTF8Encoding]::new($false))

    $result = Invoke-InCompanionModule -ArgumentList @($artifactRoot) -ScriptBlock {
        param($ArtifactRoot)

        $negative = $false; $outOfRange = $false; $otherIndex = $false; $brokenPrefix = $false; $external = $false
        try { Test-AdapterEntrypoint -Command @('{artifactRoot}/tool.exe') -Index -1 -ArtifactRoot $ArtifactRoot } catch [AdapterConfigurationException] { $negative = $true }
        try { Test-AdapterEntrypoint -Command @('{artifactRoot}/tool.exe') -Index 2 -ArtifactRoot $ArtifactRoot } catch [AdapterConfigurationException] { $outOfRange = $true }
        try { Test-AdapterEntrypoint -Command @('{artifactRoot}/tool.exe') -Index 1 -ArtifactRoot $ArtifactRoot } catch [AdapterConfigurationException] { $otherIndex = $true }
        try { Test-AdapterEntrypoint -Command @('pwsh', '-NoProfile', '-Command', '{artifactRoot}/script.ps1') -Index 3 -ArtifactRoot $ArtifactRoot } catch [AdapterConfigurationException] { $brokenPrefix = $true }
        try { Test-AdapterEntrypoint -Command @('{artifactRoot}/../outside.exe') -Index 0 -ArtifactRoot $ArtifactRoot } catch [AdapterConfigurationException] { $external = $true }
        $admitted = $true
        try { Test-AdapterEntrypoint -Command @('{artifactRoot}/tool.exe') -Index 0 -ArtifactRoot $ArtifactRoot } catch { $admitted = $false }
        if ($admitted) {
            try { Test-AdapterEntrypoint -Command @('pwsh', '-NoProfile', '-File', '{artifactRoot}/script.ps1') -Index 3 -ArtifactRoot $ArtifactRoot } catch { $admitted = $false }
        }

        return [pscustomobject]@{ Negative = $negative; OutOfRange = $outOfRange; OtherIndex = $otherIndex; BrokenPrefix = $brokenPrefix; External = $external; Admitted = $admitted }
    }
    Assert-True -Condition $result.Negative -Message 'a negative entrypoint index is rejected before entry selection'
    Assert-True -Condition $result.OutOfRange -Message 'an out-of-range entrypoint index is rejected before entry selection'
    Assert-True -Condition $result.OtherIndex -Message 'a non-0/non-3 entrypoint index is rejected as an unresolvable shape'
    Assert-True -Condition $result.BrokenPrefix -Message 'an index-3 entrypoint lacking the exact pwsh -NoProfile -File prefix is rejected'
    Assert-True -Condition $result.External -Message 'an entrypoint resolving outside the artifact root is rejected as not a descendant'
    Assert-True -Condition $result.Admitted -Message 'an in-root index-0 executable and an in-root index-3 script are admitted'
}

function Test-WatcherWarmHoldAmortizesValidatorImports {
    $root = New-ScratchCompanionRoot -Prefix 'adapter-warm-hold'
    New-AdapterFixture -Root $root
    $counts = Invoke-InCompanionModule -ArgumentList @($root) -ScriptBlock {
        param($Root)

        $loadedValidators = { @(Get-Module | Where-Object { $_.Path -like '*Validate-Digest.psm1' }).Count }
        $before = & $loadedValidators
        $hold = [WatcherValidatorWarmHold]::new()
        try {
            $config = Get-AdapterConfig -CompanionRoot $Root -Profile StateCompatibility
            try { $hold.Adopt($config.ValidatorPath) } finally { $config.Dispose() }
            $held = & $loadedValidators
            $second = Get-AdapterConfig -CompanionRoot $Root -Profile StateCompatibility
            $second.Dispose()
            $reheld = & $loadedValidators
            $hold.Adopt((Join-Path $Root 'missing/Validate-Digest.psm1'))
            $afterFailedAdopt = & $loadedValidators
        }
        finally {
            $hold.Dispose()
        }

        return [pscustomobject]@{ Before = $before; Held = $held; Reheld = $reheld; AfterFailedAdopt = $afterFailedAdopt; Released = (& $loadedValidators) }
    }
    Assert-Equal -Actual $counts.Held -Expected ($counts.Before + 1) -Message 'the warm hold keeps the validator module loaded after its snapshot is disposed'
    Assert-Equal -Actual $counts.Reheld -Expected ($counts.Before + 1) -Message 'a later snapshot of the same release rides the hold instead of re-importing'
    Assert-Equal -Actual $counts.AfterFailedAdopt -Expected ($counts.Before + 1) -Message 'a failed adoption leaves the existing hold unchanged'
    Assert-Equal -Actual $counts.Released -Expected $counts.Before -Message 'disposing the hold unloads the validator module'
}

$tests = [ordered]@{
    StateProfile = ${function:Test-StateProfileAdmitsIdentityAndDisposesLease}
    ProfileFailures = ${function:Test-ProfileSplitAndConfigurationFailures}
    CommandGrammar = ${function:Test-CommandGrammarRejectsUnknownAndMissingPlaceholders}
    ConfigAdmission = ${function:Test-ConfigAdmission}
    ValidatorFaultBoundary = ${function:Test-ValidatorFaultBoundary}
    ValidatorBoundaryMatrix = ${function:Test-ValidatorBoundaryMatrix}
    DuplicateSurfaceMatrix = ${function:Test-DuplicatePropertiesFailAtAdapterConfigSurface}
    AmbientExtraPaths = ${function:Test-AmbientExtraPathsValidation}
    WalkPolicyFraming = ${function:Test-WalkPolicyIdFramesPolicyOrderInsensitively}
    LeaseOrder = ${function:Test-AcquisitionValidationFailsBeforeValidatorImport}
    EntrypointMatrix = ${function:Test-AdapterEntrypointValidationRejections}
    WarmHold = ${function:Test-WatcherWarmHoldAmortizesValidatorImports}
}

if ($Only -eq 'All') {
    foreach ($test in $tests.Values) {
        & $test
    }
}
else {
    & $tests[$Only]
}

Write-Output 'PASS: Adapter configuration'
