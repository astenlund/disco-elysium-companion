#Requires -Version 7.5
[CmdletBinding()]
param([string] $Adapter, [string] $CompanionRoot, [switch] $PipeHolder)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Write-RepeatedByte {
    param(
        [Parameter(Mandatory)] [System.IO.Stream] $Stream,
        [Parameter(Mandatory)] [byte] $Value,
        [Parameter(Mandatory)] [int] $Count
    )

    $buffer = [byte[]]::new(65536)
    [System.Array]::Fill($buffer, $Value)
    $remaining = $Count
    while ($remaining -gt 0) {
        $writeCount = [System.Math]::Min($remaining, $buffer.Length)
        $Stream.Write($buffer, 0, $writeCount)
        $remaining -= $writeCount
    }
    $Stream.Flush()
}

if ($PipeHolder) {
    Start-Sleep -Seconds 3
    exit 0
}

[System.IO.File]::AppendAllText($env:COMPANION_TEST_VALIDATED_TRACE, "invoked`n", [System.Text.UTF8Encoding]::new($false))
if ($env:COMPANION_TEST_VALIDATED_SCENARIO -cin @('production-stdout-cap', 'production-stdout-overflow', 'production-stderr-cap', 'production-stderr-overflow')) {
    $isStandardOutput = $env:COMPANION_TEST_VALIDATED_SCENARIO.StartsWith('production-stdout-', [System.StringComparison]::Ordinal)
    $isOverflow = $env:COMPANION_TEST_VALIDATED_SCENARIO.EndsWith('-overflow', [System.StringComparison]::Ordinal)
    $stream = if ($isStandardOutput) { [Console]::OpenStandardOutput() } else { [Console]::OpenStandardError() }
    $maximumBytes = if ($isStandardOutput) { 33554432 } else { 65536 }
    Write-RepeatedByte -Stream $stream -Value ([byte] 0x20) -Count $maximumBytes
    if ($isOverflow) {
        Start-Sleep -Seconds 1
        $stream.WriteByte(0x20)
        $stream.Flush()
        Start-Sleep -Seconds 1
    }
    if (-not [string]::IsNullOrEmpty($env:COMPANION_TEST_VALIDATED_COMPLETION_TRACE)) {
        [System.IO.File]::WriteAllText($env:COMPANION_TEST_VALIDATED_COMPLETION_TRACE, 'completed', [System.Text.UTF8Encoding]::new($false))
    }
    if ($isStandardOutput) {
        exit 0
    }
    exit 1
}
if ($env:COMPANION_TEST_VALIDATED_SCENARIO -ceq 'terminal') {
    [Console]::Error.Write([System.IO.File]::ReadAllText($env:COMPANION_TEST_VALIDATED_DIAGNOSTIC, [System.Text.UTF8Encoding]::new($false, $true)))
    exit 1
}
if ($env:COMPANION_TEST_VALIDATED_SCENARIO -ceq 'delivery-partial') {
    [Console]::Out.Write('partial envelope')
    [Console]::Error.Write([System.IO.File]::ReadAllText($env:COMPANION_TEST_VALIDATED_DIAGNOSTIC, [System.Text.UTF8Encoding]::new($false, $true)))
    exit 1
}
if ($env:COMPANION_TEST_VALIDATED_SCENARIO -ceq 'invalid-terminal') {
    [Console]::Error.Write("invalid terminal framing`n")
    exit 1
}
if ($env:COMPANION_TEST_VALIDATED_SCENARIO -ceq 'invalid-utf8') {
    [Console]::OpenStandardOutput().Write([byte[]] @(0xff))
    exit 0
}
if ($env:COMPANION_TEST_VALIDATED_SCENARIO -ceq 'invalid-utf8-after-baseline') {
    [System.IO.File]::WriteAllText($env:COMPANION_TEST_VALIDATED_BASELINE_TRACE, 'advanced', [System.Text.UTF8Encoding]::new($false))
    [Console]::OpenStandardOutput().Write([byte[]] @(0xff))
    exit 0
}
if ($env:COMPANION_TEST_VALIDATED_SCENARIO -ceq 'abnormal-exit') {
    exit 2
}
if ($env:COMPANION_TEST_VALIDATED_SCENARIO -ceq 'inherited-pipe') {
    $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = [System.Environment]::ProcessPath
    $startInfo.UseShellExecute = $false
    foreach ($argument in @('-NoProfile', '-File', $PSCommandPath, '-PipeHolder')) {
        $startInfo.ArgumentList.Add($argument)
    }
    [void] [System.Diagnostics.Process]::Start($startInfo)
    exit 0
}
if ($env:COMPANION_TEST_VALIDATED_SCENARIO -ceq 'malformed') {
    [Console]::Out.Write('{')
    exit 0
}
if ($env:COMPANION_TEST_VALIDATED_SCENARIO -ceq 'success-stderr') {
    [Console]::Error.Write("unexpected stderr`n")
}
if ($env:COMPANION_TEST_VALIDATED_SCENARIO -ceq 'hang') {
    Start-Sleep -Seconds 3
}

[Console]::Out.Write([System.IO.File]::ReadAllText($env:COMPANION_TEST_VALIDATED_ENVELOPE, [System.Text.UTF8Encoding]::new($false, $true)))
