#Requires -Version 7.5
[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string] $Root,
    [Parameter(Mandatory)] [string] $InputFile,
    [Parameter(Mandatory)] [string] $InputSha256,
    [Parameter(Mandatory)] [ValidateSet('Preview', 'Publish', 'Verify', IgnoreCase = $false)] [string] $Mode
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$scriptName = [IO.Path]::GetFileNameWithoutExtension($PSCommandPath)
try {
    $sources = @('NativeFiles.cs', 'JsonDocuments.cs', 'EventDocuments.cs', 'PayloadCodec.cs', 'ContextFingerprint.cs', 'ContextCodec.cs', 'ContextSelection.cs', 'RuntimeFilePublication.cs', 'RuntimeContext.cs')
    Add-Type -Path @($sources | ForEach-Object { Join-Path $PSScriptRoot $_ })
    $reply = [Companion.Runtime.RuntimeContext]::Execute($Root, $InputFile, $InputSha256, $Mode)
    $stream = [Console]::OpenStandardOutput()
    $stream.Write($reply)
    $stream.Flush()
    exit 0
}
catch {
    [Console]::Error.WriteLine("${scriptName}: context-unavailable")
    exit 1
}
