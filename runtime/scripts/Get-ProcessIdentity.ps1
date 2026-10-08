#Requires -Version 7.5
[CmdletBinding()]
param([Parameter(Mandatory)] [ValidateRange(1, 2147483647)] [int] $ProcessId)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$scriptName = [IO.Path]::GetFileNameWithoutExtension($PSCommandPath)
try {
    Add-Type -Path (Join-Path $PSScriptRoot 'NativeProcessIdentity.cs')
    $identity = [Companion.Runtime.NativeProcessIdentity]::Read($ProcessId)
    $result = if ($null -eq $identity) { [ordered]@{ exists = $false; pid = $ProcessId; created = $null } } else { [ordered]@{ exists = $true; pid = $identity.Pid; created = $identity.Created } }
    [Console]::Out.Write((ConvertTo-Json -InputObject $result -Compress))
    exit 0
}
catch {
    [Console]::Error.WriteLine("${scriptName}: process-identity-unavailable")
    exit 1
}
