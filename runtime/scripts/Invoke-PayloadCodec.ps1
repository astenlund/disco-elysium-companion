#Requires -Version 7.5
[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string] $Root,
    [Parameter(Mandatory)] [string] $Target,
    [Parameter(Mandatory)] [string] $InputFile,
    [Parameter(Mandatory)] [string] $InputSha256,
    [Parameter(Mandatory)] [string] $ControlFile,
    [Parameter(Mandatory)] [string] $ControlSha256,
    [switch] $VerifyOnly,
    [switch] $Preview
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$scriptName = [IO.Path]::GetFileNameWithoutExtension($PSCommandPath)

try {
    if (-not $IsWindows) { throw [PlatformNotSupportedException]::new('Windows codec publication is required.') }
    $sources = @('NativeFiles.cs', 'JsonDocuments.cs', 'EventDocuments.cs', 'PayloadCodec.cs', 'RuntimeFilePublication.cs', 'RuntimeCodec.cs')
    Add-Type -Path @($sources | ForEach-Object { Join-Path $PSScriptRoot $_ })
    $reply = [Companion.Runtime.RuntimeCodec]::Execute($Root, $Target, $InputFile, $InputSha256, $ControlFile, $ControlSha256, $VerifyOnly.IsPresent, $Preview.IsPresent)
    $stream = [Console]::OpenStandardOutput()
    $stream.Write($reply)
    $stream.Flush()
    exit 0
}
catch {
    $exception = $_.Exception
    while ($null -ne $exception.InnerException) { $exception = $exception.InnerException }
    $reason = if ($exception.GetType().Name -ceq 'DocumentInvalidException') { 'document-invalid' } else { 'codec-unavailable' }
    [Console]::Error.WriteLine("${scriptName}: $reason")
    exit 1
}
