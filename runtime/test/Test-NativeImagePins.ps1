#Requires -Version 7.5
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
Import-Module (Join-Path $repoRoot 'core/tests/TestSupport.psm1') -Force
Add-Type -Path @((Join-Path $repoRoot 'runtime/scripts/NativeFiles.cs'), (Join-Path $repoRoot 'runtime/scripts/NativeImagePins.cs'))
$pins = [Companion.Runtime.NativeImagePins]
$invariant = [Globalization.CultureInfo]::InvariantCulture

function Test-WriteOpen {
    param([Parameter(Mandatory)] [string] $Path)
    try { [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::ReadWrite).Dispose(); return $true }
    catch [IO.IOException] { return $false }
}

function Start-PinTarget {
    param([Parameter(Mandatory)] [string] $Fixture)
    $stop = Join-Path $Fixture ('stop-' + [guid]::NewGuid().ToString('N'))
    $child = Start-BoundedPwsh -Arguments @('-File', (Join-Path $PSScriptRoot 'fixtures/pin-target.ps1'), '-StopFile', $stop)
    $created = $child.Process.StartTime.ToUniversalTime().ToFileTimeUtc().ToString($invariant)
    return [pscustomobject]@{ Child = $child; Stop = $stop; Created = $created }
}

function Stop-PinTarget {
    param([Parameter(Mandatory)] [pscustomobject] $Target)
    [IO.File]::WriteAllText($Target.Stop, 'stop')
    if (-not $Target.Child.Process.WaitForExit(10000)) { $Target.Child.Process.Kill($true) }
    $null = Complete-BoundedPwsh -Child $Target.Child -TimeoutMilliseconds 10000
}

$fixture = New-ScratchCompanionRoot -Prefix 'image-pins'
$first = Join-Path $fixture 'first.bin'
$second = Join-Path $fixture 'second.bin'
[IO.File]::WriteAllBytes($first, [byte[]](1..64))
[IO.File]::WriteAllBytes($second, [byte[]](65..128))

# Arrange/Act/Assert: a target whose creation identity differs is refused before any handle is duplicated.
$target = Start-PinTarget -Fixture $fixture
try {
    $wrong = ([UInt64]::Parse($target.Created, $invariant) + 1).ToString($invariant)
    Assert-ThrowsType -TypeName 'System.IO.IOException' -Action { $pins::OpenTargetProcess($target.Child.Process.Id, $wrong) }
    $pins::OpenTargetProcess($target.Child.Process.Id, $target.Created).Dispose()
}
finally { Stop-PinTarget -Target $target }

# Arrange/Act/Assert: a partial transfer into a live target rolls back, releasing the pin it had already transferred.
$target = Start-PinTarget -Fixture $fixture
try {
    $process = $pins::OpenTargetProcess($target.Child.Process.Id, $target.Created)
    try {
        $held = $pins::OpenHeld($first, $false)
        try { $remote = $pins::DuplicateInto($held, $process) }
        finally { $held.Dispose() }
        Assert-True -Condition (-not (Test-WriteOpen -Path $first)) -Message 'a transferred pin denies writes after the helper copy closes'
        $closed = $pins::OpenHeld($second, $false)
        $closed.Dispose()
        Assert-ThrowsType -TypeName 'System.ObjectDisposedException' -Action { $pins::DuplicateInto($closed, $process) }
        $pins::CloseRemote($process, $remote)
        Assert-True -Condition (Test-WriteOpen -Path $first) -Message 'rollback closes the transferred pin in the live target'
        Assert-True -Condition (Test-WriteOpen -Path $second) -Message 'the failed transfer left no pin behind'
    }
    finally { $process.Dispose() }
}
finally { Stop-PinTarget -Target $target }

# Arrange/Act/Assert: when the target dies mid-transfer, rollback cannot be verified, yet the OS releases every transferred pin.
$target = Start-PinTarget -Fixture $fixture
try {
    $process = $pins::OpenTargetProcess($target.Child.Process.Id, $target.Created)
    try {
        $held = $pins::OpenHeld($first, $false)
        try { $remote = $pins::DuplicateInto($held, $process) }
        finally { $held.Dispose() }
        $target.Child.Process.Kill($true)
        Assert-True -Condition $target.Child.Process.WaitForExit(10000) -Message 'the target exits when killed'
        $heldSecond = $pins::OpenHeld($second, $false)
        try { Assert-ThrowsType -TypeName 'System.ComponentModel.Win32Exception' -Action { $pins::DuplicateInto($heldSecond, $process) } }
        finally { $heldSecond.Dispose() }
        Assert-ThrowsType -TypeName 'System.ComponentModel.Win32Exception' -Action { $pins::CloseRemote($process, $remote) }
        Assert-True -Condition (Test-WriteOpen -Path $first) -Message 'the OS released the transferred pin with the dead target'
    }
    finally { $process.Dispose() }
}
finally { Stop-PinTarget -Target $target }

# Arrange/Act/Assert: a helper that transfers a pin and exits without a receipt leaves the pin with the target until the target exits hard.
$target = Start-PinTarget -Fixture $fixture
try {
    $helper = Invoke-BoundedPwsh -Arguments @('-File', (Join-Path $PSScriptRoot 'fixtures/pin-helper.ps1'), '-TargetProcessId',
        [string] $target.Child.Process.Id, '-TargetCreated', $target.Created, '-Path', $first) -TimeoutMilliseconds 60000
    Assert-Equal -Actual $helper.ExitCode -Expected 0 -Message 'the helper exits after transfer'
    Assert-OrdinalEqual -Actual $helper.Stdout -Expected '' -Message 'the helper emits no receipt'
    Assert-True -Condition (-not (Test-WriteOpen -Path $first)) -Message 'the pin outlives the helper inside the target'
    $target.Child.Process.Kill($true)
    Assert-True -Condition $target.Child.Process.WaitForExit(10000) -Message 'the target exits hard'
    Assert-True -Condition (Test-WriteOpen -Path $first) -Message 'the hard exit releases the pin'
}
finally { Stop-PinTarget -Target $target }

# Arrange/Act/Assert: replacing a file with identical bytes changes the identity the held-handle comparison checks.
$admitted = [Companion.Runtime.NativeFiles]::Admit($first, $false)
$replacement = Join-Path $fixture 'replacement.bin'
[IO.File]::Copy($first, $replacement)
[IO.File]::Delete($first)
[IO.File]::Move($replacement, $first)
$held = $pins::OpenHeld($first, $false)
try {
    $observed = [Companion.Runtime.NativeFiles]::DescribeHeld($held, $first)
    Assert-OrdinalEqual -Actual $observed.Path -Expected $admitted.Path -Message 'the replacement keeps the path'
    Assert-True -Condition ($observed.Identity -cne $admitted.Identity) -Message 'the replacement changes the file identity'
    Assert-OrdinalEqual -Actual ($pins::HashHeld($held, 1048576)) -Expected ([Convert]::ToHexStringLower([Security.Cryptography.SHA256]::HashData([byte[]](1..64)))) -Message 'the replacement keeps the bytes'
}
finally { $held.Dispose() }

Write-Output 'PASS: native image pins'
