#Requires -Version 7.5
[CmdletBinding()]
param(
    [Parameter(Mandatory)] [ValidateRange(1, 2147483647)] [int] $ProcessId,
    [Parameter(Mandatory)] [string] $Created,
    [Parameter(Mandatory)] [string] $JobName
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$scriptName = [IO.Path]::GetFileNameWithoutExtension($PSCommandPath)
try {
    Add-Type -Path (Join-Path $PSScriptRoot 'OrphanWatcher.cs')
    $state = [Companion.Runtime.OrphanWatcher]::Reconcile($ProcessId, $Created, $JobName)
    [Console]::Out.Write((ConvertTo-Json -InputObject ([ordered]@{ state = $state; pid = $ProcessId; created = $Created }) -Compress))
    exit 0
}
catch {
    [Console]::Error.WriteLine("${scriptName}: watcher-termination-unverified")
    exit 1
}
