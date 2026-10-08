#Requires -Version 7.5
[CmdletBinding(DefaultParameterSetName = 'Direct')]
param(
    [Parameter(Mandatory)] [string] $Root,
    [Parameter(Mandatory, ParameterSetName = 'Direct')] [string] $RequestsJson,
    [Parameter(ParameterSetName = 'Direct')] [switch] $Source,
    [Parameter(Mandatory, ParameterSetName = 'Batch')] [switch] $Batch
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$scriptName = [IO.Path]::GetFileNameWithoutExtension($PSCommandPath)
try {
    $sources = @('NativeFiles.cs', 'JsonDocuments.cs', 'EventDocuments.cs', 'PayloadCodec.cs', 'RuntimeFilePublication.cs', 'RuntimeCodec.cs', 'EventInspection.cs')
    Add-Type -Path @($sources | ForEach-Object { Join-Path $PSScriptRoot $_ })
    if ($Batch) {
        $reply = [Companion.Runtime.EventInspection]::ReadBatch($Root, [Console]::OpenStandardInput())
    } else {
        $reply = [Companion.Runtime.EventInspection]::Read($Root, $RequestsJson, $Source.IsPresent)
    }
    $stream = [Console]::OpenStandardOutput()
    $stream.Write($reply)
    $stream.Flush()
    exit 0
}
catch {
    [Console]::Error.WriteLine("${scriptName}: inspection-unavailable")
    exit 1
}
