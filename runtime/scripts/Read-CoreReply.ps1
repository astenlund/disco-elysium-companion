#Requires -Version 7.5
[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string] $CompanionRoot,
    [Parameter(Mandatory)] [ValidateSet('Publish', 'Settlement', 'Consumer', IgnoreCase = $false)] [string] $Operation
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$scriptName = [IO.Path]::GetFileNameWithoutExtension($PSCommandPath)
try {
    $sources = @('NativeFiles.cs', 'JsonDocuments.cs', 'EventDocuments.cs', 'PayloadCodec.cs', 'RuntimeFilePublication.cs', 'RuntimeCodec.cs')
    Add-Type -Path @($sources | ForEach-Object { Join-Path $PSScriptRoot $_ })
    $modulePath = Join-Path $CompanionRoot 'core/DigestDiff.psm1'
    $module = [Companion.Runtime.NativeFiles]::AdmitWithin($CompanionRoot, $modulePath, $false)
    if ($module.IsDirectory) { throw [IO.IOException]::new('Core module is not an ordinary file.') }
    Import-Module $module.Path -Force -DisableNameChecking
    $validationPath = Join-Path $PSScriptRoot 'CoreReplyValidation.ps1'
    $validation = [Companion.Runtime.NativeFiles]::AdmitWithin($PSScriptRoot, $validationPath, $false)
    if ($validation.IsDirectory) { throw [IO.IOException]::new('Core reply validation is not an ordinary file.') }
    . $validation.Path
    $inputBytes = [Companion.Runtime.JsonDocuments]::ReadBounded([Console]::OpenStandardInput(), 1048576)
    [Console]::Out.Write((Convert-CoreReply -Operation $Operation -InputBytes $inputBytes))
    exit 0
}
catch {
    [Console]::Error.WriteLine("${scriptName}: core-reply-invalid")
    exit 1
}
