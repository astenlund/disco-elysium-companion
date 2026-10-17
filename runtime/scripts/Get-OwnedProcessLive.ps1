#Requires -Version 7.5
[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string] $JobName,
    [Parameter(Mandatory)] [ValidateRange(1, 2147483647)] [int] $ProcessId,
    [Parameter(Mandatory)] [string] $ProcessCreated
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$scriptName = [IO.Path]::GetFileNameWithoutExtension($PSCommandPath)

try {
    if ([string]::IsNullOrEmpty($JobName) -or $ProcessCreated -cnotmatch '^[1-9][0-9]{0,18}$') {
        throw [FormatException]::new('Owned process identity is invalid.')
    }
    Add-Type -Path (Join-Path $PSScriptRoot 'NativeJobs.cs')
    Add-Type -Path (Join-Path $PSScriptRoot 'NativeProcessIdentity.cs')
    $members = [Companion.Runtime.NativeJobs]::Members($JobName)
    $identity = [Companion.Runtime.NativeProcessIdentity]::Read($ProcessId)
    $live = $null -ne $identity -and $members -contains $ProcessId -and
        [string]::CompareOrdinal($identity.Created, $ProcessCreated) -eq 0
    [Console]::Out.Write((ConvertTo-Json -InputObject ([ordered]@{ live = [bool] $live }) -Compress))
    exit 0
}
catch {
    [Console]::Error.WriteLine("${scriptName}: owned-process-live-unavailable")
    exit 1
}
