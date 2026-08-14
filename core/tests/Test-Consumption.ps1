#Requires -Version 7.5

[CmdletBinding()]
param(
    [Parameter()]
    [ValidateSet('All', 'MissingCurrent', 'PeekNonMutation', 'FirstRunClassification', 'MoneyCompatibility', 'StaleBaselineRecovery', 'ConsumptionLock', 'EqualIdentityTargetFreeze', 'ResetOnRead', 'BaselineReadClassification', 'CacheInterleaving')]
    [string] $Only = 'All'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Import-Module (Join-Path $PSScriptRoot 'TestSupport.psm1') -Force
Import-Module (Join-Path $PSScriptRoot '../DigestDiff.psm1') -Force

function New-StagedGetDiffFixture {
    param(
        [Parameter(Mandatory)] [string] $Prefix,
        [Parameter(Mandatory)] [string] $DigestJson,
        [Parameter()] [switch] $SeedCurrent
    )

    $fixtureRoot = New-ScratchCompanionRoot -Prefix $Prefix
    $fixtureCore = Join-Path $fixtureRoot 'core'
    [IO.Directory]::CreateDirectory((Join-Path $fixtureRoot 'adapters')) | Out-Null
    [IO.Directory]::CreateDirectory((Join-Path $fixtureRoot '.tmp')) | Out-Null
    Copy-CompanionCoreTree -Destination $fixtureCore -EntryScripts @('Get-Diff.ps1')
    $fixtureAdapter = Join-Path $fixtureRoot 'adapters/example'
    $fixtureRelease = Join-Path $fixtureAdapter 'releases/2/schema-2/adapters/example'
    $fixtureSaves = Join-Path $fixtureRoot 'saves'
    [IO.Directory]::CreateDirectory($fixtureRelease) | Out-Null
    [IO.Directory]::CreateDirectory($fixtureSaves) | Out-Null
    [IO.File]::WriteAllText((Join-Path $fixtureRelease 'Validate-Digest.psm1'), "function Assert-AdapterDigestSemantics { param(`$Root) }`nExport-ModuleMember -Function Assert-AdapterDigestSemantics`n", [Text.UTF8Encoding]::new($false, $true))
    $adapterDocument = [ordered]@{ game = 'example'; adapterVersion = 2L; saveDirectory = $fixtureSaves; saveGlob = '*.ntwtf.zip'; diffExcludePaths = @() }
    [IO.File]::WriteAllText((Join-Path $fixtureAdapter 'adapter.json'), (ConvertTo-CompanionJson -InputObject $adapterDocument -Budget config), [Text.UTF8Encoding]::new($false, $true))
    $domainBytes = [Text.UTF8Encoding]::new($false, $true).GetBytes($fixtureSaves + [char]0 + '*.ntwtf.zip')
    $domain = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($domainBytes)).ToLowerInvariant()
    $fixtureDigest = $DigestJson.Replace('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', $domain)
    $fixtureState = Join-Path $fixtureRoot 'state'
    if ($SeedCurrent) {
        [IO.Directory]::CreateDirectory($fixtureState) | Out-Null
        [IO.File]::WriteAllText((Join-Path $fixtureState 'current.json'), $fixtureDigest, [Text.UTF8Encoding]::new($false, $true))
    }

    return [pscustomobject]@{
        Root = $fixtureRoot
        Core = $fixtureCore
        State = $fixtureState
        Saves = $fixtureSaves
        Digest = $fixtureDigest
        GetDiff = Join-Path $fixtureCore 'Get-Diff.ps1'
    }
}

$root = New-ScratchCompanionRoot -Prefix 'consumption'
$state = Join-Path $root 'state'
[IO.Directory]::CreateDirectory($state) | Out-Null
$digestJson = '{"schemaVersion":2,"adapterVersion":2,"game":"example","generatedAt":"2026-08-10T12:00:00.0000000Z","source":{"domainId":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef","saveFile":"B.ntwtf.zip","savedAt":"2026-08-10T11:00:00.0000000Z","byteLength":1,"contentSha256":"abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd"},"session":{"day":1,"time":"08:09","location":"place","playtimeNote":null},"character":{"level":1,"xp":0,"unspentPoints":0,"money":{"amount":1.25,"minorUnits":125,"minorUnitsPerUnit":100,"currency":"real"},"vitals":[{"name":"health","value":1}],"skills":[{"name":"Logic","value":1,"group":"Intellect"}]},"objectives":[{"id":"TASK.example","title":"example","status":"active","acquired":{"day":1,"time":"08:09"},"resolved":null,"subobjectives":[]}],"inventory":{"owned":["item"],"equipped":["item"],"highlights":[]},"extra":{}}'
[IO.File]::WriteAllText((Join-Path $state 'current.json'), $digestJson, [Text.UTF8Encoding]::new($false, $true))

$stagedFixture = New-StagedGetDiffFixture -Prefix 'staged-get-diff' -DigestJson $digestJson
$stagedRoot = $stagedFixture.Root
$stagedCore = $stagedFixture.Core
$stagedResult = Invoke-BoundedPwsh -Arguments @('-File', (Join-Path $stagedCore 'Get-Diff.ps1')) -WorkingDirectory $stagedRoot
Assert-Equal -Actual $stagedResult.ExitCode -Expected 1 -Message 'Staged Get-Diff runs only after its exact bytes are copied into a core-shaped scratch root.'
Assert-True -Condition $stagedResult.StdErr.Contains('[missing-current]', [StringComparison]::Ordinal) -Message 'Staged Get-Diff resolves its copied core module and classifies absent current state.'
Assert-False -Condition ([IO.Directory]::Exists((Join-Path $stagedRoot 'state'))) -Message 'Get-Diff preflight leaves an absent state directory uncreated.'
$missingPeek = Invoke-BoundedPwsh -Arguments @('-File', (Join-Path $stagedCore 'Get-Diff.ps1'), '-Peek') -WorkingDirectory $stagedRoot
Assert-Equal -Actual $missingPeek.ExitCode -Expected 1 -Message 'Staged Get-Diff peek classifies absent current state.'
Assert-True -Condition $missingPeek.StdErr.Contains('[missing-current]', [StringComparison]::Ordinal) -Message 'Peek retains the missing-current remediation class.'
Assert-False -Condition ([IO.Directory]::Exists((Join-Path $stagedRoot 'state'))) -Message 'Missing-current peek leaves an absent state directory uncreated.'
if ($Only -eq 'MissingCurrent') {
    Write-Output 'PASS: consumption'
    exit 0
}

$stagedState = Join-Path $stagedRoot 'state'
[IO.Directory]::CreateDirectory($stagedState) | Out-Null
$statePresentMissing = Invoke-BoundedPwsh -Arguments @('-File', (Join-Path $stagedCore 'Get-Diff.ps1')) -WorkingDirectory $stagedRoot
$statePresentMissingPeek = Invoke-BoundedPwsh -Arguments @('-File', (Join-Path $stagedCore 'Get-Diff.ps1'), '-Peek') -WorkingDirectory $stagedRoot
foreach ($result in @($statePresentMissing, $statePresentMissingPeek)) {
    Assert-Equal -Actual $result.ExitCode -Expected 1 -Message 'State-present current-absent Get-Diff exits unsuccessfully.'
    Assert-True -Condition $result.StdErr.Contains('[missing-current]', [StringComparison]::Ordinal) -Message 'State-present current-absent Get-Diff retains the missing-current class.'
    Assert-Equal -Actual $result.StdOut -Expected '' -Message 'State-present current-absent Get-Diff emits no payload.'
}
Assert-False -Condition ([IO.File]::Exists((Join-Path $stagedState 'consume.lock'))) -Message 'State-present current-absent Get-Diff does not create the consume lock.'
$stagedDigest = $stagedFixture.Digest
$stagedCurrent = Join-Path $stagedState 'current.json'
[IO.File]::WriteAllText($stagedCurrent, $stagedDigest, [Text.UTF8Encoding]::new($false, $true))
$currentBeforePeek = [IO.File]::ReadAllBytes($stagedCurrent)
$peekResult = Invoke-BoundedPwsh -Arguments @('-File', (Join-Path $stagedCore 'Get-Diff.ps1'), '-Peek') -WorkingDirectory $stagedRoot
Assert-Equal -Actual $peekResult.ExitCode -Expected 0 -Message 'Staged Get-Diff peek emits its advisory diff successfully.'
Assert-True -Condition ($peekResult.StdOut.Length -gt 0) -Message 'Peek emits exactly its advisory diff payload.'
Assert-True -Condition ([IO.File]::Exists($stagedCurrent)) -Message 'Peek preserves its current snapshot.'
Assert-True -Condition ([Linq.Enumerable]::SequenceEqual[byte]($currentBeforePeek, [IO.File]::ReadAllBytes($stagedCurrent))) -Message 'Peek does not rewrite current bytes.'
Assert-False -Condition ([IO.File]::Exists((Join-Path $stagedState 'baseline.json'))) -Message 'Peek does not create a baseline.'
Assert-False -Condition ([IO.File]::Exists((Join-Path $stagedState 'diff-since-last-read.json'))) -Message 'Peek does not create the diagnostic cache.'
Assert-False -Condition ([IO.File]::Exists((Join-Path $stagedState 'consume.lock'))) -Message 'Peek does not open or create the consume lock.'
if ($Only -eq 'PeekNonMutation') {
    Write-Output 'PASS: consumption'
    exit 0
}

$firstRun = Invoke-BoundedPwsh -Arguments @('-File', (Join-Path $stagedCore 'Get-Diff.ps1')) -WorkingDirectory $stagedRoot
Assert-Equal -Actual $firstRun.ExitCode -Expected 0 -Message 'Staged Get-Diff consumes a current snapshot with no baseline.'
Assert-True -Condition ($firstRun.StdOut.Length -gt 0) -Message 'First consuming result emits a diff payload.'
$firstRunDiff = Read-DiffDocument -Json $firstRun.StdOut
Assert-True -Condition ($firstRunDiff.RootElement.GetProperty('baselineGeneratedAt').ValueKind -eq [Text.Json.JsonValueKind]::Null) -Message 'First consuming result is a baseline reset.'
Assert-True -Condition ([IO.File]::Exists((Join-Path $stagedState 'baseline.json'))) -Message 'First consuming result creates the baseline.'
Assert-True -Condition ([IO.File]::Exists((Join-Path $stagedState 'diff-since-last-read.json'))) -Message 'First consuming result creates the diagnostic cache.'
Assert-ThrowsType -TypeName 'CompanionDocumentValidationException' -Action { Read-DigestDocument -Json $stagedDigest.Replace('"amount":1.25', '"amount":1.24') }
$baselineBeforeCompatibility = [IO.File]::ReadAllBytes((Join-Path $stagedState 'baseline.json'))
foreach ($variant in @(
        $stagedDigest.Replace('"currency":"real"', '"currency":"dollar"'),
        $stagedDigest.Replace('"amount":1.25,"minorUnits":125,"minorUnitsPerUnit":100', '"amount":0.125,"minorUnits":125,"minorUnitsPerUnit":1000'))) {
    [IO.File]::WriteAllText($stagedCurrent, $variant, [Text.UTF8Encoding]::new($false, $true))
    $compatibilityFailure = Invoke-BoundedPwsh -Arguments @('-File', (Join-Path $stagedCore 'Get-Diff.ps1')) -WorkingDirectory $stagedRoot
    Assert-Equal -Actual $compatibilityFailure.ExitCode -Expected 1 -Message 'Incompatible valid money representations fail Get-Diff.'
    Assert-Equal -Actual $compatibilityFailure.StdOut -Expected '' -Message 'Incompatible money representations emit no payload.'
    Assert-True -Condition $compatibilityFailure.StdErr.StartsWith('get-diff: [compute] ', [StringComparison]::Ordinal) -Message 'Incompatible money representations use the compute failure class.'
    Assert-True -Condition ([Linq.Enumerable]::SequenceEqual[byte]($baselineBeforeCompatibility, [IO.File]::ReadAllBytes((Join-Path $stagedState 'baseline.json')))) -Message 'Incompatible money representations leave the baseline untouched.'
}
if ($Only -eq 'MoneyCompatibility') {
    Write-Output 'PASS: consumption'
    exit 0
}

[IO.File]::WriteAllText($stagedCurrent, $stagedDigest, [Text.UTF8Encoding]::new($false, $true))
$stagedConsumptionPath = Join-Path $stagedCore 'private/Consumption.ps1'
$stagedConsumption = [IO.File]::ReadAllText($stagedConsumptionPath, [Text.UTF8Encoding]::new($false, $true))
$consumeLockCall = '        $lease = & $EnterConsumeLock $CompanionRoot'
Assert-Equal -Actual ([regex]::Matches($stagedConsumption, [regex]::Escape($consumeLockCall)).Count) -Expected 1 -Message 'Race fixture finds one consume-lock acquisition seam.'
$deleteBeforeLock = "        [IO.Directory]::Delete((Join-Path ([IO.Path]::GetFullPath(`$CompanionRoot)) 'state'), `$true)`n$consumeLockCall"
[IO.File]::WriteAllText($stagedConsumptionPath, $stagedConsumption.Replace($consumeLockCall, $deleteBeforeLock, [StringComparison]::Ordinal), [Text.UTF8Encoding]::new($false, $true))
$preflightLockRace = Invoke-BoundedPwsh -Arguments @('-File', (Join-Path $stagedCore 'Get-Diff.ps1')) -WorkingDirectory $stagedRoot
Assert-Equal -Actual $preflightLockRace.ExitCode -Expected 1 -Message 'Post-admission state deletion terminates Get-Diff.'
Assert-Equal -Actual $preflightLockRace.StdOut -Expected '' -Message 'Post-admission lock failure emits no payload.'
Assert-Equal -Actual $preflightLockRace.StdErr.Trim() -Expected 'get-diff: [lock] consume-lock-failed' -Message 'Post-admission state deletion maps to the lock class.'
Assert-False -Condition ([IO.Directory]::Exists($stagedState)) -Message 'The deterministic fixture deletes state only after the entrypoint admits current.'
if ($Only -eq 'FirstRunClassification') {
    Write-Output 'PASS: consumption'
    exit 0
}

if ($Only -eq 'StaleBaselineRecovery') {
    Invoke-InCompanionModule {
        param($Root, $DigestJson)

        $digest = Read-DigestDocument -Json $DigestJson
        $config = [AdapterCompatibilityConfig]::new()
        $config.AdapterVersion = 2
        $config.Game = 'example'
        $config.SourceDomainId = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
        $config.DiffExcludePaths = @()
        $config.Validator = { param($RootElement) }

        $fresh = Invoke-CompanionConsumption -AdapterConfig $config -CompanionRoot $Root -DeliveryMode rawStdout -WarningSink (New-CompanionWarningSink -Profile GetDiff) -WriteStdout { param($Text) }
        Assert-Equal -Actual $fresh.outcomeClass -Expected 'success' -Message 'Stale-baseline recovery consumes the first target into a baseline.'

        [IO.File]::WriteAllText((Join-Path $Root 'state/baseline.json'), $DigestJson.Replace('T11:00:00', 'T13:00:00'), [Text.UTF8Encoding]::new($false, $true))
        $stale = Invoke-CompanionConsumption -AdapterConfig $config -CompanionRoot $Root -DeliveryMode rawStdout -WarningSink (New-CompanionWarningSink -Profile GetDiff) -WriteStdout { param($Text) }
        Assert-Equal -Actual $stale.outcomeClass -Expected 'stale-target' -Message 'A target that precedes the baseline exhausts as stale-target without rewinding it.'
        Assert-True -Condition ([IO.File]::Exists((Join-Path $Root 'state/baseline.json'))) -Message 'Stale-target exhaustion leaves the authoritative baseline unchanged.'
        Assert-Equal -Actual $stale.consumptionState -Expected 'none' -Message 'Stale-target exhaustion never marks the target consumed.'
    } @($root, $digestJson)
    Write-Output 'PASS: consumption'
    exit 0
}

if ($Only -eq 'ConsumptionLock') {
    Invoke-InCompanionModule {
        param($Root, $DigestJson)

        $digest = Read-DigestDocument -Json $DigestJson
        $config = [AdapterCompatibilityConfig]::new()
        $config.AdapterVersion = 2
        $config.Game = 'example'
        $config.SourceDomainId = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
        $config.DiffExcludePaths = @()
        $config.Validator = { param($RootElement) }

        $busy = Invoke-CompanionConsumption -AdapterConfig $config -CompanionRoot $Root -DeliveryMode rawStdout -WarningSink (New-CompanionWarningSink -Profile GetDiff) -WriteStdout { param($Text) } -EnterConsumeLock { param($RootPath) throw [TimeoutException]::new('busy') }
        Assert-Equal -Actual $busy.outcomeClass -Expected 'busy' -Message 'Consume-lock contention returns busy without payload or mutation.'
        Assert-False -Condition ([IO.File]::Exists((Join-Path $Root 'state/baseline.json'))) -Message 'Lock contention leaves the baseline absent.'

        $afterRelease = Invoke-CompanionConsumption -AdapterConfig $config -CompanionRoot $Root -DeliveryMode rawStdout -WarningSink (New-CompanionWarningSink -Profile GetDiff) -WriteStdout { param($Text) }
        Assert-Equal -Actual $afterRelease.outcomeClass -Expected 'success' -Message 'After release the same entry point can acquire the lock and consume normally.'
        Assert-True -Condition ([IO.File]::Exists((Join-Path $Root 'state/baseline.json'))) -Message 'Post-release consumption advances the baseline.'
    } @($root, $digestJson)
    Write-Output 'PASS: consumption'
    exit 0
}

if ($Only -eq 'EqualIdentityTargetFreeze') {
    # Section 11 "Equal-identity target freeze": two real consumer processes contend on
    # the real consume.lock. The staged copy gains env-gated sentinel barriers at the two
    # claim-relevant points (before lock acquisition; after the locked target freeze); a
    # consumer launched without the env vars runs the production sequence untouched.
    $lockAnchor = '        $lease = & $EnterConsumeLock $CompanionRoot'
    $freezeAnchor = '        $target = $current.document'
    $lockBarrier = @(
        '        if (-not [string]::IsNullOrEmpty($env:COMPANION_TEST_LOCK_ARRIVE)) { [IO.File]::WriteAllText($env:COMPANION_TEST_LOCK_ARRIVE, ''arrive'') }'
        '        if (-not [string]::IsNullOrEmpty($env:COMPANION_TEST_LOCK_READY)) { [IO.File]::WriteAllText($env:COMPANION_TEST_LOCK_READY, ''ready''); while (-not [IO.File]::Exists($env:COMPANION_TEST_LOCK_RELEASE)) { Start-Sleep -Milliseconds 10 } }'
    ) -join "`n"
    $freezeBarrier = '        if (-not [string]::IsNullOrEmpty($env:COMPANION_TEST_FREEZE_READY)) { [IO.File]::WriteAllText($env:COMPANION_TEST_FREEZE_READY, ''ready''); while (-not [IO.File]::Exists($env:COMPANION_TEST_FREEZE_RELEASE)) { Start-Sleep -Milliseconds 10 } }'
    $newBarrierFixture = {
        param($Prefix)

        $fixture = New-StagedGetDiffFixture -Prefix $Prefix -DigestJson $digestJson -SeedCurrent
        $consumptionPath = Join-Path $fixture.Core 'private/Consumption.ps1'
        $consumptionSource = [IO.File]::ReadAllText($consumptionPath, [Text.UTF8Encoding]::new($false, $true))
        Assert-Equal -Actual ([regex]::Matches($consumptionSource, [regex]::Escape($lockAnchor)).Count) -Expected 1 -Message 'Freeze fixture finds one consume-lock acquisition seam.'
        Assert-Equal -Actual ([regex]::Matches($consumptionSource, [regex]::Escape($freezeAnchor)).Count) -Expected 1 -Message 'Freeze fixture finds one locked target-freeze seam.'
        $patched = $consumptionSource.Replace($lockAnchor, "$lockBarrier`n$lockAnchor", [StringComparison]::Ordinal).Replace($freezeAnchor, "$freezeAnchor`n$freezeBarrier", [StringComparison]::Ordinal)
        [IO.File]::WriteAllText($consumptionPath, $patched, [Text.UTF8Encoding]::new($false, $true))

        return $fixture
    }

    # Ordering 1: A parks before the lock, H2 force-refreshes the same identity, B
    # consumes H2 into the baseline, then A resumes, freezes H2 under the lock, and the
    # baseline never transitions from H2 back to H1.
    $order1 = & $newBarrierFixture 'freeze-order1'
    $order1Ready = Join-Path $order1.Root '.tmp/lock-ready'
    $order1Release = Join-Path $order1.Root '.tmp/lock-release'
    $consumerA = Start-BoundedPwsh -Arguments @('-File', $order1.GetDiff) -WorkingDirectory $order1.Root -Environment @{
        COMPANION_TEST_LOCK_READY = $order1Ready
        COMPANION_TEST_LOCK_RELEASE = $order1Release
    }
    try {
        Wait-TestSentinel -Path $order1Ready -TimeoutMilliseconds 20000
        [IO.File]::WriteAllText((Join-Path $order1.State 'current.json'), $order1.Digest.Replace('"xp":0', '"xp":5'), [Text.UTF8Encoding]::new($false, $true))
        $consumerB = Invoke-BoundedPwsh -Arguments @('-File', $order1.GetDiff) -WorkingDirectory $order1.Root
        Assert-Equal -Actual $consumerB.ExitCode -Expected 0 -Message 'Consumer B consumes receipt H2 while A is parked before the lock.'
        $baselineAfterB = Read-DigestDocument -Path (Join-Path $order1.State 'baseline.json')
        Assert-Equal -Actual $baselineAfterB.RootElement.GetProperty('character').GetProperty('xp').GetInt64() -Expected ([long] 5) -Message 'Consumer B publishes baseline H2.'
        Assert-False -Condition $consumerA.Process.HasExited -Message 'Consumer A is still parked at the lock barrier after B completes.'
        [IO.File]::WriteAllText($order1Release, 'release')
        $resultA = Complete-BoundedPwsh -Child $consumerA -TimeoutMilliseconds 20000
        Assert-Equal -Actual $resultA.ExitCode -Expected 0 -Message 'Resumed consumer A succeeds after acquiring the released lock.'
        $diffA = Read-DiffDocument -Json $resultA.StdOut
        Assert-False -Condition $diffA.RootElement.GetProperty('hasChanges').GetBoolean() -Message 'Consumer A freezes H2 under the lock and emits the empty diff.'
        Assert-Equal -Actual $diffA.RootElement.GetProperty('baselineGeneratedAt').ValueKind -Expected ([Text.Json.JsonValueKind]::String) -Message 'Consumer A consumes against the H2 baseline, not a reset.'
        $baselineAfterA = Read-DigestDocument -Path (Join-Path $order1.State 'baseline.json')
        Assert-Equal -Actual $baselineAfterA.RootElement.GetProperty('character').GetProperty('xp').GetInt64() -Expected ([long] 5) -Message 'Baseline never transitions from H2 back to H1.'
    }
    finally {
        Stop-BoundedPwsh -Child $consumerA
    }

    # Converse ordering: H2 lands after A's locked H1 freeze, B arrives at the held
    # lock, and the H1-to-H2 transition is left pending for B rather than lost.
    $order2 = & $newBarrierFixture 'freeze-order2'
    $order2FreezeReady = Join-Path $order2.Root '.tmp/freeze-ready'
    $order2FreezeRelease = Join-Path $order2.Root '.tmp/freeze-release'
    $order2Arrive = Join-Path $order2.Root '.tmp/b-arrive'
    $consumerA2 = Start-BoundedPwsh -Arguments @('-File', $order2.GetDiff) -WorkingDirectory $order2.Root -Environment @{
        COMPANION_TEST_FREEZE_READY = $order2FreezeReady
        COMPANION_TEST_FREEZE_RELEASE = $order2FreezeRelease
    }
    $consumerB2 = $null
    try {
        Wait-TestSentinel -Path $order2FreezeReady -TimeoutMilliseconds 20000
        [IO.File]::WriteAllText((Join-Path $order2.State 'current.json'), $order2.Digest.Replace('"xp":0', '"xp":5'), [Text.UTF8Encoding]::new($false, $true))
        $consumerB2 = Start-BoundedPwsh -Arguments @('-File', $order2.GetDiff) -WorkingDirectory $order2.Root -Environment @{ COMPANION_TEST_LOCK_ARRIVE = $order2Arrive }
        Wait-TestSentinel -Path $order2Arrive -TimeoutMilliseconds 20000
        Assert-False -Condition $consumerA2.Process.HasExited -Message 'Consumer A still holds the lock at its freeze barrier when B arrives.'
        [IO.File]::WriteAllText($order2FreezeRelease, 'release')
        $resultA2 = Complete-BoundedPwsh -Child $consumerA2 -TimeoutMilliseconds 20000
        Assert-Equal -Actual $resultA2.ExitCode -Expected 0 -Message 'Consumer A completes its locked H1 consumption.'
        $diffA2 = Read-DiffDocument -Json $resultA2.StdOut
        Assert-Equal -Actual $diffA2.RootElement.GetProperty('baselineGeneratedAt').ValueKind -Expected ([Text.Json.JsonValueKind]::Null) -Message 'Consumer A resets the absent baseline from its frozen H1 target.'
        $resultB2 = Complete-BoundedPwsh -Child $consumerB2 -TimeoutMilliseconds 20000
        Assert-Equal -Actual $resultB2.ExitCode -Expected 0 -Message 'Consumer B consumes after the held lock is released.'
        $diffB2 = Read-DiffDocument -Json $resultB2.StdOut
        Assert-True -Condition $diffB2.RootElement.GetProperty('hasChanges').GetBoolean() -Message 'The H1-to-H2 transition stays pending for B instead of being lost.'
        Assert-Equal -Actual $diffB2.RootElement.GetProperty('character').GetProperty('xpDelta').GetInt64() -Expected ([long] 5) -Message 'Consumer B reports exactly the H1-to-H2 change.'
        $baselineAfterB2 = Read-DigestDocument -Path (Join-Path $order2.State 'baseline.json')
        Assert-Equal -Actual $baselineAfterB2.RootElement.GetProperty('character').GetProperty('xp').GetInt64() -Expected ([long] 5) -Message 'The equal-identity race settles the baseline at H2.'
    }
    finally {
        Stop-BoundedPwsh -Child $consumerA2
        if ($null -ne $consumerB2) { Stop-BoundedPwsh -Child $consumerB2 }
    }

    Write-Output 'PASS: consumption'
    exit 0
}

if ($Only -eq 'ResetOnRead') {
    $resetFixture = New-StagedGetDiffFixture -Prefix 'reset-on-read' -DigestJson $digestJson -SeedCurrent
    $resetRoot = $resetFixture.Root
    $resetCore = $resetFixture.Core

    $first = Invoke-BoundedPwsh -Arguments @('-File', (Join-Path $resetCore 'Get-Diff.ps1')) -WorkingDirectory $resetRoot
    Assert-Equal -Actual $first.ExitCode -Expected 0 -Message 'Reset-on-read first consuming run consumes the current snapshot.'
    $firstDiff = Read-DiffDocument -Json $first.StdOut
    Assert-Equal -Actual $firstDiff.RootElement.GetProperty('baselineGeneratedAt').ValueKind -Expected ([Text.Json.JsonValueKind]::Null) -Message 'Reset-on-read first consuming run is a baseline reset.'

    $second = Invoke-BoundedPwsh -Arguments @('-File', (Join-Path $resetCore 'Get-Diff.ps1')) -WorkingDirectory $resetRoot
    Assert-Equal -Actual $second.ExitCode -Expected 0 -Message 'Reset-on-read immediate second consuming run succeeds.'
    $secondDiff = Read-DiffDocument -Json $second.StdOut
    Assert-False -Condition $secondDiff.RootElement.GetProperty('hasChanges').GetBoolean() -Message 'Reset-on-read second run prints the canonical empty diff.'
    Assert-False -Condition $secondDiff.RootElement.GetProperty('hasUnrepresentedChanges').GetBoolean() -Message 'Reset-on-read second-run diff has no unrepresented changes.'
    Assert-Equal -Actual $secondDiff.RootElement.GetProperty('baselineGeneratedAt').ValueKind -Expected ([Text.Json.JsonValueKind]::String) -Message 'Reset-on-read second run advances the baseline.'

    Write-Output 'PASS: consumption'
    exit 0
}

if ($Only -eq 'BaselineReadClassification') {
    Invoke-InCompanionModule {
        param($Root, $DigestJson)

        $digest = Read-DigestDocument -Json $DigestJson
        $config = [AdapterCompatibilityConfig]::new()
        $config.AdapterVersion = 2
        $config.Game = 'example'
        $config.SourceDomainId = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
        $config.DiffExcludePaths = @()
        $config.Validator = { param($RootElement) }

        $absent = Invoke-CompanionConsumption -AdapterConfig $config -CompanionRoot $Root -DeliveryMode rawStdout -WarningSink (New-CompanionWarningSink -Profile GetDiff) -WriteStdout { param($Text) } -ReadBaseline { param($RootPath) [pscustomobject]@{ outcome = 'absent'; document = $null } }
        Assert-Equal -Actual $absent.outcomeClass -Expected 'success' -Message 'An absent baseline resets to the target for comparison.'

        $contentInvalid = Invoke-CompanionConsumption -AdapterConfig $config -CompanionRoot $Root -DeliveryMode rawStdout -WarningSink (New-CompanionWarningSink -Profile GetDiff) -WriteStdout { param($Text) } -ReadBaseline { param($RootPath) [pscustomobject]@{ outcome = 'content-invalid'; document = $null } }
        Assert-Equal -Actual $contentInvalid.outcomeClass -Expected 'success' -Message 'A content-invalid baseline is reset from the current target.'

        $infrastructure = Invoke-CompanionConsumption -AdapterConfig $config -CompanionRoot $Root -DeliveryMode rawStdout -WarningSink (New-CompanionWarningSink -Profile GetDiff) -WriteStdout { param($Text) } -ReadBaseline { param($RootPath) [pscustomobject]@{ outcome = 'infrastructure-failure'; document = $null } }
        Assert-Equal -Actual $infrastructure.outcomeClass -Expected 'compute' -Message 'A baseline infrastructure failure is never misclassified as resettable content failure.'
        Assert-Equal -Actual $infrastructure.consumptionState -Expected 'none' -Message 'A baseline infrastructure failure never marks the target consumed.'
    } @($root, $digestJson)
    Write-Output 'PASS: consumption'
    exit 0
}

Invoke-InCompanionModule {
    param($Root, $DigestJson)

    $digest = Read-DigestDocument -Json $DigestJson
    $diff = New-EmptyDiff -Target $digest

    $payload = New-ConsumePayload -DeliveryMode rawStdout -Diff $diff

    Assert-True -Condition ($payload -is [CompanionJsonValue]) -Message 'Raw payload preserves the validated diff document.'
    Assert-True -Condition ([Text.Json.JsonElement]::DeepEquals($payload.RootElement, $diff.RootElement)) -Message 'Raw payload is the exact diff representation.'
    $context = [TurnContextPayloadContext]::new($digest.Materialized['source'], $false, $false, 0)
    $candidate = New-ConsumePayload -DeliveryMode privateResult -Diff $diff -State $digest -Context $context
    Assert-False -Condition $candidate.CacheDegraded -Message 'Private payload starts with no cache degradation.'
    Assert-Equal -Actual @($candidate.Warnings).Count -Expected 0 -Message 'Private payload starts with no warnings.'

    # An attempt may complete a candidate exactly once (CacheDegraded plus the final
    # warning collection); any later completion is a rejected mutation, covering the
    # post-serialization mutation probe by the same guard.
    $completedCandidate = New-ConsumePayload -DeliveryMode privateResult -Diff $diff -State $digest -Context $context
    $completedCandidate.Complete($true, @())
    Assert-True -Condition $completedCandidate.CacheDegraded -Message 'The single completion records cache degradation.'
    Assert-ThrowsType -TypeName 'System.InvalidOperationException' -Action { $completedCandidate.Complete($false, @()) }
    Assert-True -Condition $completedCandidate.CacheDegraded -Message 'A rejected second completion leaves the first completion intact.'

    Assert-ThrowsType -TypeName 'CompanionDiffSemanticException' -Action { New-ConsumePayload -DeliveryMode rawStdout -Diff $diff -State $digest -Context $context }
    Assert-ThrowsType -TypeName 'CompanionDiffSemanticException' -Action { New-ConsumePayload -DeliveryMode privateResult -Diff $diff }
    $belowFloor = @{ domainId = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'; saveFile = 'B.ntwtf.zip'; savedAt = '2026-08-10T13:00:00.0000000Z' }
    $belowFloorContext = [TurnContextPayloadContext]::new($belowFloor, $false, $false, 0)
    Assert-ThrowsType -TypeName 'CompanionDiffSemanticException' -Action { New-ConsumePayload -DeliveryMode privateResult -Diff $diff -State $digest -Context $belowFloorContext }
    $incompatibleDoc = Read-DigestDocument -Json $DigestJson.Replace('"game":"example"', '"game":"other"')
    $incompatibleDiff = New-EmptyDiff -Target $incompatibleDoc
    $compatContext = [TurnContextPayloadContext]::new($digest.Materialized['source'], $false, $false, 0)
    Assert-ThrowsType -TypeName 'CompanionDiffSemanticException' -Action { New-ConsumePayload -DeliveryMode privateResult -Diff $incompatibleDiff -State $digest -Context $compatContext }

    $config = [AdapterCompatibilityConfig]::new()
    $config.AdapterVersion = 2
    $config.Game = 'example'
    $config.SourceDomainId = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
    $config.DiffExcludePaths = @()
    $config.Validator = { param($RootElement) }
    $emitted = [Collections.Generic.List[string]]::new()
    $sink = New-CompanionWarningSink -Profile GetDiff
    $result = Invoke-CompanionConsumption -AdapterConfig $config -CompanionRoot $Root -DeliveryMode rawStdout -WarningSink $sink -WriteStdout { param($Text) $emitted.Add($Text) }
    Assert-Equal -Actual $result.outcomeClass -Expected 'success' -Message 'Valid target with no baseline consumes successfully.'
    Assert-Equal -Actual $result.consumptionState -Expected 'consumed' -Message 'Successful operation advances the baseline.'
    Assert-Equal -Actual $emitted.Count -Expected 1 -Message 'Raw consumption emits exactly once before state mutation.'
    Assert-True -Condition ([IO.File]::Exists((Join-Path $Root 'state/baseline.json'))) -Message 'Successful consumption writes the target snapshot as baseline.'
    Assert-True -Condition ([IO.File]::Exists((Join-Path $Root 'state/diff-since-last-read.json'))) -Message 'Successful consumption refreshes the diagnostic cache.'

    [IO.File]::Delete((Join-Path $Root 'state/baseline.json'))
    [IO.File]::Delete((Join-Path $Root 'state/diff-since-last-read.json'))
    $emitFailure = Invoke-CompanionConsumption -AdapterConfig $config -CompanionRoot $Root -DeliveryMode rawStdout -WarningSink (New-CompanionWarningSink -Profile GetDiff) -WriteStdout { param($Text) throw [IO.IOException]::new('stream closed') }
    Assert-Equal -Actual $emitFailure.outcomeClass -Expected 'emit' -Message 'Raw stream failure is classified after serialization but before consumption.'
    Assert-Equal -Actual $emitFailure.consumptionState -Expected 'none' -Message 'Raw stream failure preserves the unconsumed diff.'
    Assert-OrdinalEqual -Actual $emitFailure.detail -Expected 'stdout-write-failed' -Message 'Raw stdout-write failure carries its exact registry emit reason.'
    Assert-False -Condition ([IO.File]::Exists((Join-Path $Root 'state/baseline.json'))) -Message 'Raw stream failure leaves the baseline untouched.'

    $serializeEmitFailure = Invoke-CompanionConsumption -AdapterConfig $config -CompanionRoot $Root -DeliveryMode rawStdout -WarningSink (New-CompanionWarningSink -Profile GetDiff) -WriteStdout { param($Text) } -SerializePayload { param($Payload) throw [IO.IOException]::new('serialize failed') }
    Assert-Equal -Actual $serializeEmitFailure.outcomeClass -Expected 'emit' -Message 'Raw payload serialization failure is an emit failure before consumption.'
    Assert-Equal -Actual $serializeEmitFailure.consumptionState -Expected 'none' -Message 'Raw serialization failure preserves the unconsumed diff.'
    Assert-OrdinalEqual -Actual $serializeEmitFailure.detail -Expected 'payload-serialize-failed' -Message 'Raw serialization failure carries its exact registry emit reason.'
    Assert-False -Condition ([IO.File]::Exists((Join-Path $Root 'state/baseline.json'))) -Message 'Raw serialization failure leaves the baseline untouched.'

    $baselineFailure = Invoke-CompanionConsumption -AdapterConfig $config -CompanionRoot $Root -DeliveryMode rawStdout -WarningSink (New-CompanionWarningSink -Profile GetDiff) -WriteStdout { param($Text) } -WriteBaseline { param($Root, $Document) throw [IO.IOException]::new('baseline write failed') }
    Assert-Equal -Actual $baselineFailure.outcomeClass -Expected 'reset-write:not-consumed' -Message 'Baseline write failure preserves the emitted diff for the next full read.'
    Assert-Equal -Actual $baselineFailure.consumptionState -Expected 'notConsumed' -Message 'Baseline write failure never marks the diff consumed.'

    $cacheFailure = Invoke-CompanionConsumption -AdapterConfig $config -CompanionRoot $Root -DeliveryMode rawStdout -WarningSink (New-CompanionWarningSink -Profile GetDiff) -WriteStdout { param($Text) } -WriteCache { param($RootPath, $Document) throw [IO.IOException]::new('cache write failed') }
    Assert-Equal -Actual $cacheFailure.outcomeClass -Expected 'reset-write:consumed' -Message 'Cache write failure reports the already-consumed diff.'
    Assert-True -Condition $cacheFailure.cacheDegraded -Message 'Cache write failure marks the diagnostic cache degraded.'
    Assert-True -Condition ([IO.File]::Exists((Join-Path $Root 'state/baseline.json'))) -Message 'Cache write failure leaves the authoritative baseline advanced.'

    $busy = Invoke-CompanionConsumption -AdapterConfig $config -CompanionRoot $Root -DeliveryMode rawStdout -WarningSink (New-CompanionWarningSink -Profile GetDiff) -EnterConsumeLock { param($RootPath) throw [TimeoutException]::new('busy') }
    Assert-Equal -Actual $busy.outcomeClass -Expected 'busy' -Message 'Consume-lock contention returns busy without payload or mutation.'

    # ConsumeResult.detail is policed against the class-owned registry: exception
    # text, paths, command lines, or child-stream fragments can never ride a
    # consumption result into terminal framing.
    Assert-ThrowsType -TypeName 'System.ArgumentException' -Action { New-ConsumptionResult -OutcomeClass 'compute' -ConsumptionState 'none' -Payload $null -CacheDegraded $false -Detail 'Exception calling Write: C:\leaky\path --flag' }
    Assert-ThrowsType -TypeName 'System.ArgumentException' -Action { New-ConsumptionResult -OutcomeClass 'busy' -ConsumptionState 'none' -Payload $null -CacheDegraded $false -Detail 'baseline-serialize-failed' }
    foreach ($legal in @(
            @{ class = 'busy'; detail = 'consume-lock-busy' },
            @{ class = 'lock'; detail = 'consume-lock-failed' },
            @{ class = 'freshness'; detail = 'target-missing' },
            @{ class = 'freshness'; detail = 'target-unreadable' },
            @{ class = 'freshness'; detail = 'target-invalid' },
            @{ class = 'freshness'; detail = 'target-schema-stale' },
            @{ class = 'freshness'; detail = 'target-adapter-stale' },
            @{ class = 'freshness'; detail = 'target-game-mismatch' },
            @{ class = 'freshness'; detail = 'target-domain-mismatch' },
            @{ class = 'freshness'; detail = 'target-identity-invalid' },
            @{ class = 'freshness'; detail = 'target-below-floor' },
            @{ class = 'compute'; detail = 'baseline-read-failed' },
            @{ class = 'compute'; detail = 'payload-or-diff-failed' },
            @{ class = 'stale-target'; detail = 'target-precedes-baseline' },
            @{ class = 'emit'; detail = 'payload-serialize-failed' },
            @{ class = 'emit'; detail = 'stdout-write-failed' })) {
        $legalResult = New-ConsumptionResult -OutcomeClass $legal.class -ConsumptionState 'none' -Payload $null -CacheDegraded $false -Detail $legal.detail
        Assert-OrdinalEqual -Actual $legalResult.detail -Expected $legal.detail -Message "The detail registry admits '$($legal.detail)' for class '$($legal.class)'."
    }

    [IO.File]::WriteAllText((Join-Path $Root 'state/baseline.json'), $DigestJson.Replace('T11:00:00', 'T13:00:00'), [Text.UTF8Encoding]::new($false, $true))
    $stale = Invoke-CompanionConsumption -AdapterConfig $config -CompanionRoot $Root -DeliveryMode rawStdout -WarningSink (New-CompanionWarningSink -Profile GetDiff) -WriteStdout { param($Text) }
    Assert-Equal -Actual $stale.outcomeClass -Expected 'stale-target' -Message 'A target that precedes the baseline never rewinds it.'

    [IO.File]::Delete((Join-Path $Root 'state/baseline.json'))
    $floor = @{ domainId = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'; saveFile = 'C.ntwtf.zip'; savedAt = '2026-08-10T13:00:00.0000000Z' }
    $freshness = Invoke-CompanionConsumption -AdapterConfig $config -CompanionRoot $Root -DeliveryMode rawStdout -SourceFloor $floor -WarningSink (New-CompanionWarningSink -Profile GetDiff) -WriteStdout { param($Text) }
    Assert-Equal -Actual $freshness.outcomeClass -Expected 'freshness' -Message 'A target below the caller source floor is rejected before baseline mutation.'
    Assert-OrdinalEqual -Actual $freshness.detail -Expected 'target-below-floor' -Message 'A below-floor target carries target-below-floor.'
    Assert-False -Condition ([IO.File]::Exists((Join-Path $Root 'state/baseline.json'))) -Message 'Source-floor rejection leaves baseline absent.'

    $missingTarget = Invoke-CompanionConsumption -AdapterConfig $config -CompanionRoot $Root -DeliveryMode rawStdout -WarningSink (New-CompanionWarningSink -Profile GetDiff) -ReadCurrent { param($RootPath, $Config) [pscustomobject]@{ outcome = 'absent'; document = $null; reason = 'target-missing' } }
    Assert-Equal -Actual $missingTarget.outcomeClass -Expected 'freshness' -Message 'Missing authoritative target is returned before any baseline read or mutation.'
    Assert-OrdinalEqual -Actual $missingTarget.detail -Expected 'target-missing' -Message 'A missing locked target carries target-missing.'

    $invalidTarget = Invoke-CompanionConsumption -AdapterConfig $config -CompanionRoot $Root -DeliveryMode rawStdout -WarningSink (New-CompanionWarningSink -Profile GetDiff) -ReadCurrent { param($RootPath, $Config) [pscustomobject]@{ outcome = 'content-invalid'; document = $null; reason = 'target-invalid' } }
    Assert-Equal -Actual $invalidTarget.outcomeClass -Expected 'freshness' -Message 'Content-invalid authoritative target is returned before baseline mutation.'
    Assert-OrdinalEqual -Actual $invalidTarget.detail -Expected 'target-invalid' -Message 'A content-invalid locked target carries target-invalid.'

    $staleCurrent = Invoke-CompanionConsumption -AdapterConfig $config -CompanionRoot $Root -DeliveryMode rawStdout -WarningSink (New-CompanionWarningSink -Profile GetDiff) -ReadCurrent { param($RootPath, $Config) [pscustomobject]@{ outcome = 'stale'; document = $null; reason = 'target-schema-stale' } }
    Assert-Equal -Actual $staleCurrent.outcomeClass -Expected 'freshness' -Message 'Version-stale authoritative target is returned before baseline mutation.'
    Assert-OrdinalEqual -Actual $staleCurrent.detail -Expected 'target-schema-stale' -Message 'A version-stale locked target carries its forced stale reason.'

    # Section 11: force the shared locked target read to return every freshness
    # reason; the legal tuple is (freshness, none, null payload, false cacheDegraded,
    # matching detail) for each.
    foreach ($case in @(
            @{ outcome = 'absent'; reason = 'target-missing' },
            @{ outcome = 'infrastructure-failure'; reason = 'target-unreadable' },
            @{ outcome = 'content-invalid'; reason = 'target-invalid' },
            @{ outcome = 'stale'; reason = 'target-schema-stale' },
            @{ outcome = 'stale'; reason = 'target-adapter-stale' },
            @{ outcome = 'stale'; reason = 'target-game-mismatch' },
            @{ outcome = 'stale'; reason = 'target-domain-mismatch' })) {
        $forced = Invoke-CompanionConsumption -AdapterConfig $config -CompanionRoot $Root -DeliveryMode rawStdout -WarningSink (New-CompanionWarningSink -Profile GetDiff) -ReadCurrent { param($RootPath, $Config) [pscustomobject]@{ outcome = $case.outcome; document = $null; reason = $case.reason } }
        Assert-Equal -Actual $forced.outcomeClass -Expected 'freshness' -Message "A forced '$($case.reason)' read keeps the freshness class."
        Assert-Equal -Actual $forced.consumptionState -Expected 'none' -Message "A forced '$($case.reason)' read consumes nothing."
        Assert-True -Condition ($null -eq $forced.payload) -Message "A forced '$($case.reason)' read carries no payload."
        Assert-False -Condition $forced.cacheDegraded -Message "A forced '$($case.reason)' read degrades no cache."
        Assert-OrdinalEqual -Actual $forced.detail -Expected $case.reason -Message "A forced '$($case.reason)' read carries the matching detail."
    }
    # target-identity-invalid: the floor's domain differs, so identities are incomparable.
    $alienFloor = @{ domainId = ('f' * 64); saveFile = 'B.ntwtf.zip'; savedAt = '2026-08-10T11:00:00.0000000Z' }
    $identityInvalid = Invoke-CompanionConsumption -AdapterConfig $config -CompanionRoot $Root -DeliveryMode rawStdout -SourceFloor $alienFloor -WarningSink (New-CompanionWarningSink -Profile GetDiff) -ReadCurrent { param($RootPath, $Config) [pscustomobject]@{ outcome = 'valid'; document = $digest; reason = $null } }
    Assert-Equal -Actual $identityInvalid.outcomeClass -Expected 'freshness' -Message 'An incomparable floor identity is a freshness failure.'
    Assert-OrdinalEqual -Actual $identityInvalid.detail -Expected 'target-identity-invalid' -Message 'An incomparable floor identity carries target-identity-invalid.'

    # Section 11 adapter-validator infrastructure boundaries (consumption side).
    # Locked-final target: a validator-infrastructure read is pre-mutation compute.
    $lockedInfra = Invoke-CompanionConsumption -AdapterConfig $config -CompanionRoot $Root -DeliveryMode rawStdout -WarningSink (New-CompanionWarningSink -Profile GetDiff) -ReadCurrent { param($RootPath, $Config) [pscustomobject]@{ outcome = 'validator-infrastructure'; document = $null; reason = 'adapter-validator-infrastructure-failed' } }
    Assert-Equal -Actual $lockedInfra.outcomeClass -Expected 'compute' -Message 'Locked-target validator infrastructure failure is pre-mutation compute.'
    Assert-Equal -Actual $lockedInfra.consumptionState -Expected 'none' -Message 'Locked-target validator infrastructure failure consumes nothing.'
    Assert-OrdinalEqual -Actual $lockedInfra.detail -Expected 'adapter-validator-infrastructure-failed' -Message 'Locked-target validator infrastructure failure carries the registry reason.'
    # Baseline admission: an infrastructure throw from the validator is compute, not
    # a content-invalid baseline reset.
    if ([IO.File]::Exists((Join-Path $Root 'state/baseline.json'))) { [IO.File]::Delete((Join-Path $Root 'state/baseline.json')) }
    $infraConfig = [AdapterCompatibilityConfig]::new()
    $infraConfig.AdapterVersion = 2
    $infraConfig.Game = 'example'
    $infraConfig.SourceDomainId = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
    $infraConfig.DiffExcludePaths = @()
    $infraConfig.Validator = { param($RootElement) throw [InvalidOperationException]::new('validator machinery broke') }
    $baselineInfra = Invoke-CompanionConsumption -AdapterConfig $infraConfig -CompanionRoot $Root -DeliveryMode rawStdout -WarningSink (New-CompanionWarningSink -Profile GetDiff) -WriteStdout { param($Text) } -ReadCurrent { param($RootPath, $Config) [pscustomobject]@{ outcome = 'valid'; document = $digest; reason = $null } } -ReadBaseline { param($RootPath) [pscustomobject]@{ outcome = 'valid'; document = $digest } }
    Assert-Equal -Actual $baselineInfra.outcomeClass -Expected 'compute' -Message 'Baseline validator infrastructure failure never takes the content-invalid reset.'
    Assert-OrdinalEqual -Actual $baselineInfra.detail -Expected 'adapter-validator-infrastructure-failed' -Message 'Baseline validator infrastructure failure carries the registry reason.'
    Assert-False -Condition ([IO.File]::Exists((Join-Path $Root 'state/baseline.json'))) -Message 'Baseline validator infrastructure failure leaves baseline unwritten.'
    # Post-baseline fresh cache target: validator-infrastructure retains
    # reset-write:consumed / cache-target-invalid.
    $freshInfraReads = [Collections.Generic.List[int]]::new()
    $freshInfra = Invoke-CompanionConsumption -AdapterConfig $config -CompanionRoot $Root -DeliveryMode rawStdout -WarningSink (New-CompanionWarningSink -Profile GetDiff) -WriteStdout { param($Text) } -ReadCurrent {
        param($RootPath, $Config)
        $freshInfraReads.Add(1)
        if ($freshInfraReads.Count -eq 1) { return [pscustomobject]@{ outcome = 'valid'; document = $digest; reason = $null } }

        return [pscustomobject]@{ outcome = 'validator-infrastructure'; document = $null; reason = 'adapter-validator-infrastructure-failed' }
    }
    Assert-Equal -Actual $freshInfra.outcomeClass -Expected 'reset-write:consumed' -Message 'Post-baseline validator infrastructure keeps the consumed reset class.'
    Assert-OrdinalEqual -Actual $freshInfra.detail -Expected 'cache-target-invalid' -Message 'Post-baseline validator infrastructure retains cache-target-invalid.'

    $baselineInfrastructure = Invoke-CompanionConsumption -AdapterConfig $config -CompanionRoot $Root -DeliveryMode rawStdout -WarningSink (New-CompanionWarningSink -Profile GetDiff) -ReadBaseline { param($RootPath) [pscustomobject]@{ outcome = 'infrastructure-failure'; document = $null } }
    Assert-Equal -Actual $baselineInfrastructure.outcomeClass -Expected 'compute' -Message 'Baseline infrastructure failures never become resettable content failures.'

    $coreInvalidBaseline = Invoke-CompanionConsumption -AdapterConfig $config -CompanionRoot $Root -DeliveryMode rawStdout -WarningSink (New-CompanionWarningSink -Profile GetDiff) -WriteStdout { param($Text) } -ReadBaseline { param($RootPath) [pscustomobject]@{ outcome = 'content-invalid'; document = $null } }
    Assert-Equal -Actual $coreInvalidBaseline.outcomeClass -Expected 'success' -Message 'Core-invalid baseline is reset from the current target.'

    $currentReads = [Collections.Generic.List[int]]::new()
    $fallbackSink = New-CompanionWarningSink -Profile GetDiff
    $cacheFallback = Invoke-CompanionConsumption -AdapterConfig $config -CompanionRoot $Root -DeliveryMode rawStdout -WarningSink $fallbackSink -WriteStdout { param($Text) } -ReadCurrent {
        param($RootPath, $Config)
        $currentReads.Add(1)
        if ($currentReads.Count -eq 1) { return [pscustomobject]@{ outcome = 'valid'; document = $digest } }

        return [pscustomobject]@{ outcome = 'absent'; document = $null }
    }
    Assert-Equal -Actual $cacheFallback.outcomeClass -Expected 'success' -Message 'A fresh cache target that disappears uses the non-authoritative fallback.'
    Assert-True -Condition (@($fallbackSink.Freeze() | Where-Object { $_.code -ceq 'consume-cache-fallback' }).Count -eq 1) -Message 'Cache fallback is retained as a typed warning.'

    $cacheTargetReads = [Collections.Generic.List[int]]::new()
    $cacheTargetFailure = Invoke-CompanionConsumption -AdapterConfig $config -CompanionRoot $Root -DeliveryMode rawStdout -WarningSink (New-CompanionWarningSink -Profile GetDiff) -WriteStdout { param($Text) } -ReadCurrent {
        param($RootPath, $Config)
        $cacheTargetReads.Add(1)
        if ($cacheTargetReads.Count -eq 1) { return [pscustomobject]@{ outcome = 'valid'; document = $digest } }

        return [pscustomobject]@{ outcome = 'infrastructure-failure'; document = $null }
    }
    Assert-Equal -Actual $cacheTargetFailure.outcomeClass -Expected 'reset-write:consumed' -Message 'Fresh cache-target infrastructure failure is reported after baseline advancement.'
    Assert-True -Condition $cacheTargetFailure.cacheDegraded -Message 'Fresh cache-target infrastructure failure marks cache degradation.'

    $baselineVariant = Read-DigestDocument -Json $DigestJson.Replace('"level":1', '"level":2')
    $sameIdentity = Invoke-CompanionConsumption -AdapterConfig $config -CompanionRoot $Root -DeliveryMode rawStdout -WarningSink (New-CompanionWarningSink -Profile GetDiff) -WriteStdout { param($Text) } -ReadBaseline { param($RootPath) [pscustomobject]@{ outcome = 'valid'; document = $baselineVariant } }
    Assert-Equal -Actual $sameIdentity.outcomeClass -Expected 'success' -Message 'Equal source identity with changed digest content is still consumed.'

    $rejectingConfig = [AdapterCompatibilityConfig]::new()
    $rejectingConfig.AdapterVersion = 2
    $rejectingConfig.Game = 'example'
    $rejectingConfig.SourceDomainId = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
    $rejectingConfig.DiffExcludePaths = @()
    $rejectingConfig.Validator = { param($RootElement) throw [AdapterDigestValidationException]::new('baseline invalid') }
    $adapterInvalidBaseline = Invoke-CompanionConsumption -AdapterConfig $rejectingConfig -CompanionRoot $Root -DeliveryMode rawStdout -WarningSink (New-CompanionWarningSink -Profile GetDiff) -WriteStdout { param($Text) } -ReadCurrent { param($RootPath, $Config) [pscustomobject]@{ outcome = 'valid'; document = $digest } } -ReadBaseline { param($RootPath) [pscustomobject]@{ outcome = 'valid'; document = $digest } }
    Assert-Equal -Actual $adapterInvalidBaseline.outcomeClass -Expected 'success' -Message 'Adapter-invalid baseline is reset rather than treated as infrastructure failure.'

    # Section 11 "Turn-context failure injection" coverage: private candidate
    # construction failure before baseline mutation. The context's floor exceeds the
    # target, so New-ConsumePayload rejects the candidate inside the compute stage.
    [IO.File]::Delete((Join-Path $Root 'state/baseline.json'))
    $newerFloor = @{ domainId = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'; saveFile = 'C.ntwtf.zip'; savedAt = '2026-08-10T13:00:00.0000000Z' }
    $computeContext = [TurnContextPayloadContext]::new($newerFloor, $false, $false, 0)
    $privateCompute = Invoke-CompanionConsumption -AdapterConfig $config -CompanionRoot $Root -DeliveryMode privateResult -Context $computeContext -WarningSink (New-CompanionWarningSink -Profile GetDiff)
    Assert-Equal -Actual $privateCompute.outcomeClass -Expected 'compute' -Message 'Private candidate construction failure is a compute failure before baseline mutation.'
    Assert-Equal -Actual $privateCompute.consumptionState -Expected 'none' -Message 'Private candidate construction failure never marks the target consumed.'
    Assert-OrdinalEqual -Actual $privateCompute.detail -Expected 'payload-or-diff-failed' -Message 'Private candidate construction failure carries the registry compute reason.'
    Assert-False -Condition ([IO.File]::Exists((Join-Path $Root 'state/baseline.json'))) -Message 'Private candidate construction failure leaves the baseline unchanged.'

    # Private-mode fresh-validation-machinery failure: the post-baseline cache
    # target's infrastructure failure carries the exact cache-target-invalid reason
    # (never the pre-baseline compute class) on a consumed private candidate.
    $privateContext = [TurnContextPayloadContext]::new($digest.Materialized['source'], $false, $false, 0)
    $privateCacheReads = [Collections.Generic.List[int]]::new()
    $privateCacheTarget = Invoke-CompanionConsumption -AdapterConfig $config -CompanionRoot $Root -DeliveryMode privateResult -Context $privateContext -WarningSink (New-CompanionWarningSink -Profile GetDiff) -ReadCurrent {
        param($RootPath, $Config)
        $privateCacheReads.Add(1)
        if ($privateCacheReads.Count -eq 1) { return [pscustomobject]@{ outcome = 'valid'; document = $digest } }

        return [pscustomobject]@{ outcome = 'infrastructure-failure'; document = $null }
    }
    Assert-Equal -Actual $privateCacheTarget.outcomeClass -Expected 'reset-write:consumed' -Message 'Private fresh cache-target infrastructure failure reports after baseline advancement.'
    Assert-Equal -Actual $privateCacheTarget.consumptionState -Expected 'consumed' -Message 'Private fresh cache-target infrastructure failure keeps the consumed state.'
    Assert-True -Condition $privateCacheTarget.cacheDegraded -Message 'Private fresh cache-target infrastructure failure marks cache degradation.'
    Assert-OrdinalEqual -Actual $privateCacheTarget.detail -Expected 'cache-target-invalid' -Message 'The fresh validation machinery uses exactly cache-target-invalid, never a compute reason.'
    Assert-True -Condition ($privateCacheTarget.payload -is [TurnContextPayloadCandidate]) -Message 'A degraded private result still carries a valid payload candidate.'
    Assert-True -Condition ([Text.Json.JsonElement]::DeepEquals($privateCacheTarget.payload.State.RootElement, $digest.RootElement)) -Message 'The private candidate state retains the exact consumed document.'

    # A later ordinary acquisition repairs the diagnostic cache after a degraded
    # cache write.
    [IO.File]::Delete((Join-Path $Root 'state/baseline.json'))
    [IO.File]::Delete((Join-Path $Root 'state/diff-since-last-read.json'))
    $degradedWrite = Invoke-CompanionConsumption -AdapterConfig $config -CompanionRoot $Root -DeliveryMode rawStdout -WarningSink (New-CompanionWarningSink -Profile GetDiff) -WriteStdout { param($Text) } -WriteCache { param($RootPath, $Document) throw [IO.IOException]::new('cache write failed') }
    Assert-Equal -Actual $degradedWrite.outcomeClass -Expected 'reset-write:consumed' -Message 'The degraded cache write advances the baseline without a cache file.'
    Assert-False -Condition ([IO.File]::Exists((Join-Path $Root 'state/diff-since-last-read.json'))) -Message 'The failed cache write leaves no diagnostic cache.'
    $repair = Invoke-CompanionConsumption -AdapterConfig $config -CompanionRoot $Root -DeliveryMode rawStdout -WarningSink (New-CompanionWarningSink -Profile GetDiff) -WriteStdout { param($Text) }
    Assert-Equal -Actual $repair.outcomeClass -Expected 'success' -Message 'A later ordinary acquisition succeeds after cache degradation.'
    $repairedCache = Read-DiffDocument -Path (Join-Path $Root 'state/diff-since-last-read.json')
    Assert-False -Condition $repairedCache.RootElement.GetProperty('hasChanges').GetBoolean() -Message 'The later acquisition repairs the diagnostic cache.'

    # The stale and content-invalid fresh-sample classifications (schema, adapter,
    # and game mismatches all funnel into stale) take the canonical-empty fallback
    # and still succeed; the absent variant is covered above.
    foreach ($freshOutcome in @('stale', 'content-invalid')) {
        $fallbackReads = [Collections.Generic.List[int]]::new()
        $variantSink = New-CompanionWarningSink -Profile GetDiff
        $variant = Invoke-CompanionConsumption -AdapterConfig $config -CompanionRoot $Root -DeliveryMode rawStdout -WarningSink $variantSink -WriteStdout { param($Text) } -ReadCurrent {
            param($RootPath, $Config)
            $fallbackReads.Add(1)
            if ($fallbackReads.Count -eq 1) { return [pscustomobject]@{ outcome = 'valid'; document = $digest } }

            return [pscustomobject]@{ outcome = $freshOutcome; document = $null }
        }
        Assert-Equal -Actual $variant.outcomeClass -Expected 'success' -Message "A '$freshOutcome' fresh cache sample takes the fallback and still succeeds."
        Assert-True -Condition (@($variantSink.Freeze() | Where-Object { $_.code -ceq 'consume-cache-fallback' }).Count -eq 1) -Message "A '$freshOutcome' fresh cache sample records the canonical-empty fallback warning."
    }

    # Private payloads are typed candidates whose nested documents retain the exact
    # validated representations; the context constructor rejects every invalid shape.
    $typedContext = [TurnContextPayloadContext]::new($digest.Materialized['source'], $false, $false, 0)
    $typedCandidate = New-ConsumePayload -DeliveryMode privateResult -Diff $diff -State $digest -Context $typedContext
    Assert-True -Condition ($typedCandidate -is [TurnContextPayloadCandidate]) -Message 'A private payload is a TurnContextPayloadCandidate.'
    Assert-True -Condition ([Text.Json.JsonElement]::DeepEquals($typedCandidate.Diff.RootElement, $diff.RootElement)) -Message 'The private candidate diff retains the exact validated representation.'
    Assert-True -Condition ([Text.Json.JsonElement]::DeepEquals($typedCandidate.State.RootElement, $digest.RootElement)) -Message 'The private candidate state retains the exact validated representation.'
    Assert-ThrowsType -TypeName 'System.ArgumentException' -Action { [TurnContextPayloadContext]::new($null, $false, $false, 0) }
    Assert-ThrowsType -TypeName 'System.ArgumentException' -Action { [TurnContextPayloadContext]::new($digest.Materialized['source'], $true, $false, -1) }
    Assert-ThrowsType -TypeName 'System.ArgumentException' -Action { [TurnContextPayloadContext]::new($digest.Materialized['source'], $true, $false, 4) }
    Assert-ThrowsType -TypeName 'System.ArgumentException' -Action { [TurnContextPayloadContext]::new($digest.Materialized['source'], $true, $false, 0) }
    Assert-ThrowsType -TypeName 'System.ArgumentException' -Action { [TurnContextPayloadContext]::new($digest.Materialized['source'], $false, $false, 1) }
    Assert-ThrowsType -TypeName 'System.ArgumentException' -Action { [TurnContextPayloadContext]::new($digest.Materialized['source'], $false, $true, 0) }

    # Poisoned failure injections at every private write boundary: the inspected
    # ConsumeResult.detail stays the exact class-owned registry literal and never
    # carries exception text, paths, or command-line fragments.
    $poison = 'POISON C:\secret --cmd'
    [IO.File]::Delete((Join-Path $Root 'state/baseline.json'))
    $poisonCases = [ordered]@{
        'payload-serialize-failed' = (Invoke-CompanionConsumption -AdapterConfig $config -CompanionRoot $Root -DeliveryMode rawStdout -WarningSink (New-CompanionWarningSink -Profile GetDiff) -WriteStdout { param($Text) } -SerializePayload { param($Payload) throw [IO.IOException]::new($poison) })
        'stdout-write-failed' = (Invoke-CompanionConsumption -AdapterConfig $config -CompanionRoot $Root -DeliveryMode rawStdout -WarningSink (New-CompanionWarningSink -Profile GetDiff) -WriteStdout { param($Text) throw [IO.IOException]::new($poison) })
        'baseline-temp-write-failed' = (Invoke-CompanionConsumption -AdapterConfig $config -CompanionRoot $Root -DeliveryMode rawStdout -WarningSink (New-CompanionWarningSink -Profile GetDiff) -WriteStdout { param($Text) } -WriteBaseline { param($RootPath, $Document) throw [IO.IOException]::new($poison) })
        'cache-temp-write-failed' = (Invoke-CompanionConsumption -AdapterConfig $config -CompanionRoot $Root -DeliveryMode rawStdout -WarningSink (New-CompanionWarningSink -Profile GetDiff) -WriteStdout { param($Text) } -WriteCache { param($RootPath, $Document) throw [IO.IOException]::new($poison) })
    }
    foreach ($expectedDetail in $poisonCases.Keys) {
        $poisoned = $poisonCases[$expectedDetail]
        Assert-OrdinalEqual -Actual $poisoned.detail -Expected $expectedDetail -Message "The '$expectedDetail' boundary reports its exact registry detail under a poisoned exception."
        Assert-False -Condition $poisoned.detail.Contains('POISON', [StringComparison]::Ordinal) -Message "The '$expectedDetail' boundary never leaks exception text into the detail."
        Assert-True -Condition (@($poisoned.detail.EnumerateRunes()).Count -le 512) -Message "The '$expectedDetail' detail respects the 512-scalar cap."
    }

    # Section 11 "Turn-context failure injection", reset-write stage split: baseline
    # serialization, temp-write, and replacement fail separately, and every
    # post-baseline cache stage (fresh validation, comparison, serialization,
    # temp write, replacement) carries its exact registry literal.
    [void] ([IO.Directory]::CreateDirectory((Join-Path $Root 'state')))
    foreach ($case in @(
            @{ stage = 'serialize'; detail = 'baseline-serialize-failed' },
            @{ stage = 'temp-write'; detail = 'baseline-temp-write-failed' },
            @{ stage = 'replace'; detail = 'baseline-replace-failed' })) {
        if ([IO.File]::Exists((Join-Path $Root 'state/baseline.json'))) { [IO.File]::Delete((Join-Path $Root 'state/baseline.json')) }
        $staged = Invoke-CompanionConsumption -AdapterConfig $config -CompanionRoot $Root -DeliveryMode rawStdout -WarningSink (New-CompanionWarningSink -Profile GetDiff) -WriteStdout { param($Text) } -WriteBaseline { param($RootPath, $Document) throw [CompanionStateWriteException]::new($case.stage, [IO.IOException]::new('injected')) }
        Assert-Equal -Actual $staged.outcomeClass -Expected 'reset-write:not-consumed' -Message "A baseline $($case.stage) failure keeps the not-consumed reset class."
        Assert-Equal -Actual $staged.consumptionState -Expected 'notConsumed' -Message "A baseline $($case.stage) failure never marks the diff consumed."
        Assert-OrdinalEqual -Actual $staged.detail -Expected $case.detail -Message "A baseline $($case.stage) failure carries its exact stage literal."
    }
    foreach ($case in @(
            @{ stage = 'serialize'; detail = 'cache-serialize-failed' },
            @{ stage = 'temp-write'; detail = 'cache-temp-write-failed' },
            @{ stage = 'replace'; detail = 'cache-replace-failed' })) {
        $staged = Invoke-CompanionConsumption -AdapterConfig $config -CompanionRoot $Root -DeliveryMode rawStdout -WarningSink (New-CompanionWarningSink -Profile GetDiff) -WriteStdout { param($Text) } -WriteCache { param($RootPath, $Document) throw [CompanionStateWriteException]::new($case.stage, [IO.IOException]::new('injected')) }
        Assert-Equal -Actual $staged.outcomeClass -Expected 'reset-write:consumed' -Message "A cache $($case.stage) failure keeps the consumed reset class."
        Assert-True -Condition $staged.cacheDegraded -Message "A cache $($case.stage) failure marks cache degradation."
        Assert-OrdinalEqual -Actual $staged.detail -Expected $case.detail -Message "A cache $($case.stage) failure carries its exact stage literal."
    }
    # Cache comparison failure: the second (fresh) read returns a money-incompatible
    # digest, so Compare-Digests throws after baseline advancement.
    $compareReads = [Collections.Generic.List[int]]::new()
    $incompatibleFresh = Read-DigestDocument -Json $DigestJson.Replace('"currency":"real"', '"currency":"dollar"')
    $compareFailure = Invoke-CompanionConsumption -AdapterConfig $config -CompanionRoot $Root -DeliveryMode rawStdout -WarningSink (New-CompanionWarningSink -Profile GetDiff) -WriteStdout { param($Text) } -ReadCurrent {
        param($RootPath, $Config)
        $compareReads.Add(1)
        if ($compareReads.Count -eq 1) { return [pscustomobject]@{ outcome = 'valid'; document = $digest; reason = $null } }

        return [pscustomobject]@{ outcome = 'valid'; document = $incompatibleFresh; reason = $null }
    }
    Assert-Equal -Actual $compareFailure.outcomeClass -Expected 'reset-write:consumed' -Message 'A cache comparison failure reports after baseline advancement.'
    Assert-OrdinalEqual -Actual $compareFailure.detail -Expected 'cache-compare-failed' -Message 'A cache comparison failure carries the compare literal.'

    # The validator invocation wrapper: untyped validator throws surface as
    # AdapterValidatorInfrastructureException; content rejections pass through.
    $wrapConfig = [AdapterCompatibilityConfig]::new()
    $wrapConfig.AdapterVersion = 2
    $wrapConfig.Game = 'example'
    $wrapConfig.SourceDomainId = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
    $wrapConfig.Validator = { param($RootElement) throw [InvalidOperationException]::new('machinery') }
    Assert-ThrowsType -TypeName 'AdapterValidatorInfrastructureException' -Action { Assert-AdapterDigestDocument -Document $digest -AdapterConfig $wrapConfig }
    $wrapConfig.Validator = { param($RootElement) throw [AdapterDigestValidationException]::new('content rejected') }
    Assert-ThrowsType -TypeName 'AdapterDigestValidationException' -Action { Assert-AdapterDigestDocument -Document $digest -AdapterConfig $wrapConfig }
    $wrapConfig.Validator = { param($RootElement) throw [AdapterConfigurationException]::new('validator config broke') }
    Assert-ThrowsType -TypeName 'AdapterValidatorInfrastructureException' -Action { Assert-AdapterDigestDocument -Document $digest -AdapterConfig $wrapConfig }
} @($root, $digestJson)

if ($Only -eq 'CacheInterleaving') {
    Invoke-InCompanionModule {
        param($Root, $DigestJson)

        $config = [AdapterCompatibilityConfig]::new()
        $config.AdapterVersion = 2
        $config.Game = 'example'
        $config.SourceDomainId = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
        $config.DiffExcludePaths = @()
        $config.Validator = { param($RootElement) }

        $digestA = Read-DigestDocument -Json $DigestJson
        $digestB = Read-DigestDocument -Json $DigestJson.Replace('"xp":0', '"xp":5')

        # Authoritative current starts at A and baseline settles at A before the race.
        [IO.File]::WriteAllText((Join-Path $Root 'state/baseline.json'), $DigestJson, [Text.UTF8Encoding]::new($false, $true))

        $emitted = [Collections.Generic.List[string]]::new()
        $reads = [Collections.Generic.List[int]]::new()
        $sink = New-CompanionWarningSink -Profile GetDiff
        $paused = Invoke-CompanionConsumption -AdapterConfig $config -CompanionRoot $Root -DeliveryMode rawStdout -WarningSink $sink -WriteStdout { param($Text) $emitted.Add($Text) } -ReadCurrent {
            param($RootPath, $Config)
            $reads.Add(1)
            if ($reads.Count -eq 2) {
                # While paused, the pipeline commits B and writes the A-to-B cache.
                Write-CompanionCurrent -CompanionRoot $RootPath -Document $digestB
                Write-CompanionDiffCache -CompanionRoot $RootPath -Document (Compare-Digests -Baseline $digestA -Target $digestB -AdapterConfig $Config -WarningSink $sink)
            }

            return [pscustomobject]@{ outcome = 'valid'; document = $digestA }
        }
        Assert-Equal -Actual $paused.outcomeClass -Expected 'success' -Message 'Interleaved consumer completes successfully.'

        # The consumer overwrote the pipeline cache with its stale sampled empty A-to-A result.
        $cache = Read-DiffDocument -Path (Join-Path $Root 'state/diff-since-last-read.json')
        Assert-False -Condition $cache.RootElement.GetProperty('hasChanges').GetBoolean() -Message 'Interleaved diagnostic cache finishes falsely empty.'

        # The authoritative sources survive the stale cache sample untouched.
        $baseline = Read-DigestDocument -Path (Join-Path $Root 'state/baseline.json')
        Assert-Equal -Actual ([long] $baseline.RootElement.GetProperty('character').GetProperty('xp').GetInt64()) -Expected ([long] 0) -Message 'Baseline remains authoritative at A.'
        $current = Read-DigestDocument -Path (Join-Path $Root 'state/current.json')
        Assert-Equal -Actual ([long] $current.RootElement.GetProperty('character').GetProperty('xp').GetInt64()) -Expected ([long] 5) -Message 'Current remains authoritative at B.'

        # The next consuming computation reads the authoritative A to B and reports the A-to-B change.
        $nextEmitted = [Collections.Generic.List[string]]::new()
        $next = Invoke-CompanionConsumption -AdapterConfig $config -CompanionRoot $Root -DeliveryMode rawStdout -WarningSink (New-CompanionWarningSink -Profile GetDiff) -WriteStdout { param($Text) $nextEmitted.Add($Text) }
        Assert-Equal -Actual $next.outcomeClass -Expected 'success' -Message 'Next consuming computation succeeds.'
        $nextDiff = Read-DiffDocument -Json $nextEmitted[0]
        Assert-Equal -Actual $nextDiff.RootElement.GetProperty('character').GetProperty('xpDelta').GetInt64() -Expected ([long] 5) -Message 'Next computation still reports A to B.'
        Assert-True -Condition $nextDiff.RootElement.GetProperty('hasChanges').GetBoolean() -Message 'Next computation sees the authoritative A-to-B change.'
    } @($root, $digestJson)
    Write-Output 'PASS: consumption'
    exit 0
}

# Preflight must distinguish a corrupt or unreadable current from version staleness;
# only a genuinely version-stale current keeps the stale-current remediation.
$preflightFixture = New-StagedGetDiffFixture -Prefix 'preflight-current-class' -DigestJson $digestJson
$preflightRoot = $preflightFixture.Root
$preflightCore = $preflightFixture.Core
$preflightDigest = $preflightFixture.Digest
$preflightState = $preflightFixture.State
[IO.Directory]::CreateDirectory($preflightState) | Out-Null
$preflightCurrent = Join-Path $preflightState 'current.json'

[IO.File]::WriteAllText($preflightCurrent, 'this is not json', [Text.UTF8Encoding]::new($false, $true))
$contentInvalid = Invoke-BoundedPwsh -Arguments @('-File', (Join-Path $preflightCore 'Get-Diff.ps1')) -WorkingDirectory $preflightRoot
Assert-Equal -Actual $contentInvalid.ExitCode -Expected 1 -Message 'Content-invalid current fails preflight.'
Assert-False -Condition $contentInvalid.StdErr.Contains('[stale-current]', [StringComparison]::Ordinal) -Message 'Content-invalid current is not reported as version staleness.'
Assert-True -Condition $contentInvalid.StdErr.Contains('[freshness] target-invalid', [StringComparison]::Ordinal) -Message 'Content-invalid current maps to freshness with target-invalid.'

[IO.File]::Delete($preflightCurrent)
[IO.Directory]::CreateDirectory($preflightCurrent) | Out-Null
$infrastructure = Invoke-BoundedPwsh -Arguments @('-File', (Join-Path $preflightCore 'Get-Diff.ps1')) -WorkingDirectory $preflightRoot
Assert-Equal -Actual $infrastructure.ExitCode -Expected 1 -Message 'Infrastructure-failure current fails preflight.'
Assert-False -Condition $infrastructure.StdErr.Contains('[stale-current]', [StringComparison]::Ordinal) -Message 'Infrastructure-failure current is not reported as version staleness.'
Assert-True -Condition $infrastructure.StdErr.Contains('[freshness] target-unreadable', [StringComparison]::Ordinal) -Message 'Infrastructure-failure current maps to freshness with target-unreadable.'

[IO.Directory]::Delete($preflightCurrent, $true)
[IO.File]::WriteAllText($preflightCurrent, $preflightDigest.Replace('"adapterVersion":2', '"adapterVersion":9'), [Text.UTF8Encoding]::new($false, $true))
$staleCurrent = Invoke-BoundedPwsh -Arguments @('-File', (Join-Path $preflightCore 'Get-Diff.ps1')) -WorkingDirectory $preflightRoot
Assert-Equal -Actual $staleCurrent.ExitCode -Expected 1 -Message 'Version-stale current fails preflight.'
Assert-True -Condition $staleCurrent.StdErr.Contains('[stale-current]', [StringComparison]::Ordinal) -Message 'Version-stale current keeps the stale-current remediation.'

# The live v1 consume entry rejects a path-traversal -Adapter before the legacy join.
$liveSecurityRoot = New-ScratchCompanionRoot -Prefix 'live-adapter-guard'
$liveSecurity = Invoke-BoundedPwsh -Arguments @('-File', (Join-Path $PSScriptRoot '../Get-Diff.ps1'), '-Adapter', '..\evil', '-CompanionRoot', $liveSecurityRoot) -WorkingDirectory $liveSecurityRoot
Assert-Equal -Actual $liveSecurity.ExitCode -Expected 1 -Message 'A traversal -Adapter is rejected as a configuration failure.'
Assert-True -Condition $liveSecurity.StdErr.StartsWith('get-diff: [config]', [StringComparison]::Ordinal) -Message 'A traversal -Adapter maps to the config class before adapter resolution.'

# The Get-Diff advisory prefilter maps a validator-infrastructure current read to
# [compute] with the registry reason, never to freshness or stale-current.
$advisoryInfraFixture = New-StagedGetDiffFixture -Prefix 'advisory-validator-infra' -DigestJson $digestJson -SeedCurrent
$advisoryValidator = Join-Path $advisoryInfraFixture.Root 'adapters/example/releases/2/schema-2/adapters/example/Validate-Digest.psm1'
[IO.File]::WriteAllText($advisoryValidator, "function Assert-AdapterDigestSemantics { param(`$Root) throw [InvalidOperationException]::new('validator machinery broke') }`nExport-ModuleMember -Function Assert-AdapterDigestSemantics`n", [Text.UTF8Encoding]::new($false, $true))
$advisoryInfra = Invoke-BoundedPwsh -Arguments @('-File', (Join-Path $advisoryInfraFixture.Core 'Get-Diff.ps1')) -WorkingDirectory $advisoryInfraFixture.Root
Assert-Equal -Actual $advisoryInfra.ExitCode -Expected 1 -Message 'Validator infrastructure at the advisory read fails Get-Diff.'
Assert-True -Condition $advisoryInfra.StdErr.Contains('[compute] adapter-validator-infrastructure-failed', [StringComparison]::Ordinal) -Message 'The advisory validator-infrastructure read maps to compute with the registry reason.'

Write-Output 'PASS: consumption'
