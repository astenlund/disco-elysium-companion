#Requires -Version 7.5
[CmdletBinding()]
param(
    [string] $Adapter,
    [int] $IntervalSeconds = 30,
    [string] $CompanionRoot = (Split-Path $PSScriptRoot -Parent)
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$source = Join-Path $PSScriptRoot 'EntryFence.psm1'
Import-Module $source -Force
$lease = $null
$source = Join-Path $PSScriptRoot 'DigestDiff.psm1'
Import-Module $source -Force
$cancellation = [Threading.CancellationTokenSource]::new()
try {
    $lease = Enter-CompanionEntryFence -CompanionRoot $CompanionRoot
    Initialize-CompanionStateDirectories -CompanionRoot $CompanionRoot
    $sink = New-CompanionWarningSink -Profile Cycle
    Invoke-WorkFileReaper -CompanionRoot $CompanionRoot -WarningSink $sink
    Invoke-CompanionWatcher -AdapterName $Adapter -CompanionRoot $CompanionRoot -IntervalSeconds $IntervalSeconds -CancellationToken $cancellation.Token
}
catch [WatcherCancellationException] {
    # A user-owned cancellation is a normal watcher exit.
}
finally {
    $cancellation.Dispose()
    if ($null -ne $lease) { $lease.Dispose() }
}
