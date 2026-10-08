#Requires -Version 7.5
[CmdletBinding()]
param([Parameter(Mandatory)] [string] $JobName)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$scriptName = [IO.Path]::GetFileNameWithoutExtension($PSCommandPath)
try {
    Add-Type -Path (Join-Path $PSScriptRoot 'NativeJobs.cs')
    $count = [Companion.Runtime.NativeJobs]::Observe($JobName)
    $state = if ($null -eq $count) { 'absent' } else { 'present' }
    [Console]::Out.Write((ConvertTo-Json -InputObject ([ordered]@{ state = $state; processes = $count }) -Compress))
    exit 0
}
catch {
    [Console]::Error.WriteLine("${scriptName}: job-state-unavailable")
    exit 1
}
