#Requires -Version 7.5

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Import-Module (Join-Path $PSScriptRoot 'TestSupport.psm1') -Force
Import-Module (Join-Path $PSScriptRoot '../DigestDiff.psm1') -Force

$root = New-ScratchCompanionRoot -Prefix 'state-files'
$state = Join-Path $root 'state'
$tmp = Join-Path $root '.tmp'
[IO.Directory]::CreateDirectory($state) | Out-Null
[IO.Directory]::CreateDirectory($tmp) | Out-Null

Invoke-InCompanionModule {
    param($Root, $State, $Tmp)

    $target = Join-Path $State 'current.json'
    Assert-Equal -Actual (Read-CompanionBaseline -CompanionRoot $Root).outcome -Expected 'absent' -Message 'Missing baseline is distinct from invalid content.'
    Assert-Equal -Actual (Read-CompanionCurrent -CompanionRoot $Root).outcome -Expected 'absent' -Message 'Missing current is distinct from invalid content.'
    [IO.File]::WriteAllText((Join-Path $State 'baseline.json'), '{}')
    [IO.File]::WriteAllText($target, '{}')
    Assert-Equal -Actual (Read-CompanionBaseline -CompanionRoot $Root).outcome -Expected 'content-invalid' -Message 'Invalid baseline bytes classify as content-invalid.'
    Assert-Equal -Actual (Read-CompanionCurrent -CompanionRoot $Root).outcome -Expected 'content-invalid' -Message 'Invalid current bytes classify as content-invalid.'
    $validDigest = '{"schemaVersion":2,"adapterVersion":2,"game":"example","generatedAt":"2026-08-10T12:00:00.0000000Z","source":{"domainId":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef","saveFile":"B.ntwtf.zip","savedAt":"2026-08-10T11:00:00.0000000Z","byteLength":1,"contentSha256":"abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd"},"session":{"day":1,"time":"08:09","location":"place","playtimeNote":null},"character":{"level":1,"xp":0,"unspentPoints":0,"money":{"amount":1.25,"minorUnits":125,"minorUnitsPerUnit":100,"currency":"real"},"vitals":[{"name":"health","value":1}],"skills":[{"name":"Logic","value":1,"group":"Intellect"}]},"objectives":[{"id":"TASK.example","title":"example","status":"active","acquired":{"day":1,"time":"08:09"},"resolved":null,"subobjectives":[]}],"inventory":{"owned":["item"],"equipped":["item"],"highlights":[]},"extra":{}}'
    [IO.File]::WriteAllText($target, $validDigest, [Text.UTF8Encoding]::new($false, $true))
    Assert-Equal -Actual (Read-CompanionCurrent -CompanionRoot $Root).outcome -Expected 'valid' -Message 'Valid current digest is admitted.'
    $staleOutcome = Invoke-InCompanionModule {
        param($Root)
        $config = [AdapterCompatibilityConfig]::new()
        $config.AdapterVersion = 3
        $config.Game = 'example'
        $config.SourceDomainId = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
        return (Read-CompanionCurrent -CompanionRoot $Root -AdapterConfig $config -PrefilterOnly).outcome
    } @($Root)
    Assert-Equal -Actual $staleOutcome -Expected 'stale' -Message 'Current prefilter identifies version-stale state before full admission.'
    $baselinePath = Join-Path $State 'baseline.json'
    [IO.File]::Delete($baselinePath)
    [IO.Directory]::CreateDirectory($baselinePath) | Out-Null
    Assert-Equal -Actual (Read-CompanionBaseline -CompanionRoot $Root).outcome -Expected 'infrastructure-failure' -Message 'Unreadable baseline path is not treated as resettable absence.'
    [IO.Directory]::Delete($baselinePath)
    [IO.File]::WriteAllBytes($target, [byte[]](1, 2, 3))
    Write-CompanionStateBytes -Path $target -Bytes ([byte[]](4, 5, 6))
    Assert-Equal -Actual ([string]::Join(',', [IO.File]::ReadAllBytes($target))) -Expected '4,5,6' -Message 'Atomic writer replaces complete bytes.'
    Assert-Equal -Actual @([IO.Directory]::GetFiles($State, '*.tmp')).Count -Expected 0 -Message 'Atomic writer removes its owned temp.'
    $sharingCalls = [Collections.Generic.List[int]]::new()
    $delays = [Collections.Generic.List[int]]::new()
    Assert-ThrowsType -TypeName 'System.IO.IOException' -Action {
        Write-CompanionStateBytes -Path $target -Bytes ([byte[]](7)) -Replace {
            param($Temp, $Target)
            $sharingCalls.Add(1)
            throw [IO.IOException]::new('sharing violation', 32)
        } -Delay {
            param($Milliseconds)
            $delays.Add($Milliseconds)
        }
    }
    Assert-Equal -Actual $sharingCalls.Count -Expected 5 -Message 'Atomic writer retries sharing violations exactly five times.'
    Assert-Equal -Actual ([string]::Join(',', $delays)) -Expected '40,80,120,160' -Message 'Atomic writer uses the exact sharing backoff sequence.'
    Assert-Equal -Actual ([string]::Join(',', [IO.File]::ReadAllBytes($target))) -Expected '4,5,6' -Message 'Failed replacement preserves the last complete target.'
    $otherCalls = [Collections.Generic.List[int]]::new()
    Assert-ThrowsType -TypeName 'System.UnauthorizedAccessException' -Action {
        Write-CompanionStateBytes -Path $target -Bytes ([byte[]](8)) -Replace {
            param($Temp, $Target)
            $otherCalls.Add(1)
            throw [UnauthorizedAccessException]::new('denied')
        }
    }
    Assert-Equal -Actual $otherCalls.Count -Expected 1 -Message 'Atomic writer does not retry non-sharing failures.'
    $createCalls = [Collections.Generic.List[int]]::new()
    Assert-ThrowsType -TypeName 'System.IO.IOException' -Action {
        Write-CompanionStateBytes -Path $target -Bytes ([byte[]](9)) -CreateStream {
            param($Temp)
            $createCalls.Add(1)
            throw [IO.IOException]::new('create failed')
        }
    }
    Assert-Equal -Actual $createCalls.Count -Expected 1 -Message 'Create failure performs no retry.'
    $createdTemps = [Collections.Generic.List[string]]::new()
    Assert-ThrowsType -TypeName 'System.IO.IOException' -Action {
        Write-CompanionStateBytes -Path $target -Bytes ([byte[]](9)) -CreateStream {
            param($Temp)
            $createdTemps.Add($Temp)
            [IO.FileStream]::new($Temp, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        } -WriteBytes {
            param($Stream, $Value)
            throw [IO.IOException]::new('write failed')
        }
    }
    Assert-Equal -Actual $createdTemps.Count -Expected 1 -Message 'Writer creates one owned sibling before a write failure.'
    Assert-False -Condition ([IO.File]::Exists($createdTemps[0])) -Message 'Writer removes only its owned temp after a write failure.'
    Assert-Equal -Actual ([string]::Join(',', [IO.File]::ReadAllBytes($target))) -Expected '4,5,6' -Message 'Write failure preserves the target bytes.'
    foreach ($stage in 'flush', 'close') {
        $stageTemps = [Collections.Generic.List[string]]::new()
        Assert-ThrowsType -TypeName 'System.IO.IOException' -Action {
            $create = { param($Temp) $stageTemps.Add($Temp); [IO.FileStream]::new($Temp, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None) }
            if ($stage -ceq 'flush') {
                Write-CompanionStateBytes -Path $target -Bytes ([byte[]](10)) -CreateStream $create -FlushStream { param($Stream) throw [IO.IOException]::new('flush failed') }
            }
            else {
                Write-CompanionStateBytes -Path $target -Bytes ([byte[]](10)) -CreateStream $create -CloseStream { param($Stream) $Stream.Dispose(); throw [IO.IOException]::new('close failed') }
            }
        }
        Assert-False -Condition ([IO.File]::Exists($stageTemps[0])) -Message "$stage failure cleans its owned temp."
    }
    $readyPath = Join-Path $Tmp 'reader-ready'
    $releasePath = Join-Path $Tmp 'reader-release'
    $readerProgram = '$share = [System.Enum]::ToObject([IO.FileShare], 7); $handle = [IO.File]::Open($env:COMPANION_TEST_TARGET,[IO.FileMode]::Open,[IO.FileAccess]::Read,$share); try { [IO.File]::WriteAllText($env:COMPANION_TEST_READY,''ready''); while (-not [IO.File]::Exists($env:COMPANION_TEST_RELEASE)) { Start-Sleep -Milliseconds 10 } } finally { $handle.Dispose() }'
    $reader = Start-BoundedPwsh -Arguments @('-Command', $readerProgram) -Environment @{
        COMPANION_TEST_TARGET = $target
        COMPANION_TEST_READY = $readyPath
        COMPANION_TEST_RELEASE = $releasePath
    }
    try {
        Wait-TestSentinel -Path $readyPath
        Write-CompanionStateBytes -Path $target -Bytes ([byte[]](11, 12))
        Assert-Equal -Actual ([string]::Join(',', [IO.File]::ReadAllBytes($target))) -Expected '11,12' -Message 'Share-friendly reader permits atomic replacement.'
        [IO.File]::WriteAllText($releasePath, 'release')
        $readerResult = Complete-BoundedPwsh -Child $reader -TimeoutMilliseconds 5000
        Assert-Equal -Actual $readerResult.ExitCode -Expected 0 -Message 'Shared reader exits cleanly.'
    }
    finally {
        Stop-BoundedPwsh -Child $reader
    }

    $cycle = Enter-CompanionCycleLock -CompanionRoot $Root -TimeoutMilliseconds 0
    try {
        Assert-ThrowsType -TypeName 'System.TimeoutException' -Action { Enter-CompanionCycleLock -CompanionRoot $Root -TimeoutMilliseconds 0 }
    }
    finally {
        $cycle.Dispose()
    }
    $cycleAgain = Enter-CompanionCycleLock -CompanionRoot $Root -TimeoutMilliseconds 0
    $cycleAgain.Dispose()

    $consume = Enter-CompanionConsumeLock -CompanionRoot $Root -TimeoutMilliseconds 0
    $consume.Dispose()
    $cancelSource = [Threading.CancellationTokenSource]::new()
    $cancelSource.Cancel()
    Assert-ThrowsType -TypeName 'System.OperationCanceledException' -Action { Enter-CompanionCycleLock -CompanionRoot $Root -TimeoutMilliseconds 100 -CancellationToken $cancelSource.Token }

    $agedWork = Join-Path $Tmp 'work-cycle-0123456789abcdef0123456789abcdef.lease'
    $agedMember = Join-Path $Tmp 'work-cycle-0123456789abcdef0123456789abcdef-dump.json'
    [IO.File]::WriteAllText($agedWork, '')
    [IO.File]::WriteAllText($agedMember, '')
    $old = [datetime]::UtcNow.AddHours(-2)
    [IO.File]::SetLastWriteTimeUtc($agedWork, $old)
    [IO.File]::SetLastWriteTimeUtc($agedMember, $old)
    $agedStateTemp = Join-Path $State 'baseline.json.0123456789abcdef0123456789abcdef.tmp'
    [IO.File]::WriteAllText($agedStateTemp, '')
    [IO.File]::SetLastWriteTimeUtc($agedStateTemp, $old)
    $nearMatch = Join-Path $State 'baseline.json.0123456789abcdef0123456789abcdef.tmpx'
    [IO.File]::WriteAllText($nearMatch, '')
    [IO.File]::SetLastWriteTimeUtc($nearMatch, $old)
    $metadataFaultTemp = Join-Path $State 'current.json.abcdefabcdefabcdefabcdefabcdefab.tmp'
    [IO.File]::WriteAllText($metadataFaultTemp, '')
    [IO.File]::SetLastWriteTimeUtc($metadataFaultTemp, $old)
    $unleasedWork = Join-Path $Tmp 'work-orphan.json'
    [IO.File]::WriteAllText($unleasedWork, '')
    [IO.File]::SetLastWriteTimeUtc($unleasedWork, $old)
    $liveLease = Join-Path $Tmp 'work-cycle-fedcba9876543210fedcba9876543210.lease'
    $liveMember = Join-Path $Tmp 'work-cycle-fedcba9876543210fedcba9876543210-dump.json'
    [IO.File]::WriteAllText($liveLease, '')
    [IO.File]::WriteAllText($liveMember, '')
    [IO.File]::SetLastWriteTimeUtc($liveLease, $old)
    $liveHandle = [IO.FileStream]::new($liveLease, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)

    $sink = New-CompanionWarningSink -Profile Cycle
    try {
        Invoke-WorkFileReaper -CompanionRoot $Root -WarningSink $sink -GetMetadata {
            param($Entry)
            if ($Entry.Name -ceq 'current.json.abcdefabcdefabcdefabcdefabcdefab.tmp') {
                throw [IO.IOException]::new('metadata failed')
            }
            [pscustomobject]@{ lastWriteTimeUtc = $Entry.LastWriteTimeUtc }
        }
        Assert-True -Condition ([IO.File]::Exists($liveLease)) -Message 'Reaper preserves a live canonical lease.'
        Assert-True -Condition ([IO.File]::Exists($liveMember)) -Message 'Reaper preserves members of a live lease group.'
    }
    finally {
        $liveHandle.Dispose()
    }
    Assert-True -Condition ([IO.File]::Exists($metadataFaultTemp)) -Message 'Metadata failure preserves only its affected state temp.'
    Invoke-WorkFileReaper -CompanionRoot $Root -WarningSink $sink
    Assert-False -Condition ([IO.File]::Exists($agedWork)) -Message 'Reaper deletes released aged lease last.'
    Assert-False -Condition ([IO.File]::Exists($agedMember)) -Message 'Reaper deletes aged lease member.'
    Assert-False -Condition ([IO.File]::Exists($agedStateTemp)) -Message 'Reaper deletes exact aged state temp.'
    Assert-True -Condition ([IO.File]::Exists($nearMatch)) -Message 'Reaper preserves near-match state temp.'
    Assert-False -Condition ([IO.File]::Exists($unleasedWork)) -Message 'Reaper deletes aged unleased work files.'

    $tmpOnlyState = Join-Path $State 'current.json.1234567890abcdef1234567890abcdef.tmp'
    $tmpOnlyWork = Join-Path $Tmp 'work-tmp-only.json'
    [IO.File]::WriteAllText($tmpOnlyState, '')
    [IO.File]::WriteAllText($tmpOnlyWork, '')
    [IO.File]::SetLastWriteTimeUtc($tmpOnlyState, $old)
    [IO.File]::SetLastWriteTimeUtc($tmpOnlyWork, $old)
    Invoke-WorkFileReaper -CompanionRoot $Root -WarningSink $sink -TmpOnly
    Assert-True -Condition ([IO.File]::Exists($tmpOnlyState)) -Message 'TmpOnly never enumerates or reaps state.'
    Assert-False -Condition ([IO.File]::Exists($tmpOnlyWork)) -Message 'TmpOnly still reaps its tmp root.'

    $overflowStateTemp = Join-Path $State 'current.json.abcdef0123456789abcdef0123456789.tmp'
    [IO.File]::WriteAllText($overflowStateTemp, '')
    [IO.File]::SetLastWriteTimeUtc($overflowStateTemp, $old)
    foreach ($index in 0..65536) {
        [IO.File]::WriteAllText((Join-Path $State ("limit-$index")), '')
    }
    $otherRootWork = Join-Path $Tmp 'work-other-root.json'
    [IO.File]::WriteAllText($otherRootWork, '')
    [IO.File]::SetLastWriteTimeUtc($otherRootWork, $old)
    $limitSink = New-CompanionWarningSink -Profile Cycle
    Invoke-WorkFileReaper -CompanionRoot $Root -WarningSink $limitSink
    Assert-True -Condition ([IO.File]::Exists($overflowStateTemp)) -Message 'Overflowed state root remains untouched.'
    Assert-False -Condition ([IO.File]::Exists($otherRootWork)) -Message 'State discovery overflow does not stop tmp processing.'
    Assert-Equal -Actual $limitSink.Freeze().Count -Expected 1 -Message 'Overflowed root produces one deduplicated warning.'

    foreach ($index in 0..65536) {
        [IO.File]::WriteAllText((Join-Path $Tmp ("tmp-limit-$index")), '')
    }
    $tmpOverflowSink = New-CompanionWarningSink -Profile Cycle
    Invoke-WorkFileReaper -CompanionRoot $Root -WarningSink $tmpOverflowSink -TmpOnly
    Assert-Equal -Actual $tmpOverflowSink.Freeze().Count -Expected 1 -Message 'Tmp cap-plus-one produces one root-local warning.'
    Assert-True -Condition ([IO.File]::Exists($overflowStateTemp)) -Message 'TmpOnly cap overflow does not touch state.'

    # Typed stage classification: every failure escaping the atomic writer names the
    # exact stage (serialize, temp-write, replace) with the original as InnerException.
    $stageProbe = {
        param([scriptblock] $Action)
        try { & $Action } catch [CompanionStateWriteException] { return $_.Exception.Stage }

        return $null
    }
    Assert-OrdinalEqual -Actual (& $stageProbe { Write-CompanionStateBytes -Path $target -Bytes ([byte[]](1)) -CreateStream { param($Temp) throw [IO.IOException]::new('create failed') } }) -Expected 'temp-write' -Message 'Create-stream failure classifies as the temp-write stage.'
    Assert-OrdinalEqual -Actual (& $stageProbe { Write-CompanionStateBytes -Path $target -Bytes ([byte[]](1)) -WriteBytes { param($Stream, $Value) throw [IO.IOException]::new('write failed') } }) -Expected 'temp-write' -Message 'Byte-write failure classifies as the temp-write stage.'
    Assert-OrdinalEqual -Actual (& $stageProbe { Write-CompanionStateBytes -Path $target -Bytes ([byte[]](1)) -FlushStream { param($Stream) throw [IO.IOException]::new('flush failed') } }) -Expected 'temp-write' -Message 'Flush failure classifies as the temp-write stage.'
    Assert-OrdinalEqual -Actual (& $stageProbe { Write-CompanionStateBytes -Path $target -Bytes ([byte[]](1)) -Replace { param($Temp, $TargetPath, $Backup) throw [UnauthorizedAccessException]::new('denied') } }) -Expected 'replace' -Message 'Replacement failure classifies as the replace stage.'
    $missingTarget = Join-Path $State 'never-existed.json'
    Assert-OrdinalEqual -Actual (& $stageProbe { Write-CompanionStateBytes -Path $missingTarget -Bytes ([byte[]](1)) -Move { param($Temp, $TargetPath) throw [IO.IOException]::new('move failed') } }) -Expected 'replace' -Message 'First-write move failure classifies as the replace stage.'
    Assert-OrdinalEqual -Actual (& $stageProbe { Write-CompanionStateJson -Path $target -Document ([ordered]@{ bad = { 1 } }) -Budget config }) -Expected 'serialize' -Message 'Serialization failure classifies as the serialize stage.'
    # Real-IO stage proof with no injected seams: a directory squatting on the target
    # path makes the atomic move itself fail (the target-exists probe sees no FILE, so
    # the writer takes the Move branch and the move onto a directory throws).
    $squatTarget = Join-Path $State 'squat.json'
    [void] ([IO.Directory]::CreateDirectory($squatTarget))
    Assert-OrdinalEqual -Actual (& $stageProbe { Write-CompanionStateBytes -Path $squatTarget -Bytes ([byte[]](1)) }) -Expected 'replace' -Message 'A real move onto a squatting directory classifies as the replace stage without seams.'
    [IO.Directory]::Delete($squatTarget)
    $innerPreserved = $null
    try { Write-CompanionStateBytes -Path $target -Bytes ([byte[]](1)) -CreateStream { param($Temp) throw [IO.IOException]::new('inner marker') } }
    catch [CompanionStateWriteException] { $innerPreserved = $_.Exception.InnerException.Message }
    Assert-OrdinalEqual -Actual $innerPreserved -Expected 'inner marker' -Message 'The stage exception wraps the original failure as InnerException.'
} @($root, $state, $tmp)

Write-Output 'PASS: state files'
