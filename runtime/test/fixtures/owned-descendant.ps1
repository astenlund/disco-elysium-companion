#Requires -Version 7.5
param([Parameter(Mandatory)] [string] $FixtureRoot)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$process = [Diagnostics.Process]::GetCurrentProcess()
$identity = [ordered]@{ pid = $PID; created = $process.StartTime.ToUniversalTime().ToFileTimeUtc().ToString([Globalization.CultureInfo]::InvariantCulture) }
[IO.File]::WriteAllText((Join-Path $FixtureRoot 'descendant.json'), (ConvertTo-Json -InputObject $identity -Compress))
while (-not [IO.File]::Exists((Join-Path $FixtureRoot 'stop'))) { [Threading.Thread]::Sleep(50) }
