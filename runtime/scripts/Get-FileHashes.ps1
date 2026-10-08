#Requires -Version 7.5
[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string] $Root,
    [string] $ScopeSha256
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$scriptName = [IO.Path]::GetFileNameWithoutExtension($PSCommandPath)
try {
    $sources = @('NativeFiles.cs', 'JsonDocuments.cs', 'FileHashes.cs')
    Add-Type -Path @($sources | ForEach-Object { Join-Path $PSScriptRoot $_ })
    if ($PSBoundParameters.ContainsKey('ScopeSha256')) {
        $reply = [Companion.Runtime.FileHashes]::Read($Root, [Console]::OpenStandardInput(), $ScopeSha256)
    } else {
        $reply = [Companion.Runtime.FileHashes]::Read($Root, [Console]::OpenStandardInput())
    }
    $stream = [Console]::OpenStandardOutput()
    $stream.Write($reply)
    $stream.Flush()
    exit 0
}
catch {
    [Console]::Error.WriteLine("${scriptName}: observation-unavailable")
    exit 1
}
