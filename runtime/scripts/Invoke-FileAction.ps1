#Requires -Version 7.5
[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string] $Root,
    [Parameter(Mandatory)] [ValidateSet('Move', 'Remove', IgnoreCase = $false)] [string] $Action,
    [Parameter(Mandatory)] [string] $Source,
    [Parameter(Mandatory)] [string] $Sha256,
    [string] $Target
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$scriptName = [IO.Path]::GetFileNameWithoutExtension($PSCommandPath)
try {
    $sources = @('NativeFiles.cs', 'JsonDocuments.cs', 'EventDocuments.cs', 'FileActions.cs')
    Add-Type -Path @($sources | ForEach-Object { Join-Path $PSScriptRoot $_ })
    if ($Action -ceq 'Move') {
        if ([string]::IsNullOrEmpty($Target)) { throw [ArgumentException]::new('Move target is required.') }
        [Companion.Runtime.FileActions]::Move($Root, $Source, $Target, $Sha256)
    }
    else {
        if ($PSBoundParameters.ContainsKey('Target')) { throw [ArgumentException]::new('Remove has no target.') }
        [Companion.Runtime.FileActions]::Remove($Root, $Source, $Sha256)
    }
    [Console]::Out.Write('{"completed":true}')
    exit 0
}
catch {
    [Console]::Error.WriteLine("${scriptName}: file-action-failed")
    exit 1
}
