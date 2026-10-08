#Requires -Version 7.5
[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string] $Root,
    [Parameter(Mandatory)] [string] $ScopeSha256,
    [string] $CompanionRoot,
    [ValidateSet('Inventory', 'Marker', 'Event', 'Quarantine', IgnoreCase = $false)] [string] $Mode = 'Inventory'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$scriptName = [IO.Path]::GetFileNameWithoutExtension($PSCommandPath)
try {
    $parent = Split-Path -Parent $PSScriptRoot
    $sources = @('NativeFiles.cs', 'JsonDocuments.cs', 'EventDocuments.cs', 'PayloadCodec.cs', 'RuntimeFilePublication.cs', 'RuntimeCodec.cs')
    Add-Type -Path (@($sources | ForEach-Object { Join-Path $parent $_ }) + (Join-Path $PSScriptRoot 'ResourceInventory.cs'))
    if ($Mode -ceq 'Quarantine') {
        $bytes = [Companion.Runtime.JsonDocuments]::ReadBounded([Console]::OpenStandardInput(), 1048576)
        $reply = [Companion.Runtime.ResourceInventory]::TrimQuarantine($Root, $ScopeSha256, $bytes)
    }
    elseif ($Mode -ceq 'Event') {
        $bytes = [Companion.Runtime.JsonDocuments]::ReadBounded([Console]::OpenStandardInput(), 33554432)
        [Companion.Runtime.ResourceInventory]::CheckEventExpansion($bytes)
        $reply = [Text.Encoding]::UTF8.GetBytes('{"admitted":true}')
    }
    else {
        $reply = [Companion.Runtime.ResourceInventory]::Read($Root, $ScopeSha256, ($Mode -ceq 'Marker'), $CompanionRoot)
    }
    $stream = [Console]::OpenStandardOutput()
    $stream.Write($reply)
    $stream.Flush()
    exit 0
}
catch {
    [Console]::Error.WriteLine("${scriptName}: resource-authority-unavailable")
    exit 1
}
