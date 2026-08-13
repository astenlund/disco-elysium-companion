#Requires -Version 7.5

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$supportPath = Join-Path $PSScriptRoot 'TestSupport.psm1'
$fencePath = Join-Path (Split-Path $PSScriptRoot -Parent) 'EntryFence.psm1'

if (-not (Test-Path -LiteralPath $supportPath -PathType Leaf)) {
    [Console]::Error.WriteLine('FAIL: TestSupport.psm1 is required')
    exit 1
}

if (-not (Test-Path -LiteralPath $fencePath -PathType Leaf)) {
    [Console]::Error.WriteLine('FAIL: EntryFence.psm1 is required')
    exit 1
}

Import-Module $supportPath -Force
Import-Module $fencePath -Force

$token = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
$failureText = '[maintenance] state extraction maintenance is active'
$scratchRoots = [System.Collections.Generic.List[string]]::new()

function New-FenceFixture {
    $root = New-ScratchCompanionRoot -Prefix 'entry-fence'
    $scratchRoots.Add($root)
    [void] [System.IO.Directory]::CreateDirectory((Join-Path $root '.tmp'))

    return $root
}

function Write-Utf8Fixture {
    param(
        [Parameter(Mandatory)] [string] $Path,
        [Parameter(Mandatory)] [string] $Text
    )

    [System.IO.File]::WriteAllText($Path, $Text, [System.Text.UTF8Encoding]::new($false))
}

function Write-Sentinel {
    param(
        [Parameter(Mandatory)] [string] $Root,
        [Parameter()] [string] $BypassToken = $token
    )

    $json = '{"result":"maintenance","bypassToken":"' + $BypassToken + '"}'
    Write-Utf8Fixture -Path (Join-Path $Root '.tmp/state-extraction-v2-maintenance.json') -Text $json
}

function Write-Checkpoint {
    param([Parameter(Mandatory)] [string] $Root)

    Write-Utf8Fixture -Path (Join-Path $Root '.tmp/state-extraction-v2-cutover.json') -Text '{"phase":"prepared"}'
}

function Invoke-WithToken {
    param(
        [Parameter(Mandatory)] [string] $Root,
        [AllowNull()] [string] $Value
    )

    $prior = [Environment]::GetEnvironmentVariable('COMPANION_STATE_EXTRACTION_MAINTENANCE_TOKEN')
    try {
        [Environment]::SetEnvironmentVariable('COMPANION_STATE_EXTRACTION_MAINTENANCE_TOKEN', $Value)
        $lease = Enter-CompanionEntryFence -CompanionRoot $Root
        try {
            return $true
        }
        finally {
            $lease.Dispose()
        }
    }
    finally {
        [Environment]::SetEnvironmentVariable('COMPANION_STATE_EXTRACTION_MAINTENANCE_TOKEN', $prior)
    }
}

function Start-FenceHolder {
    param(
        [Parameter(Mandatory)] [string] $Root,
        [Parameter(Mandatory)] [string] $ReadyPath,
        [Parameter(Mandatory)] [string] $ReleasePath
    )

    $scriptPath = Join-Path $Root 'holder.ps1'
    if (-not (Test-Path -LiteralPath $scriptPath)) {
        $scriptText = @'
param([string] $FencePath, [string] $Root, [string] $ReadyPath, [string] $ReleasePath)
Import-Module $FencePath -Force
$lease = Enter-CompanionEntryFence -CompanionRoot $Root
try {
    [System.IO.File]::WriteAllText($ReadyPath, 'ready')
    while (-not (Test-Path -LiteralPath $ReleasePath)) {
        Start-Sleep -Milliseconds 20
    }
}
finally {
    $lease.Dispose()
}
'@
        Write-Utf8Fixture -Path $scriptPath -Text $scriptText
    }

    $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = 'pwsh'
    $startInfo.UseShellExecute = $false
    foreach ($argument in @('-NoProfile', '-File', $scriptPath, '-FencePath', $fencePath, '-Root', $Root, '-ReadyPath', $ReadyPath, '-ReleasePath', $ReleasePath)) {
        $startInfo.ArgumentList.Add($argument)
    }

    return [System.Diagnostics.Process]::Start($startInfo)
}

function Wait-ForFixturePath {
    param([Parameter(Mandatory)] [string] $Path)

    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    while (-not (Test-Path -LiteralPath $Path)) {
        if ([DateTime]::UtcNow -ge $deadline) {
            throw "Timed out waiting for fixture path: $Path"
        }

        Start-Sleep -Milliseconds 20
    }
}

function Open-ExclusiveFence {
    param([Parameter(Mandatory)] [string] $Root)

    return [System.IO.File]::Open(
        (Join-Path $Root '.tmp/state-extraction-v2-entry-fence.lock'),
        [System.IO.FileMode]::OpenOrCreate,
        [System.IO.FileAccess]::ReadWrite,
        [System.IO.FileShare]::None)
}

function New-TestInfrastructureRoot {
    $root = New-ScratchCompanionRoot -Prefix 'test-infrastructure'
    $scratchRoots.Add($root)

    return $root
}

function Invoke-ScratchRootProbe {
    param([Parameter(Mandatory)] [string] $ModulePath)

    $probePath = Join-Path ([System.IO.Directory]::GetParent($ModulePath).Parent.Parent.FullName) 'probe-scratch-root.ps1'
    $probe = @'
param([string] $ModulePath)
Import-Module $ModulePath -Force
try {
    $path = New-ScratchCompanionRoot -Prefix 'reparse-probe'
    Write-Output $path
    exit 0
}
catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 17
}
'@
    Write-Utf8Fixture -Path $probePath -Text $probe

    return Invoke-BoundedPwsh -Arguments @('-File', $probePath, '-ModulePath', $ModulePath) -TimeoutMilliseconds 30000
}

function New-TestSupportProject {
    param([Parameter(Mandatory)] [string] $Root)

    $testsRoot = Join-Path $Root 'core/tests'
    [void] [System.IO.Directory]::CreateDirectory($testsRoot)
    Copy-Item -LiteralPath $supportPath -Destination (Join-Path $testsRoot 'TestSupport.psm1')

    return $testsRoot
}

function New-DispatcherFixture {
    param([Parameter(Mandatory)] [string] $Root)

    $testsRoot = Join-Path $Root 'core/tests'
    $adapterRoot = Join-Path $Root 'adapters/disco_elysium'
    [void] [System.IO.Directory]::CreateDirectory($testsRoot)
    [void] [System.IO.Directory]::CreateDirectory($adapterRoot)
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'Invoke-StateExtractionTests.ps1') -Destination (Join-Path $testsRoot 'Invoke-StateExtractionTests.ps1')
    $mandatoryPaths = @(
        (Join-Path $testsRoot 'Test-EntryFence.ps1')
    )
    foreach ($path in $mandatoryPaths) {
        Write-Utf8Fixture -Path $path -Text "Write-Output 'fixture pass'`nexit 0`n"
    }

    return [pscustomobject]@{
        DispatcherPath = Join-Path $testsRoot 'Invoke-StateExtractionTests.ps1'
        MandatoryPaths = $mandatoryPaths
    }
}

try {
    $normalRoot = New-FenceFixture
    Assert-True -Condition (Invoke-WithToken -Root $normalRoot -Value $null) -Message 'normal acquisition returns a disposable shared lease'

    $sentinelRoot = New-FenceFixture
    Write-Sentinel -Root $sentinelRoot
    Assert-ThrowsType -TypeName 'System.InvalidOperationException' -Action { Invoke-WithToken -Root $sentinelRoot -Value $null }
    try {
        Invoke-WithToken -Root $sentinelRoot -Value $null
        throw 'Expected maintenance failure.'
    }
    catch {
        Assert-OrdinalEqual -Actual $_.Exception.Message -Expected $failureText -Message 'sentinel failure uses the fixed maintenance text'
    }
    Assert-True -Condition (Invoke-WithToken -Root $sentinelRoot -Value $token) -Message 'exact bypass token admits a sentinel-gated entry'
    Assert-ThrowsType -TypeName 'System.InvalidOperationException' -Action { Invoke-WithToken -Root $sentinelRoot -Value $token.ToUpperInvariant() }

    $checkpointRoot = New-FenceFixture
    Write-Checkpoint -Root $checkpointRoot
    Assert-ThrowsType -TypeName 'System.InvalidOperationException' -Action { Invoke-WithToken -Root $checkpointRoot -Value $token }
    Write-Sentinel -Root $checkpointRoot
    Assert-True -Condition (Invoke-WithToken -Root $checkpointRoot -Value $token) -Message 'authenticated sentinel admits a checkpoint-gated entry'

    foreach ($malformedName in 'state-extraction-v2-maintenance.json', 'state-extraction-v2-cutover.json') {
        $malformedRoot = New-FenceFixture
        Write-Utf8Fixture -Path (Join-Path $malformedRoot ".tmp/$malformedName") -Text '{'
        Assert-ThrowsType -TypeName 'System.InvalidOperationException' -Action { Invoke-WithToken -Root $malformedRoot -Value $token }
    }

    $kindRoot = New-FenceFixture
    [void] [System.IO.Directory]::CreateDirectory((Join-Path $kindRoot '.tmp/state-extraction-v2-entry-fence.lock'))
    Assert-ThrowsType -TypeName 'System.InvalidOperationException' -Action { Invoke-WithToken -Root $kindRoot -Value $null }

    $sharedRoot = New-FenceFixture
    $readyOne = Join-Path $sharedRoot 'ready-one'
    $readyTwo = Join-Path $sharedRoot 'ready-two'
    $releaseOne = Join-Path $sharedRoot 'release-one'
    $releaseTwo = Join-Path $sharedRoot 'release-two'
    $holderOne = Start-FenceHolder -Root $sharedRoot -ReadyPath $readyOne -ReleasePath $releaseOne
    $holderTwo = Start-FenceHolder -Root $sharedRoot -ReadyPath $readyTwo -ReleasePath $releaseTwo
    try {
        Wait-ForFixturePath -Path $readyOne
        Wait-ForFixturePath -Path $readyTwo
        Assert-ThrowsType -TypeName 'System.IO.IOException' -Action { $exclusive = Open-ExclusiveFence -Root $sharedRoot; $exclusive.Dispose() }
        Write-Utf8Fixture -Path $releaseOne -Text 'release'
        Assert-True -Condition $holderOne.WaitForExit(5000) -Message 'first shared holder exits after release'
        Assert-ThrowsType -TypeName 'System.IO.IOException' -Action { $exclusive = Open-ExclusiveFence -Root $sharedRoot; $exclusive.Dispose() }
        Write-Utf8Fixture -Path $releaseTwo -Text 'release'
        Assert-True -Condition $holderTwo.WaitForExit(5000) -Message 'second shared holder exits after release'
        $exclusive = Open-ExclusiveFence -Root $sharedRoot
        $exclusive.Dispose()
    }
    finally {
        foreach ($holder in @($holderOne, $holderTwo)) {
            if (-not $holder.HasExited) {
                $holder.Kill($true)
            }
            $holder.Dispose()
        }
    }

    $terminationRoot = New-FenceFixture
    $terminationReady = Join-Path $terminationRoot 'ready'
    $terminationRelease = Join-Path $terminationRoot 'release'
    $terminatedHolder = Start-FenceHolder -Root $terminationRoot -ReadyPath $terminationReady -ReleasePath $terminationRelease
    try {
        Wait-ForFixturePath -Path $terminationReady
        $terminatedHolder.Kill($true)
        Assert-True -Condition $terminatedHolder.WaitForExit(5000) -Message 'holder process terminates on demand'
        $exclusive = Open-ExclusiveFence -Root $terminationRoot
        $exclusive.Dispose()
    }
    finally {
        if (-not $terminatedHolder.HasExited) {
            $terminatedHolder.Kill($true)
        }
        $terminatedHolder.Dispose()
    }

    foreach ($gateName in 'state-extraction-v2-maintenance.json', 'state-extraction-v2-cutover.json') {
        $raceRoot = New-FenceFixture
        $exclusive = Open-ExclusiveFence -Root $raceRoot
        try {
            $raceScript = @'
param([string] $FencePath, [string] $Root)
Import-Module $FencePath -Force
try {
    $lease = Enter-CompanionEntryFence -CompanionRoot $Root
    $lease.Dispose()
    exit 0
}
catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 17
}
'@
            $raceScriptPath = Join-Path $raceRoot 'race.ps1'
            Write-Utf8Fixture -Path $raceScriptPath -Text $raceScript
            $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
            $startInfo.FileName = 'pwsh'
            $startInfo.UseShellExecute = $false
            $startInfo.RedirectStandardError = $true
            foreach ($argument in @('-NoProfile', '-File', $raceScriptPath, '-FencePath', $fencePath, '-Root', $raceRoot)) {
                $startInfo.ArgumentList.Add($argument)
            }
            $raceProcess = [System.Diagnostics.Process]::Start($startInfo)
            Start-Sleep -Milliseconds 200
            if ($gateName -eq 'state-extraction-v2-maintenance.json') {
                Write-Sentinel -Root $raceRoot
            }
            else {
                Write-Checkpoint -Root $raceRoot
            }
        }
        finally {
            $exclusive.Dispose()
        }

        try {
            Assert-True -Condition $raceProcess.WaitForExit(10000) -Message "$gateName post-acquisition race child exits"
            $raceError = $raceProcess.StandardError.ReadToEnd().Trim()
            Assert-Equal -Actual $raceProcess.ExitCode -Expected 17 -Message "$gateName published during acquisition blocks entry"
            Assert-True -Condition $raceError.Contains($failureText, [System.StringComparison]::Ordinal) -Message "$gateName race reports fixed maintenance failure"
        }
        finally {
            if (-not $raceProcess.HasExited) {
                $raceProcess.Kill($true)
            }
            $raceProcess.Dispose()
        }
    }

    $projectReparseFixture = New-TestInfrastructureRoot
    $physicalProject = Join-Path $projectReparseFixture 'physical-project'
    $physicalTests = New-TestSupportProject -Root $physicalProject
    [void] [System.IO.Directory]::CreateDirectory((Join-Path $physicalProject '.tmp'))
    $projectAlias = Join-Path $projectReparseFixture 'project-alias'
    $null = New-Item -ItemType SymbolicLink -Path $projectAlias -Target $physicalProject
    $projectAliasModule = Join-Path $projectAlias 'core/tests/TestSupport.psm1'
    $projectReparseRun = Invoke-ScratchRootProbe -ModulePath $projectAliasModule
    Assert-Equal -Actual $projectReparseRun.ExitCode -Expected 17 -Message 'project-root directory reparse is rejected'
    Assert-True -Condition $projectReparseRun.StdErr.Contains('reparse', [System.StringComparison]::OrdinalIgnoreCase) -Message 'project-root directory reparse reports its class'
    Assert-Equal -Actual @(Get-ChildItem -LiteralPath (Join-Path $physicalProject '.tmp') -Force).Count -Expected 0 -Message 'project-root reparse creates no scratch directory through its target'

    foreach ($targetKind in 'File', 'Directory') {
        $tmpReparseFixture = New-TestInfrastructureRoot
        $tmpProject = Join-Path $tmpReparseFixture 'project'
        $tmpTests = New-TestSupportProject -Root $tmpProject
        $externalTarget = Join-Path $tmpReparseFixture "outside-$($targetKind.ToLowerInvariant())"
        if ($targetKind -eq 'File') {
            Write-Utf8Fixture -Path $externalTarget -Text 'outside-marker'
        }
        else {
            [void] [System.IO.Directory]::CreateDirectory($externalTarget)
            Write-Utf8Fixture -Path (Join-Path $externalTarget 'marker.txt') -Text 'outside-marker'
        }
        $null = New-Item -ItemType SymbolicLink -Path (Join-Path $tmpProject '.tmp') -Target $externalTarget
        $tmpReparseRun = Invoke-ScratchRootProbe -ModulePath (Join-Path $tmpTests 'TestSupport.psm1')
        Assert-Equal -Actual $tmpReparseRun.ExitCode -Expected 17 -Message ".tmp $targetKind reparse is rejected"
        Assert-True -Condition $tmpReparseRun.StdErr.Contains('reparse', [System.StringComparison]::OrdinalIgnoreCase) -Message ".tmp $targetKind reparse reports its class"
        if ($targetKind -eq 'File') {
            Assert-OrdinalEqual -Actual (Get-Content -Raw -LiteralPath $externalTarget) -Expected 'outside-marker' -Message '.tmp file reparse target remains unchanged'
        }
        else {
            Assert-OrdinalEqual -Actual (Get-Content -Raw -LiteralPath (Join-Path $externalTarget 'marker.txt')) -Expected 'outside-marker' -Message '.tmp directory reparse target remains unchanged'
            Assert-Equal -Actual @(Get-ChildItem -LiteralPath $externalTarget -Force).Count -Expected 1 -Message '.tmp directory reparse registers no recursive cleanup outside the project'
        }
    }

    $missingCount = @((New-DispatcherFixture -Root (New-TestInfrastructureRoot)).MandatoryPaths).Count
    for ($missingIndex = 0; $missingIndex -lt $missingCount; $missingIndex++) {
        $dispatcherRoot = New-TestInfrastructureRoot
        $dispatcherFixture = New-DispatcherFixture -Root $dispatcherRoot
        Remove-Item -LiteralPath $dispatcherFixture.MandatoryPaths[$missingIndex] -Force
        $allRun = Invoke-BoundedPwsh -Arguments @('-File', $dispatcherFixture.DispatcherPath, '-Group', 'All') -WorkingDirectory $dispatcherRoot
        Assert-Equal -Actual $allRun.ExitCode -Expected 1 -Message "All fails when mandatory script $missingIndex is absent"
        Assert-True -Condition $allRun.StdErr.Contains('Missing required test script:', [System.StringComparison]::Ordinal) -Message "All identifies missing mandatory script $missingIndex"
    }

    $completeDispatcherRoot = New-TestInfrastructureRoot
    $completeDispatcher = New-DispatcherFixture -Root $completeDispatcherRoot
    $completeAllRun = Invoke-BoundedPwsh -Arguments @('-File', $completeDispatcher.DispatcherPath, '-Group', 'All') -WorkingDirectory $completeDispatcherRoot
    Assert-Equal -Actual $completeAllRun.ExitCode -Expected 0 -Message 'All passes when every Task 1 mandatory script exists'
    $laterGroupRun = Invoke-BoundedPwsh -Arguments @('-File', $completeDispatcher.DispatcherPath, '-Group', 'Json') -WorkingDirectory $completeDispatcherRoot
    Assert-Equal -Actual $laterGroupRun.ExitCode -Expected 0 -Message 'later-task groups may skip files not created yet'

    Write-Output 'PASS: entry fence'
}
finally {
    foreach ($root in $scratchRoots) {
        if (Test-Path -LiteralPath $root) {
            Remove-Item -LiteralPath $root -Recurse -Force -Confirm:$false
        }
    }
}
