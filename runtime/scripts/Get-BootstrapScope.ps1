#Requires -Version 7.5
[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string] $Root,
    [Parameter(Mandatory)] [string] $Game
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$scriptName = [IO.Path]::GetFileNameWithoutExtension($PSCommandPath)
$identity = $null
try {
    if (-not $IsWindows -or [string]::IsNullOrEmpty($Game)) { throw [IO.InvalidDataException]::new('Invalid bootstrap input.') }
    Add-Type -Path (Join-Path $PSScriptRoot 'NativeFiles.cs')
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $sid = $identity.User.Value
    if ([string]::IsNullOrEmpty($sid)) { throw [InvalidOperationException]::new('Principal identity is unavailable.') }
    $utf8 = [Text.UTF8Encoding]::new($false, $true)
    $gameHash = [Convert]::ToHexStringLower([Security.Cryptography.SHA256]::HashData($utf8.GetBytes($Game)))
    $principalHash = [Convert]::ToHexStringLower([Security.Cryptography.SHA256]::HashData($utf8.GetBytes($sid)))
    $candidate = Join-Path (Join-Path (Join-Path $Root 'runtime-data') ('g-' + $gameHash)) ('p-' + $principalHash)
    $results = [Collections.Generic.List[object]]::new()
    foreach ($target in @($Root, $candidate)) {
        $admission = [Companion.Runtime.NativeFiles]::AdmitWithin($Root, $target, $true)
        $kind = if (-not $admission.Exists) { $null } elseif ($admission.IsDirectory) { 'directory' } else { 'file' }
        $results.Add(([ordered]@{
            path = $admission.Path
            exists = $admission.Exists
            kind = $kind
            links = if ($admission.Exists) { $admission.Links } else { $null }
            volume = if ($admission.Exists) { $admission.Volume } else { $null }
            identity = if ($admission.Exists) { $admission.Identity } else { $null }
            missing = @($admission.Missing)
        }))
    }
    [Console]::Out.Write((ConvertTo-Json -InputObject ([ordered]@{ sid = $sid; paths = @($results.ToArray()) }) -Depth 8 -Compress))
    exit 0
}
catch {
    [Console]::Error.WriteLine("${scriptName}: bootstrap-unavailable")
    exit 1
}
finally { if ($null -ne $identity) { $identity.Dispose() } }
