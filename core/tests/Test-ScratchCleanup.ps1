#Requires -Version 7.5

[CmdletBinding()]
param(
    [Parameter()]
    [ValidateSet('All', 'Removal', 'ConcurrentSweep', IgnoreCase = $false)]
    [string] $Only = 'All',

    # The concurrent race is rare per sweep, so the stress rounds trade run time for the
    # chance of meeting it; a passing run is evidence, not proof, that removal tolerates it.
    [Parameter()] [ValidateRange(1, 1000)] [int] $Rounds = 40,
    [Parameter()] [ValidateRange(2, 16)] [int] $Sweepers = 6
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Import-Module (Join-Path $PSScriptRoot 'TestSupport.psm1') -Force

$script:TestSupport = Get-Module TestSupport
$script:ProjectTmp = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../.tmp'))
$script:Utf8 = [Text.UTF8Encoding]::new($false, $true)
$script:ClaimPattern = '^scratch-sweep-claim-([0-9]+)-[0-9a-f]{32}$'

function Test-Selected {
    param([Parameter(Mandatory)] [string] $Name)

    return $Only -ceq 'All' -or $Only -ceq $Name
}

function New-ScratchTree {
    param([Parameter(Mandatory)] [string] $Root, [int] $Directories = 60, [int] $FilesPerDirectory = 60)

    for ($directory = 0; $directory -lt $Directories; $directory++) {
        $leaf = Join-Path $Root "d$directory/a/b/c"
        [void] [IO.Directory]::CreateDirectory($leaf)
        for ($file = 0; $file -lt $FilesPerDirectory; $file++) { [IO.File]::WriteAllText((Join-Path $leaf "f$file.txt"), 'x', $script:Utf8) }
    }
}

function Invoke-StaleRootRemoval {
    param([Parameter(Mandatory)] [string] $Path, [scriptblock] $Remove)

    if ($null -eq $Remove) {
        & $script:TestSupport { param($Path) Remove-StaleScratchRoot -Path $Path } $Path
    }
    else {
        & $script:TestSupport { param($Path, $Remove) Remove-StaleScratchRoot -Path $Path -Remove $Remove } $Path $Remove
    }
}

function Get-ClaimNames {
    param([Parameter(Mandatory)] [string] $Directory, [Parameter(Mandatory)] [int[]] $ProcessIds)

    return @([IO.Directory]::GetFileSystemEntries($Directory) | ForEach-Object { [IO.Path]::GetFileName($_) } | Where-Object {
            $match = [regex]::Match($_, $script:ClaimPattern)
            $match.Success -and [int] $match.Groups[1].Value -in $ProcessIds
        })
}

if (Test-Selected 'Removal') {
    $scratch = New-ScratchCompanionRoot -Prefix 'scratch-removal'

    # The default removal claims the root and deletes the claimed tree completely.
    $plain = Join-Path $scratch 'plain'
    New-ScratchTree -Root $plain -Directories 2 -FilesPerDirectory 2
    Invoke-StaleRootRemoval -Path $plain
    Assert-False -Condition ([IO.Directory]::Exists($plain)) -Message 'A swept root is gone.'
    Assert-Equal -Actual @(Get-ClaimNames -Directory $scratch -ProcessIds @($PID)).Count -Expected 0 -Message 'A swept root leaves no claimed tree behind.'

    # The claim is an atomic rename beside the root to a scratch-shaped name carrying this
    # process id, done before any removal starts.
    $named = Join-Path $scratch 'named'
    New-ScratchTree -Root $named -Directories 1 -FilesPerDirectory 1
    $seen = @{ target = $null; rootGone = $false }
    Invoke-StaleRootRemoval -Path $named -Remove { param($Target) $seen.target = $Target; $seen.rootGone = -not [IO.Directory]::Exists($named); [IO.Directory]::Delete($Target, $true) }.GetNewClosure()
    Assert-True -Condition $seen.rootGone -Message 'The root is renamed away before removal starts.'
    Assert-OrdinalEqual -Actual ([IO.Path]::GetDirectoryName($seen.target)) -Expected $scratch -Message 'The claim stays beside the root.'
    $claimMatch = [regex]::Match([IO.Path]::GetFileName($seen.target), $script:ClaimPattern)
    Assert-True -Condition ($claimMatch.Success -and [int] $claimMatch.Groups[1].Value -eq $PID) -Message "The claim name carries this live process id ($($seen.target))."

    # A root another sweeper already claimed or removed is skipped without any removal.
    $lostCalls = @{ count = 0 }
    Invoke-StaleRootRemoval -Path (Join-Path $scratch 'already-gone') -Remove { param($Target) $lostCalls.count++ }.GetNewClosure()
    Assert-Equal -Actual $lostCalls.count -Expected 0 -Message 'A root that is already gone is not removed.'

    # An attempt that returns normally but leaves the claimed tree (a suppressed partial
    # removal) is repeated until the tree is gone.
    $lingering = Join-Path $scratch 'lingering'
    New-ScratchTree -Root $lingering -Directories 1 -FilesPerDirectory 1
    $lingeringCalls = @{ count = 0 }
    Invoke-StaleRootRemoval -Path $lingering -Remove { param($Target) $lingeringCalls.count++; if ($lingeringCalls.count -ge 2) { [IO.Directory]::Delete($Target, $true) } }.GetNewClosure()
    Assert-Equal -Actual $lingeringCalls.count -Expected 2 -Message 'A tree left by a normally returning attempt is removed again once.'
    Assert-Equal -Actual @(Get-ClaimNames -Directory $scratch -ProcessIds @($PID)).Count -Expected 0 -Message 'A tree left by a normally returning attempt is gone after the retry.'

    # A claimed tree that every attempt leaves in place surfaces after the bound and stays
    # for inspection.
    $survivor = Join-Path $scratch 'survivor'
    New-ScratchTree -Root $survivor -Directories 1 -FilesPerDirectory 1
    $survivorSeen = @{ count = 0; target = $null }
    $survivorError = $null
    try { Invoke-StaleRootRemoval -Path $survivor -Remove { param($Target) $survivorSeen.count++; $survivorSeen.target = $Target }.GetNewClosure() }
    catch { $survivorError = $_.Exception }
    Assert-True -Condition ($null -ne $survivorError) -Message 'A tree no attempt removes is reported.'
    Assert-Equal -Actual $survivorSeen.count -Expected 3 -Message 'A tree no attempt removes is attempted exactly three times.'
    Assert-True -Condition ([IO.Directory]::Exists($survivorSeen.target)) -Message 'A tree no attempt removes is left for inspection.'
    [IO.Directory]::Delete($survivorSeen.target, $true)

    # A removal failure surfaces at once.
    $failing = Join-Path $scratch 'failing'
    New-ScratchTree -Root $failing -Directories 1 -FilesPerDirectory 1
    $failingSeen = @{ count = 0; target = $null }
    $failingError = $null
    try { Invoke-StaleRootRemoval -Path $failing -Remove { param($Target) $failingSeen.count++; $failingSeen.target = $Target; throw [ComponentModel.Win32Exception]::new(5) }.GetNewClosure() }
    catch { $failingError = $_.Exception }
    $failingException = $failingError
    while ($null -ne $failingException -and $failingException -isnot [ComponentModel.Win32Exception]) { $failingException = $failingException.InnerException }
    Assert-True -Condition ($null -ne $failingException -and $failingException.NativeErrorCode -eq 5) -Message 'A removal failure is rethrown.'
    Assert-Equal -Actual $failingSeen.count -Expected 1 -Message 'A removal failure is not retried.'
    [IO.Directory]::Delete($failingSeen.target, $true)

    # A claimed path that stops being an ordinary directory is left alone.
    $replaced = Join-Path $scratch 'replaced'
    New-ScratchTree -Root $replaced -Directories 1 -FilesPerDirectory 1
    $replacedSeen = @{ count = 0; target = $null }
    Invoke-StaleRootRemoval -Path $replaced -Remove { param($Target) $replacedSeen.count++; $replacedSeen.target = $Target; [IO.Directory]::Delete($Target, $true); [IO.File]::WriteAllText($Target, 'not a directory') }.GetNewClosure()
    Assert-Equal -Actual $replacedSeen.count -Expected 1 -Message 'A claimed path replaced by a file is not removed again.'
    Assert-True -Condition ([IO.File]::Exists($replacedSeen.target)) -Message 'A file that replaced a claimed path is left in place.'
}

if (Test-Selected 'ConcurrentSweep') {
    # Several real sweepers start together against one large dead-process root, the shape
    # the shared helper reaps when parallel harnesses start in the same checkout.
    $sweeper = Join-Path $PSScriptRoot 'Invoke-ScratchSweep.ps1'
    $deadProcess = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', 'exit' -PassThru -WindowStyle Hidden
    $deadProcess.WaitForExit()
    $deadId = $deadProcess.Id
    Assert-True -Condition ($null -eq (Get-Process -Id $deadId -ErrorAction SilentlyContinue)) -Message 'The dead creator process has exited.'
    $control = New-ScratchCompanionRoot -Prefix 'scratch-sweep-control'
    [void] [IO.Directory]::CreateDirectory($script:ProjectTmp)

    for ($round = 1; $round -le $Rounds; $round++) {
        $root = Join-Path $script:ProjectTmp "scratch-sweep-$deadId-$([guid]::NewGuid().ToString('N'))"
        New-ScratchTree -Root $root
        $go = Join-Path $control "go-$round"
        $children = @()
        $sweeperIds = @()
        try {
            for ($index = 0; $index -lt $Sweepers; $index++) {
                $child = Start-BoundedPwsh -Arguments @('-File', $sweeper, '-GoFile', $go)
                $children += $child
                $sweeperIds += $child.Process.Id
            }
            # Every sweeper imports its module before the go file appears.
            Start-Sleep -Milliseconds 2500
            [IO.File]::WriteAllText($go, 'go', $script:Utf8)
            foreach ($child in $children) {
                $result = Complete-BoundedPwsh -Child $child -TimeoutMilliseconds 120000
                Assert-Equal -Actual $result.ExitCode -Expected 0 -Message "Round $round sweeper exits cleanly (stderr: $($result.StdErr.Trim()))"
            }
            Assert-False -Condition ([IO.Directory]::Exists($root)) -Message "Round $round leaves no part of the dead root."
            Assert-Equal -Actual @(Get-ClaimNames -Directory $script:ProjectTmp -ProcessIds $sweeperIds).Count -Expected 0 -Message "Round $round leaves no claimed tree."
        }
        finally {
            # Every sweeper still running is killed before the root is cleaned up.
            foreach ($child in $children) { Stop-BoundedPwsh -Child $child }
            if ([IO.Directory]::Exists($root)) { [IO.Directory]::Delete($root, $true) }
        }
    }
}

Write-Output 'PASS: scratch cleanup'
