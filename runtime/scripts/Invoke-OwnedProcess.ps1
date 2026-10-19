#Requires -Version 7.5
[CmdletBinding()]
param(
    # Version-2 control: the child receives the environment from the frame, so the broker itself can run in a scratch profile.
    [switch] $ChildEnvironment
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$scriptName = [IO.Path]::GetFileNameWithoutExtension($PSCommandPath)
try {
    if (-not $IsWindows) { throw [PlatformNotSupportedException]::new('Windows process ownership is required.') }
    $sources = @('NativeJobs.cs', 'JsonDocuments.cs', 'ProcessBroker.cs') | ForEach-Object { Join-Path $PSScriptRoot $_ }
    Add-Type -Path $sources
    $code = [Companion.Runtime.ProcessBroker]::RunAsync([Console]::OpenStandardInput(), [Console]::OpenStandardOutput(), [Console]::OpenStandardError(),
        $ChildEnvironment.IsPresent).GetAwaiter().GetResult()
    [Environment]::Exit($code)
}
catch {
    [Console]::Error.WriteLine("${scriptName}: owned-process-failed")
    [Console]::Error.Flush()
    [Environment]::Exit(125)
}
