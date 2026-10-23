#Requires -Version 7.5
# Starts owned-descendant.ps1 under the native helper's broker in the named job, as a supervised watcher would run,
# prints the broker's owned-process header and waits for the broker to end.
param(
    [Parameter(Mandatory)] [string] $JobName,
    [Parameter(Mandatory)] [string] $BrokerImage,
    [Parameter(Mandatory)] [string] $FixtureRoot
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$self = [Diagnostics.Process]::GetCurrentProcess()
$created = $self.StartTime.ToUniversalTime().ToFileTimeUtc().ToString([Globalization.CultureInfo]::InvariantCulture)
$environment = [ordered]@{}
foreach ($entry in [Environment]::GetEnvironmentVariables().GetEnumerator() | Sort-Object -Property Key) {
    $environment[[string]$entry.Key] = [string]$entry.Value
}
$control = [ordered]@{
    command = 'pwsh'
    args = @('-NoProfile', '-File', (Join-Path $PSScriptRoot 'owned-descendant.ps1'), '-FixtureRoot', $FixtureRoot)
    cwd = $FixtureRoot
    jobName = $JobName
    parentPid = $PID
    parentCreated = $created
    brokerProtocolVersion = 2
    childEnvironment = $environment
}
$start = [Diagnostics.ProcessStartInfo]::new($BrokerImage)
$start.ArgumentList.Add('broker')
$start.UseShellExecute = $false
$start.CreateNoWindow = $true
$start.RedirectStandardInput = $true
$start.RedirectStandardOutput = $true
$broker = [Diagnostics.Process]::Start($start)
$broker.StandardInput.Write((ConvertTo-Json -InputObject $control -Compress -Depth 4))
$broker.StandardInput.Write([char]10)
$broker.StandardInput.Flush()
[Console]::Out.WriteLine($broker.StandardOutput.ReadLine())
[Console]::Out.Flush()
$broker.WaitForExit()
