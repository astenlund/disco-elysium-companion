#Requires -Version 7.5
[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string] $Root,
    [Parameter(Mandatory)] [string] $Target,
    [Parameter(Mandatory)] [string] $InputFile,
    [Parameter(Mandatory)] [string] $Sha256,
    [Parameter(Mandatory)] [ValidateSet('config', 'state-event', IgnoreCase = $false)] [string] $Profile,
    [switch] $CreateOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$scriptName = [IO.Path]::GetFileNameWithoutExtension($PSCommandPath)

try {
    if (-not $IsWindows) { throw [PlatformNotSupportedException]::new('Windows publication is required.') }
    Add-Type -Path @((Join-Path $PSScriptRoot 'NativeFiles.cs'), (Join-Path $PSScriptRoot 'JsonDocuments.cs'), (Join-Path $PSScriptRoot 'RuntimeFilePublication.cs'))
    $publication = [Companion.Runtime.RuntimeFilePublication]::Publish($Root, $Target, $InputFile, $Sha256, $Profile, $CreateOnly.IsPresent)
    $result = [ordered]@{
        published = $true
        sha256 = $publication.Sha256
        cleanupComplete = $publication.RetainedSiblings.Length -eq 0
        retainedSiblings = @($publication.RetainedSiblings)
    }
    [Console]::Out.Write((ConvertTo-Json -InputObject $result -Depth 8 -Compress))
    exit 0
}
catch {
    [Console]::Error.WriteLine("${scriptName}: publication-failed")
    exit 1
}
