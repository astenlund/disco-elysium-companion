#Requires -Version 7.5
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$scriptName = [IO.Path]::GetFileNameWithoutExtension($PSCommandPath)
$identity = $null
try {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $sid = $identity.User.Value
    if ([string]::IsNullOrEmpty($sid)) { throw [InvalidOperationException]::new('Principal identity is unavailable.') }
    [Console]::Out.Write((ConvertTo-Json -InputObject ([ordered]@{ sid = $sid }) -Compress))
    exit 0
}
catch {
    [Console]::Error.WriteLine("${scriptName}: identity-unavailable")
    exit 1
}
finally { if ($null -ne $identity) { $identity.Dispose() } }
