#Requires -Version 7.5
[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string] $Root,
    [Parameter(Mandatory)] [string] $Game,
    [string] $NativeSource = '',
    [string] $PinSource = '',
    [string] $PinRequestJson = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$scriptName = if ([string]::IsNullOrEmpty($PSCommandPath)) { 'Get-BootstrapScope' } else { [IO.Path]::GetFileNameWithoutExtension($PSCommandPath) }
$identity = $null
try {
    if (-not $IsWindows -or [string]::IsNullOrEmpty($Game)) { throw [IO.InvalidDataException]::new('Invalid bootstrap input.') }
    if ([string]::IsNullOrEmpty($NativeSource)) {
        if ([string]::IsNullOrEmpty($PSScriptRoot)) { throw [IO.InvalidDataException]::new('In-memory bootstrap source is unavailable.') }
        Add-Type -Path (Join-Path $PSScriptRoot 'NativeFiles.cs')
    } else {
        if ([Text.UTF8Encoding]::new($false, $true).GetByteCount($NativeSource) -gt 1048576) {
            throw [IO.InvalidDataException]::new('In-memory bootstrap source exceeds its bound.')
        }
        Add-Type -TypeDefinition $NativeSource
    }
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
    $response = [ordered]@{ sid = $sid; paths = @($results.ToArray()) }
    if ([string]::IsNullOrEmpty($PinSource) -ne [string]::IsNullOrEmpty($PinRequestJson)) {
        throw [IO.InvalidDataException]::new('Selected bootstrap inputs are incomplete.')
    }
    if (-not [string]::IsNullOrEmpty($PinSource)) {
        if ([string]::IsNullOrEmpty($NativeSource) -or
            [Text.UTF8Encoding]::new($false, $true).GetByteCount($PinSource) -gt 1048576 -or
            [Text.UTF8Encoding]::new($false, $true).GetByteCount($PinRequestJson) -gt 65536) {
            throw [IO.InvalidDataException]::new('Selected bootstrap source or request is invalid.')
        }
        $pinBlock = [ScriptBlock]::Create($PinSource)
        $response['imagePins'] = & $pinBlock -RequestJson $PinRequestJson -Sid $sid -Paths @($results.ToArray()) -Game $Game
    }
    [Console]::Out.Write((ConvertTo-Json -InputObject $response -Depth 16 -Compress))
    exit 0
}
catch {
    $cause = $_.Exception.GetBaseException()
    $reason = [Text.RegularExpressions.Regex]::Replace($cause.GetType().Name + ': ' + $cause.Message, '[^ -~]+', ' ').Trim()
    if ($reason.Length -gt 160) { $reason = $reason.Substring(0, 160) }
    [Console]::Error.WriteLine("${scriptName}: bootstrap-unavailable: $reason")
    exit 1
}
finally { if ($null -ne $identity) { $identity.Dispose() } }
