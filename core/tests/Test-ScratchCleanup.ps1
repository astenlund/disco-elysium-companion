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
    param([Parameter(Mandatory)] [string] $Path, [Parameter(Mandatory)] [scriptblock] $Remove)

    & $script:TestSupport { param($Path, $Remove) Remove-StaleScratchRoot -Path $Path -Remove $Remove } $Path $Remove
}

function Assert-Win32Rethrown {
    param([Parameter(Mandatory)] [scriptblock] $Action, [Parameter(Mandatory)] [int] $NativeErrorCode, [Parameter(Mandatory)] [string] $Message)

    try { & $Action }
    catch {
        $exception = $_.Exception
        while ($null -ne $exception -and $exception -isnot [ComponentModel.Win32Exception]) { $exception = $exception.InnerException }
        Assert-True -Condition ($null -ne $exception -and $exception.NativeErrorCode -eq $NativeErrorCode) -Message "$Message rethrows the Win32 error $NativeErrorCode ($($_.Exception.GetType().FullName): $($_.Exception.Message))."

        return
    }

    throw [InvalidOperationException]::new("Assertion failed: $Message did not throw.")
}

if (Test-Selected 'Removal') {
    $scratch = New-ScratchCompanionRoot -Prefix 'scratch-removal'

    # Another sweeper finished the tree while this one's walk was inside it.
    $finished = Join-Path $scratch 'finished'
    New-ScratchTree -Root $finished -Directories 2 -FilesPerDirectory 2
    Invoke-StaleRootRemoval -Path $finished -Remove { param($Target) [IO.Directory]::Delete($Target, $true); throw [ComponentModel.Win32Exception]::new(2) }
    Assert-False -Condition ([IO.Directory]::Exists($finished)) -Message 'A root a concurrent sweeper finished removing stays removed.'

    # The walk lost an entry to another sweeper and left the rest; the retry removes it.
    $partial = Join-Path $scratch 'partial'
    New-ScratchTree -Root $partial -Directories 2 -FilesPerDirectory 2
    $calls = @{ count = 0 }
    Invoke-StaleRootRemoval -Path $partial -Remove {
        param($Target)
        $calls.count++
        if ($calls.count -eq 1) { [IO.Directory]::Delete((Join-Path $Target 'd0'), $true); throw [ComponentModel.Win32Exception]::new(3) }
        Remove-Item -LiteralPath $Target -Recurse -Force -Confirm:$false -ErrorAction SilentlyContinue
    }.GetNewClosure()
    Assert-Equal -Actual $calls.count -Expected 2 -Message 'A partly removed root is removed again once.'
    Assert-False -Condition ([IO.Directory]::Exists($partial)) -Message 'A partly removed root is absent after the retry.'

    # Any other Win32 failure is not a concurrent removal and still surfaces.
    $denied = Join-Path $scratch 'denied'
    New-ScratchTree -Root $denied -Directories 1 -FilesPerDirectory 1
    Assert-Win32Rethrown -Action { Invoke-StaleRootRemoval -Path $denied -Remove { param($Target) throw [ComponentModel.Win32Exception]::new(5) } } -NativeErrorCode 5 -Message 'An access failure during removal'
    Assert-True -Condition ([IO.Directory]::Exists($denied)) -Message 'An access failure leaves the root for inspection.'

    # A root that keeps surviving the not-found failure is reported after the bounded attempts.
    $stuck = Join-Path $scratch 'stuck'
    New-ScratchTree -Root $stuck -Directories 1 -FilesPerDirectory 1
    $stuckCalls = @{ count = 0 }
    Assert-Win32Rethrown -Action { Invoke-StaleRootRemoval -Path $stuck -Remove { param($Target) $stuckCalls.count++; throw [ComponentModel.Win32Exception]::new(2) }.GetNewClosure() } -NativeErrorCode 2 -Message 'A root that survives every attempt'
    Assert-Equal -Actual $stuckCalls.count -Expected 3 -Message 'A surviving root is attempted exactly three times.'

    # A path that stops being an ordinary directory before the retry is left alone.
    $replaced = Join-Path $scratch 'replaced'
    New-ScratchTree -Root $replaced -Directories 1 -FilesPerDirectory 1
    $replacedCalls = @{ count = 0 }
    Invoke-StaleRootRemoval -Path $replaced -Remove { param($Target) $replacedCalls.count++; [IO.Directory]::Delete($Target, $true); [IO.File]::WriteAllText($Target, 'not a directory'); throw [ComponentModel.Win32Exception]::new(2) }.GetNewClosure()
    Assert-Equal -Actual $replacedCalls.count -Expected 1 -Message 'A root replaced by a file is not removed again.'
    Assert-True -Condition ([IO.File]::Exists($replaced)) -Message 'A file that replaced a root is left in place.'
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
        try {
            for ($index = 0; $index -lt $Sweepers; $index++) { $children += Start-BoundedPwsh -Arguments @('-File', $sweeper, '-GoFile', $go) }
            # Every sweeper imports its module before the go file appears.
            Start-Sleep -Milliseconds 2500
            [IO.File]::WriteAllText($go, 'go', $script:Utf8)
            foreach ($child in $children) {
                $result = Complete-BoundedPwsh -Child $child -TimeoutMilliseconds 120000
                Assert-Equal -Actual $result.ExitCode -Expected 0 -Message "Round $round sweeper exits cleanly (stderr: $($result.StdErr.Trim()))"
            }
            Assert-False -Condition ([IO.Directory]::Exists($root)) -Message "Round $round leaves no part of the dead root."
        }
        finally {
            # Every sweeper still running is killed before the root is cleaned up.
            foreach ($child in $children) { Stop-BoundedPwsh -Child $child }
            if ([IO.Directory]::Exists($root)) { [IO.Directory]::Delete($root, $true) }
        }
    }
}

Write-Output 'PASS: scratch cleanup'
