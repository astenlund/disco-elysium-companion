#Requires -Version 7.5

# One concurrent stale-scratch sweeper for Test-ScratchCleanup.ps1: waits for the shared go
# file so every sweeper starts together, then runs the real Clear-StaleScratchRoots once.
[CmdletBinding()]
param([Parameter(Mandatory)] [string] $GoFile)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Import-Module (Join-Path $PSScriptRoot 'TestSupport.psm1') -Force
$deadline = [DateTime]::UtcNow.AddMinutes(2)
while (-not [IO.File]::Exists($GoFile)) {
    if ([DateTime]::UtcNow -gt $deadline) { throw [TimeoutException]::new('The go file never appeared.') }
    [Threading.Thread]::SpinWait(1000)
}
& (Get-Module TestSupport) { Clear-StaleScratchRoots }
