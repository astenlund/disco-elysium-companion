#Requires -Version 7.5

[CmdletBinding()]
param(
    [Parameter()]
    [ValidateSet('All', 'MissingCurrent', 'PeekNonMutation', 'FirstRunClassification', 'MoneyCompatibility', 'StaleBaselineRecovery', 'ConsumptionLock', 'ResetOnRead', 'BaselineReadClassification', 'CacheInterleaving')]
    [string] $Only = 'All'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Import-Module (Join-Path $PSScriptRoot 'TestSupport.psm1') -Force
Import-Module (Join-Path $PSScriptRoot '../DigestDiff.psm1') -Force

$root = New-ScratchCompanionRoot -Prefix 'consumption'
$state = Join-Path $root 'state'
[IO.Directory]::CreateDirectory($state) | Out-Null
$digestJson = '{"schemaVersion":2,"adapterVersion":2,"game":"example","generatedAt":"2026-08-10T12:00:00.0000000Z","source":{"domainId":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef","saveFile":"B.ntwtf.zip","savedAt":"2026-08-10T11:00:00.0000000Z","byteLength":1,"contentSha256":"abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd"},"session":{"day":1,"time":"08:09","location":"place","playtimeNote":null},"character":{"level":1,"xp":0,"unspentPoints":0,"money":{"amount":1.25,"minorUnits":125,"minorUnitsPerUnit":100,"currency":"real"},"vitals":[{"name":"health","value":1}],"skills":[{"name":"Logic","value":1,"group":"Intellect"}]},"objectives":[{"id":"TASK.example","title":"example","status":"active","acquired":{"day":1,"time":"08:09"},"resolved":null,"subobjectives":[]}],"inventory":{"owned":["item"],"equipped":["item"],"highlights":[]},"extra":{}}'
[IO.File]::WriteAllText((Join-Path $state 'current.json'), $digestJson, [Text.UTF8Encoding]::new($false, $true))

$stagedRoot = New-ScratchCompanionRoot -Prefix 'staged-get-diff'
$stagedCore = Join-Path $stagedRoot 'core'
[IO.Directory]::CreateDirectory($stagedCore) | Out-Null
[IO.Directory]::CreateDirectory((Join-Path $stagedRoot 'adapters')) | Out-Null
[IO.Directory]::CreateDirectory((Join-Path $stagedRoot '.tmp')) | Out-Null
Copy-Item -LiteralPath (Join-Path $PSScriptRoot '../EntryFence.psm1') -Destination (Join-Path $stagedCore 'EntryFence.psm1')
Copy-Item -LiteralPath (Join-Path $PSScriptRoot '../DigestDiff.psm1') -Destination (Join-Path $stagedCore 'DigestDiff.psm1')
Copy-Item -LiteralPath (Join-Path $PSScriptRoot '../private') -Destination (Join-Path $stagedCore 'private') -Recurse
Copy-Item -LiteralPath (Join-Path $PSScriptRoot '../Get-Diff.ps1') -Destination (Join-Path $stagedCore 'Get-Diff.ps1')
$stagedAdapter = Join-Path $stagedRoot 'adapters/example'
$stagedRelease = Join-Path $stagedAdapter 'releases/2/schema-2/adapters/example'
$stagedSaves = Join-Path $stagedRoot 'saves'
[IO.Directory]::CreateDirectory($stagedRelease) | Out-Null
[IO.Directory]::CreateDirectory($stagedSaves) | Out-Null
[IO.File]::WriteAllText((Join-Path $stagedRelease 'Validate-Digest.psm1'), "function Assert-AdapterDigestSemantics { param(`$Root) }`nExport-ModuleMember -Function Assert-AdapterDigestSemantics`n", [Text.UTF8Encoding]::new($false, $true))
$stagedAdapterDocument = [ordered]@{ game = 'example'; adapterVersion = 2L; saveDirectory = $stagedSaves; saveGlob = '*.ntwtf.zip'; diffExcludePaths = @() }
[IO.File]::WriteAllText((Join-Path $stagedAdapter 'adapter.json'), (ConvertTo-CompanionJson -InputObject $stagedAdapterDocument -Budget config), [Text.UTF8Encoding]::new($false, $true))
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
$sourceDomainBytes = [Text.UTF8Encoding]::new($false, $true).GetBytes($stagedSaves + [char]0 + '*.ntwtf.zip')
$sourceDomain = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($sourceDomainBytes)).ToLowerInvariant()
$stagedDigest = $digestJson.Replace('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', $sourceDomain)
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

if ($Only -eq 'ResetOnRead') {
    $resetRoot = New-ScratchCompanionRoot -Prefix 'reset-on-read'
    $resetCore = Join-Path $resetRoot 'core'
    [IO.Directory]::CreateDirectory($resetCore) | Out-Null
    [IO.Directory]::CreateDirectory((Join-Path $resetRoot 'adapters')) | Out-Null
    [IO.Directory]::CreateDirectory((Join-Path $resetRoot '.tmp')) | Out-Null
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot '../EntryFence.psm1') -Destination (Join-Path $resetCore 'EntryFence.psm1')
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot '../DigestDiff.psm1') -Destination (Join-Path $resetCore 'DigestDiff.psm1')
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot '../private') -Destination (Join-Path $resetCore 'private') -Recurse
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot '../Get-Diff.ps1') -Destination (Join-Path $resetCore 'Get-Diff.ps1')
    $resetAdapter = Join-Path $resetRoot 'adapters/example'
    $resetRelease = Join-Path $resetAdapter 'releases/2/schema-2/adapters/example'
    $resetSaves = Join-Path $resetRoot 'saves'
    [IO.Directory]::CreateDirectory($resetRelease) | Out-Null
    [IO.Directory]::CreateDirectory($resetSaves) | Out-Null
    [IO.File]::WriteAllText((Join-Path $resetRelease 'Validate-Digest.psm1'), "function Assert-AdapterDigestSemantics { param(`$Root) }`nExport-ModuleMember -Function Assert-AdapterDigestSemantics`n", [Text.UTF8Encoding]::new($false, $true))
    $resetAdapterDocument = [ordered]@{ game = 'example'; adapterVersion = 2L; saveDirectory = $resetSaves; saveGlob = '*.ntwtf.zip'; diffExcludePaths = @() }
    [IO.File]::WriteAllText((Join-Path $resetAdapter 'adapter.json'), (ConvertTo-CompanionJson -InputObject $resetAdapterDocument -Budget config), [Text.UTF8Encoding]::new($false, $true))
    $resetDomainBytes = [Text.UTF8Encoding]::new($false, $true).GetBytes($resetSaves + [char]0 + '*.ntwtf.zip')
    $resetDomain = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($resetDomainBytes)).ToLowerInvariant()
    $resetDigest = $digestJson.Replace('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', $resetDomain)
    $resetState = Join-Path $resetRoot 'state'
    [IO.Directory]::CreateDirectory($resetState) | Out-Null
    [IO.File]::WriteAllText((Join-Path $resetState 'current.json'), $resetDigest, [Text.UTF8Encoding]::new($false, $true))

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
    Assert-False -Condition ([IO.File]::Exists((Join-Path $Root 'state/baseline.json'))) -Message 'Raw stream failure leaves the baseline untouched.'

    $baselineFailure = Invoke-CompanionConsumption -AdapterConfig $config -CompanionRoot $Root -DeliveryMode rawStdout -WarningSink (New-CompanionWarningSink -Profile GetDiff) -WriteStdout { param($Text) } -WriteBaseline { param($Root, $Document) throw [IO.IOException]::new('baseline write failed') }
    Assert-Equal -Actual $baselineFailure.outcomeClass -Expected 'reset-write:not-consumed' -Message 'Baseline write failure preserves the emitted diff for the next full read.'
    Assert-Equal -Actual $baselineFailure.consumptionState -Expected 'notConsumed' -Message 'Baseline write failure never marks the diff consumed.'

    $cacheFailure = Invoke-CompanionConsumption -AdapterConfig $config -CompanionRoot $Root -DeliveryMode rawStdout -WarningSink (New-CompanionWarningSink -Profile GetDiff) -WriteStdout { param($Text) } -WriteCache { param($RootPath, $Document) throw [IO.IOException]::new('cache write failed') }
    Assert-Equal -Actual $cacheFailure.outcomeClass -Expected 'reset-write:consumed' -Message 'Cache write failure reports the already-consumed diff.'
    Assert-True -Condition $cacheFailure.cacheDegraded -Message 'Cache write failure marks the diagnostic cache degraded.'
    Assert-True -Condition ([IO.File]::Exists((Join-Path $Root 'state/baseline.json'))) -Message 'Cache write failure leaves the authoritative baseline advanced.'

    $busy = Invoke-CompanionConsumption -AdapterConfig $config -CompanionRoot $Root -DeliveryMode rawStdout -WarningSink (New-CompanionWarningSink -Profile GetDiff) -EnterConsumeLock { param($RootPath) throw [TimeoutException]::new('busy') }
    Assert-Equal -Actual $busy.outcomeClass -Expected 'busy' -Message 'Consume-lock contention returns busy without payload or mutation.'

    [IO.File]::WriteAllText((Join-Path $Root 'state/baseline.json'), $DigestJson.Replace('T11:00:00', 'T13:00:00'), [Text.UTF8Encoding]::new($false, $true))
    $stale = Invoke-CompanionConsumption -AdapterConfig $config -CompanionRoot $Root -DeliveryMode rawStdout -WarningSink (New-CompanionWarningSink -Profile GetDiff) -WriteStdout { param($Text) }
    Assert-Equal -Actual $stale.outcomeClass -Expected 'stale-target' -Message 'A target that precedes the baseline never rewinds it.'

    [IO.File]::Delete((Join-Path $Root 'state/baseline.json'))
    $floor = @{ domainId = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'; saveFile = 'C.ntwtf.zip'; savedAt = '2026-08-10T13:00:00.0000000Z' }
    $freshness = Invoke-CompanionConsumption -AdapterConfig $config -CompanionRoot $Root -DeliveryMode rawStdout -SourceFloor $floor -WarningSink (New-CompanionWarningSink -Profile GetDiff) -WriteStdout { param($Text) }
    Assert-Equal -Actual $freshness.outcomeClass -Expected 'freshness' -Message 'A target below the caller source floor is rejected before baseline mutation.'
    Assert-False -Condition ([IO.File]::Exists((Join-Path $Root 'state/baseline.json'))) -Message 'Source-floor rejection leaves baseline absent.'

    $missingTarget = Invoke-CompanionConsumption -AdapterConfig $config -CompanionRoot $Root -DeliveryMode rawStdout -WarningSink (New-CompanionWarningSink -Profile GetDiff) -ReadCurrent { param($RootPath, $Config) [pscustomobject]@{ outcome = 'absent'; document = $null } }
    Assert-Equal -Actual $missingTarget.outcomeClass -Expected 'freshness' -Message 'Missing authoritative target is returned before any baseline read or mutation.'

    $invalidTarget = Invoke-CompanionConsumption -AdapterConfig $config -CompanionRoot $Root -DeliveryMode rawStdout -WarningSink (New-CompanionWarningSink -Profile GetDiff) -ReadCurrent { param($RootPath, $Config) [pscustomobject]@{ outcome = 'content-invalid'; document = $null } }
    Assert-Equal -Actual $invalidTarget.outcomeClass -Expected 'freshness' -Message 'Content-invalid authoritative target is returned before baseline mutation.'

    $staleCurrent = Invoke-CompanionConsumption -AdapterConfig $config -CompanionRoot $Root -DeliveryMode rawStdout -WarningSink (New-CompanionWarningSink -Profile GetDiff) -ReadCurrent { param($RootPath, $Config) [pscustomobject]@{ outcome = 'stale'; document = $null } }
    Assert-Equal -Actual $staleCurrent.outcomeClass -Expected 'freshness' -Message 'Version-stale authoritative target is returned before baseline mutation.'

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
$preflightRoot = New-ScratchCompanionRoot -Prefix 'preflight-current-class'
$preflightCore = Join-Path $preflightRoot 'core'
[IO.Directory]::CreateDirectory($preflightCore) | Out-Null
[IO.Directory]::CreateDirectory((Join-Path $preflightRoot 'adapters')) | Out-Null
[IO.Directory]::CreateDirectory((Join-Path $preflightRoot '.tmp')) | Out-Null
Copy-Item -LiteralPath (Join-Path $PSScriptRoot '../EntryFence.psm1') -Destination (Join-Path $preflightCore 'EntryFence.psm1')
Copy-Item -LiteralPath (Join-Path $PSScriptRoot '../DigestDiff.psm1') -Destination (Join-Path $preflightCore 'DigestDiff.psm1')
Copy-Item -LiteralPath (Join-Path $PSScriptRoot '../private') -Destination (Join-Path $preflightCore 'private') -Recurse
Copy-Item -LiteralPath (Join-Path $PSScriptRoot '../Get-Diff.ps1') -Destination (Join-Path $preflightCore 'Get-Diff.ps1')
$preflightAdapter = Join-Path $preflightRoot 'adapters/example'
$preflightRelease = Join-Path $preflightAdapter 'releases/2/schema-2/adapters/example'
$preflightSaves = Join-Path $preflightRoot 'saves'
[IO.Directory]::CreateDirectory($preflightRelease) | Out-Null
[IO.Directory]::CreateDirectory($preflightSaves) | Out-Null
[IO.File]::WriteAllText((Join-Path $preflightRelease 'Validate-Digest.psm1'), "function Assert-AdapterDigestSemantics { param(`$Root) }`nExport-ModuleMember -Function Assert-AdapterDigestSemantics`n", [Text.UTF8Encoding]::new($false, $true))
$preflightAdapterDocument = [ordered]@{ game = 'example'; adapterVersion = 2L; saveDirectory = $preflightSaves; saveGlob = '*.ntwtf.zip'; diffExcludePaths = @() }
[IO.File]::WriteAllText((Join-Path $preflightAdapter 'adapter.json'), (ConvertTo-CompanionJson -InputObject $preflightAdapterDocument -Budget config), [Text.UTF8Encoding]::new($false, $true))
$preflightDomainBytes = [Text.UTF8Encoding]::new($false, $true).GetBytes($preflightSaves + [char]0 + '*.ntwtf.zip')
$preflightDomain = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($preflightDomainBytes)).ToLowerInvariant()
$preflightDigest = $digestJson.Replace('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', $preflightDomain)
$preflightState = Join-Path $preflightRoot 'state'
[IO.Directory]::CreateDirectory($preflightState) | Out-Null
$preflightCurrent = Join-Path $preflightState 'current.json'

[IO.File]::WriteAllText($preflightCurrent, 'this is not json', [Text.UTF8Encoding]::new($false, $true))
$contentInvalid = Invoke-BoundedPwsh -Arguments @('-File', (Join-Path $preflightCore 'Get-Diff.ps1')) -WorkingDirectory $preflightRoot
Assert-Equal -Actual $contentInvalid.ExitCode -Expected 1 -Message 'Content-invalid current fails preflight.'
Assert-False -Condition $contentInvalid.StdErr.Contains('[stale-current]', [StringComparison]::Ordinal) -Message 'Content-invalid current is not reported as version staleness.'
Assert-True -Condition $contentInvalid.StdErr.Contains('[freshness]', [StringComparison]::Ordinal) -Message 'Content-invalid current maps to the freshness class.'

[IO.File]::Delete($preflightCurrent)
[IO.Directory]::CreateDirectory($preflightCurrent) | Out-Null
$infrastructure = Invoke-BoundedPwsh -Arguments @('-File', (Join-Path $preflightCore 'Get-Diff.ps1')) -WorkingDirectory $preflightRoot
Assert-Equal -Actual $infrastructure.ExitCode -Expected 1 -Message 'Infrastructure-failure current fails preflight.'
Assert-False -Condition $infrastructure.StdErr.Contains('[stale-current]', [StringComparison]::Ordinal) -Message 'Infrastructure-failure current is not reported as version staleness.'
Assert-True -Condition $infrastructure.StdErr.Contains('[freshness]', [StringComparison]::Ordinal) -Message 'Infrastructure-failure current maps to the freshness class.'

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

Write-Output 'PASS: consumption'
