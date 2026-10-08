#Requires -Version 7.5
param(
    [Parameter(Mandatory)] [string] $JobName,
    [ValidateSet('Exit', 'Tree')] [string] $Mode = 'Exit',
    [string] $FixtureRoot
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Add-Type -Path ([IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../scripts/NativeJobs.cs')))
[Companion.Runtime.NativeJobs]::OwnCurrentProcess($JobName)
if ($Mode -ceq 'Tree') {
    $start = [Diagnostics.ProcessStartInfo]::new('pwsh')
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    foreach ($argument in @('-NoProfile', '-File', (Join-Path $PSScriptRoot 'owned-descendant.ps1'), '-FixtureRoot', $FixtureRoot)) {
        $start.ArgumentList.Add($argument)
    }
    $descendant = [Diagnostics.Process]::Start($start)
    while ($true) { [Threading.Thread]::Sleep(100) }
}
[Console]::Out.WriteLine([Companion.Runtime.NativeJobs]::CurrentCount())
[Console]::Out.Flush()
[Environment]::Exit(7)
