#Requires -Version 7.5
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
Import-Module (Join-Path $repoRoot 'core/tests/TestSupport.psm1') -Force
Add-Type -Path (Join-Path $repoRoot 'runtime/scripts/NativeJobs.cs')
$jobName = 'Global\game-companion-process-' + [guid]::NewGuid().ToString('N') + '-core'

# Arrange/Act/Assert: only the isolated fixture joins the job, never this test controller.
Assert-True -Condition ($null -eq [Companion.Runtime.NativeJobs]::Observe($jobName)) -Message 'job starts absent'
$result = Invoke-BoundedPwsh -Arguments @('-File', (Join-Path $PSScriptRoot 'fixtures/job-owner.ps1'), '-JobName', $jobName) -TimeoutMilliseconds 15000
Assert-Equal -Actual $result.ExitCode -Expected 7 -Message 'self-owned job preserves an intentional exit code'
Assert-OrdinalEqual -Actual $result.Stdout.Trim() -Expected '1' -Message 'job counts exactly the fixture owner'
Assert-True -Condition ($null -eq [Companion.Runtime.NativeJobs]::Observe($jobName)) -Message 'job is gone after fixture exit'

# Arrange/Act/Assert: killing only the job owner terminates the inherited descendant and its pipes.
$fixture = New-ScratchCompanionRoot -Prefix 'runtime-jobs'
$treeName = 'Global\game-companion-process-' + [guid]::NewGuid().ToString('N') + '-core'
$child = Start-BoundedPwsh -Arguments @('-File', (Join-Path $PSScriptRoot 'fixtures/job-owner.ps1'), '-JobName', $treeName, '-Mode', 'Tree', '-FixtureRoot', $fixture)
try {
    $deadline = [Diagnostics.Stopwatch]::StartNew()
    while (-not [IO.File]::Exists((Join-Path $fixture 'descendant.json')) -and $deadline.ElapsedMilliseconds -lt 10000) { [Threading.Thread]::Sleep(25) }
    Assert-True -Condition ([IO.File]::Exists((Join-Path $fixture 'descendant.json'))) -Message 'descendant reached its fixture entry point'
    $descendant = Get-Content -LiteralPath (Join-Path $fixture 'descendant.json') -Raw | ConvertFrom-Json -DateKind String
    $members = [Companion.Runtime.NativeJobs]::Members($treeName)
    $memberDescriptions = @(Get-Process -Id $members | Select-Object Id, ProcessName)
    Write-Output (ConvertTo-Json -InputObject ([ordered]@{ jobMembers = $memberDescriptions }) -Compress)
    Assert-True -Condition ($members -ccontains $child.Process.Id) -Message 'job includes its owner process'
    Assert-True -Condition ($members -ccontains [int] $descendant.pid) -Message 'job includes the independently observed descendant'
    $collision = Invoke-BoundedPwsh -Arguments @('-File', (Join-Path $PSScriptRoot 'fixtures/job-owner.ps1'), '-JobName', $treeName) -TimeoutMilliseconds 10000
    Assert-Equal -Actual $collision.ExitCode -Expected 1 -Message 'existing job cannot be adopted by another owner'
    $afterCollision = [Companion.Runtime.NativeJobs]::Members($treeName)
    Assert-True -Condition ($afterCollision -ccontains $child.Process.Id) -Message 'collision preserves original owner'
    Assert-True -Condition ($afterCollision -ccontains [int] $descendant.pid) -Message 'collision preserves original descendant'
    $child.Process.Kill($false)
    Assert-True -Condition $child.Process.WaitForExit(5000) -Message 'killed job owner exits'
    $deadline.Restart()
    while ($null -ne [Companion.Runtime.NativeJobs]::Observe($treeName) -and $deadline.ElapsedMilliseconds -lt 5000) { [Threading.Thread]::Sleep(25) }
    Assert-True -Condition ($null -eq [Companion.Runtime.NativeJobs]::Observe($treeName)) -Message 'job is absent only after its descendant terminates'
}
finally {
    [IO.File]::WriteAllText((Join-Path $fixture 'stop'), 'stop')
    if (-not $child.Process.HasExited) { $child.Process.Kill($true) }
    $null = Complete-BoundedPwsh -Child $child -TimeoutMilliseconds 10000
}
Write-Output 'PASS: native process jobs'
