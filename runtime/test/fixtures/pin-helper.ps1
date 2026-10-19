#Requires -Version 7.5
[CmdletBinding()]
param(
    [Parameter(Mandatory)] [int] $TargetProcessId,
    [Parameter(Mandatory)] [string] $TargetCreated,
    [Parameter(Mandatory)] [string] $Path
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
Add-Type -Path @((Join-Path $repoRoot 'runtime/scripts/NativeFiles.cs'), (Join-Path $repoRoot 'runtime/scripts/NativeImagePins.cs'))

# Transfers one pin into the target, then exits without a receipt and without closing the remote copy.
$target = [Companion.Runtime.NativeImagePins]::OpenTargetProcess($TargetProcessId, $TargetCreated)
try {
    $held = [Companion.Runtime.NativeImagePins]::OpenHeld($Path, $false)
    try { $null = [Companion.Runtime.NativeImagePins]::DuplicateInto($held, $target) }
    finally { $held.Dispose() }
}
finally { $target.Dispose() }
exit 0
