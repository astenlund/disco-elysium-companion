#Requires -Version 7.5

[CmdletBinding()]
param(
    [Parameter()]
    [ValidateSet('All', 'CurrentAdmission', 'StateWriter', 'WorkReaper')]
    [string] $Only = 'All'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Import-Module (Join-Path $PSScriptRoot 'TestSupport.psm1') -Force
Import-Module (Join-Path $PSScriptRoot '../DigestDiff.psm1') -Force

function Test-CurrentAdmission {
    $root = New-ScratchCompanionRoot -Prefix 'state-predicate'
    try {
        [void] [IO.Directory]::CreateDirectory((Join-Path $root 'state'))
        Assert-Equal -Actual (Read-CompanionCurrent -CompanionRoot $root).outcome -Expected 'absent' -Message 'Missing current is absent.'
        $currentPath = Join-Path $root 'state/current.json'
        [IO.File]::WriteAllText($currentPath, '{}', [Text.UTF8Encoding]::new($false))
        Assert-Equal -Actual (Read-CompanionCurrent -CompanionRoot $root).outcome -Expected 'content-invalid' -Message 'Invalid current is content-invalid.'
        $validDigest = '{"schemaVersion":2,"adapterVersion":2,"game":"example","generatedAt":"2026-08-10T12:00:00.0000000Z","source":{"domainId":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef","saveFile":"B.ntwtf.zip","savedAt":"2026-08-10T11:00:00.0000000Z","byteLength":1,"contentSha256":"abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd"},"session":{"day":1,"time":"08:09","location":"place","playtimeNote":null},"character":{"level":1,"xp":0,"unspentPoints":0,"money":{"amount":1.25,"minorUnits":125,"minorUnitsPerUnit":100,"currency":"real"},"vitals":[{"name":"health","value":1}],"skills":[{"name":"Logic","value":1,"group":"Intellect"}]},"objectives":[],"inventory":{"owned":[],"equipped":[],"highlights":[]},"extra":{}}'
        [IO.File]::WriteAllText($currentPath, $validDigest, [Text.UTF8Encoding]::new($false))
        Assert-Equal -Actual (Read-CompanionCurrent -CompanionRoot $root).outcome -Expected 'valid' -Message 'Valid current is admitted.'
        $staleOutcome = Invoke-InCompanionModule {
            param($CompanionRoot)

            $config = [AdapterCompatibilityConfig]::new()
            $config.AdapterVersion = 3
            $config.Game = 'example'
            $config.SourceDomainId = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'

            return (Read-CompanionCurrent -CompanionRoot $CompanionRoot -AdapterConfig $config -PrefilterOnly).outcome
        } @($root)
        Assert-Equal -Actual $staleOutcome -Expected 'stale' -Message 'Version-stale current is rejected before full admission.'
    }
    finally {
        Remove-Item -LiteralPath $root -Force -Recurse -ErrorAction SilentlyContinue
    }
}

function Test-StateWriter {
    $root = New-ScratchCompanionRoot -Prefix 'state-predicate'
    try {
        $statePath = Join-Path $root 'state/current.json'
        [void] [IO.Directory]::CreateDirectory((Split-Path -Parent $statePath))
        [IO.File]::WriteAllBytes($statePath, [byte[]](1))
        Write-CompanionStateBytes -Path $statePath -Bytes ([byte[]](2, 3))
        Assert-Equal -Actual ([string]::Join(',', [IO.File]::ReadAllBytes($statePath))) -Expected '2,3' -Message 'Writer publishes complete replacement bytes.'
        Assert-Equal -Actual @([IO.Directory]::GetFiles((Split-Path -Parent $statePath), '*.tmp')).Count -Expected 0 -Message 'Writer removes owned temporary files.'
    }
    finally {
        Remove-Item -LiteralPath $root -Force -Recurse -ErrorAction SilentlyContinue
    }
}

function Test-WorkReaper {
    $root = New-ScratchCompanionRoot -Prefix 'state-predicate'
    try {
        $state = Join-Path $root 'state'
        $tmp = Join-Path $root '.tmp'
        [void] [IO.Directory]::CreateDirectory($state)
        [void] [IO.Directory]::CreateDirectory($tmp)
        $stateTemp = Join-Path $state 'current.json.0123456789abcdef0123456789abcdef.tmp'
        $work = Join-Path $tmp 'work-orphan.json'
        [IO.File]::WriteAllText($stateTemp, '')
        [IO.File]::WriteAllText($work, '')
        $old = [datetime]::UtcNow.AddHours(-2)
        [IO.File]::SetLastWriteTimeUtc($stateTemp, $old)
        [IO.File]::SetLastWriteTimeUtc($work, $old)
        Invoke-WorkFileReaper -CompanionRoot $root -WarningSink (New-CompanionWarningSink -Profile Cycle)
        Assert-False -Condition ([IO.File]::Exists($stateTemp)) -Message 'Reaper deletes exact aged state temporary files.'
        Assert-False -Condition ([IO.File]::Exists($work)) -Message 'Reaper deletes aged unleased work files.'
    }
    finally {
        Remove-Item -LiteralPath $root -Force -Recurse -ErrorAction SilentlyContinue
    }
}

switch ($Only) {
    'CurrentAdmission' { Test-CurrentAdmission }
    'StateWriter' { Test-StateWriter }
    'WorkReaper' { Test-WorkReaper }
    'All' { Test-CurrentAdmission; Test-StateWriter; Test-WorkReaper }
}

Write-Output 'PASS: state predicate'
