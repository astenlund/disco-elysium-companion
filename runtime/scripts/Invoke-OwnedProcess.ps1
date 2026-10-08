#Requires -Version 7.5
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$scriptName = [IO.Path]::GetFileNameWithoutExtension($PSCommandPath)
try {
    if (-not $IsWindows) { throw [PlatformNotSupportedException]::new('Windows process ownership is required.') }
    $sources = @('NativeJobs.cs', 'JsonDocuments.cs', 'ProcessBroker.cs') | ForEach-Object { Join-Path $PSScriptRoot $_ }
    Add-Type -Path $sources
    $code = [Companion.Runtime.ProcessBroker]::RunAsync([Console]::OpenStandardInput(), [Console]::OpenStandardOutput(), [Console]::OpenStandardError()).GetAwaiter().GetResult()
    [Environment]::Exit($code)
}
catch {
    [Console]::Error.WriteLine("${scriptName}: owned-process-failed")
    [Console]::Error.Flush()
    [Environment]::Exit(125)
}
