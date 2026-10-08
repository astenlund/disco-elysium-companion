#Requires -Version 7.5
[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string] $CompanionRoot,
    [Parameter(Mandatory)] [string] $Target,
    [Parameter(Mandatory)] [ValidateSet('Read', 'Edit', 'Write', 'Grep', 'Glob', IgnoreCase = $false)] [string] $Tool
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$scriptName = [IO.Path]::GetFileNameWithoutExtension($PSCommandPath)
try {
    Add-Type -Path @((Join-Path $PSScriptRoot 'NativeFiles.cs'), (Join-Path $PSScriptRoot 'JsonDocuments.cs'), (Join-Path $PSScriptRoot 'FileToolAdmission.cs'))
    $reply = [Companion.Runtime.FileToolAdmission]::Inspect($CompanionRoot, $Target, $Tool)
    $stream = [Console]::OpenStandardOutput()
    $stream.Write($reply)
    $stream.Flush()
    exit 0
}
catch {
    [Console]::Error.WriteLine("${scriptName}: file-operation-unavailable")
    exit 1
}
