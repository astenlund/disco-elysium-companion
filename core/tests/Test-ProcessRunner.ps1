#Requires -Version 7.5

[CmdletBinding()]
param(
    [Parameter()]
    [ValidateSet('All', 'Streams', 'CleanExit', 'InheritedPipe', 'StreamCloseFailure', 'KillFailure', 'BoundaryOutput', 'LargeStreams', 'RelativeExecutableResolution')]
    [string] $Only = 'All'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Import-Module (Join-Path (Split-Path $PSScriptRoot -Parent) 'DigestDiff.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'TestSupport.psm1') -Force

function Test-AdapterCommandCapturesBothStreamsAndExitCode {
    $result = Invoke-AdapterCommand -Command @('pwsh', '-NoProfile', '-Command', '[Console]::Out.Write("out"); [Console]::Error.Write("err"); exit 7') -WorkingDirectory $PSScriptRoot

    Assert-Equal -Actual $result.ExitCode -Expected 7 -Message 'nonzero adapter exit is retained as transport data'
    Assert-Equal -Actual $result.StandardOutput -Expected 'out' -Message 'stdout is drained completely'
    Assert-Equal -Actual $result.StandardError -Expected 'err' -Message 'stderr is drained completely'
    Assert-False -Condition $result.Succeeded -Message 'a nonzero exit cannot be successful transport'
}

function Test-AdapterCommandAcceptsCleanExit {
    $result = Invoke-AdapterCommand -Command @('pwsh', '-NoProfile', '-Command', '[Console]::Out.Write("ok")') -WorkingDirectory $PSScriptRoot

    Assert-True -Condition $result.Succeeded -Message 'clean exit with both streams drained succeeds'
    Assert-Equal -Actual $result.StandardOutput -Expected 'ok' -Message 'clean output is preserved'
}

function Test-AdapterCommandTimesOutWhenAnInheritedPipePreventsEof {
    $command = @('pwsh', '-NoProfile', '-Command', '$child = [Diagnostics.Process]::new(); $child.StartInfo.FileName = "pwsh"; $child.StartInfo.Arguments = "-NoProfile -Command `"Start-Sleep -Seconds 3`""; $child.StartInfo.UseShellExecute = $false; [void] $child.Start(); exit')
    $result = Invoke-AdapterCommand -Command $command -WorkingDirectory $PSScriptRoot -TimeoutSeconds 1

    Assert-True -Condition $result.TimedOut -Message 'adapter transport requires both stream EOFs before accepting process completion'
    Assert-False -Condition $result.Succeeded -Message 'a stream drain timeout cannot accept output'
}

function Test-AdapterCommandReportsInjectedStreamCloseFailure {
    $hooks = @{
        CloseStandardOutput = {
            param($Stream)

            throw [System.IO.IOException]::new('injected stream close failure')
        }
    }
    $result = Invoke-InCompanionModule {
        param($TestHooks, $WorkingDirectory)

        $script:AdapterCommandTestHooks = $TestHooks
        try {
            Invoke-AdapterCommand -Command @('pwsh', '-NoProfile', '-Command', 'Start-Sleep -Seconds 3') -WorkingDirectory $WorkingDirectory -TimeoutSeconds 1
        }
        finally {
            $script:AdapterCommandTestHooks = $null
        }
    } @($hooks, $PSScriptRoot)

    Assert-True -Condition $result.TimedOut -Message 'a timeout still selects the command deadline as the terminal cause'
    Assert-True -Condition ($null -ne $result.TransportException) -Message 'a forced redirected-stream close failure is retained as transport evidence'
    Assert-Equal -Actual $result.TransportException.Message -Expected 'injected stream close failure' -Message 'a forced redirected-stream close failure is retained as transport evidence'
}

function Test-AdapterCommandReportsInjectedKillFailureAndDiscardsCapture {
    $hooks = @{
        Kill = {
            param($Process)

            throw [System.InvalidOperationException]::new('injected kill failure')
        }
    }
    $result = Invoke-InCompanionModule {
        param($TestHooks, $WorkingDirectory)

        $script:AdapterCommandTestHooks = $TestHooks
        try {
            Invoke-AdapterCommand -Command @('pwsh', '-NoProfile', '-Command', '[Console]::Out.Write("partial"); Start-Sleep -Seconds 3') -WorkingDirectory $WorkingDirectory -TimeoutSeconds 1
        }
        finally {
            $script:AdapterCommandTestHooks = $null
        }
    } @($hooks, $PSScriptRoot)

    Assert-True -Condition $result.TimedOut -Message 'a timeout remains the terminal cause when process-tree termination fails'
    Assert-Equal -Actual $result.TransportException.Message -Expected 'injected kill failure' -Message 'a forced process-tree termination failure is retained as transport evidence'
    Assert-Equal -Actual $result.StandardOutput -Expected '' -Message 'a failed transport never retains partial stdout'
    Assert-Equal -Actual $result.StandardError -Expected '' -Message 'a failed transport never retains partial stderr'
}

function Test-AdapterCommandDrainsBufferBoundaryOutput {
    $result = Invoke-AdapterCommand -Command @('pwsh', '-NoProfile', '-Command', '[Console]::Out.Write("x" * 65537); [Console]::Error.Write("y" * 65536)') -WorkingDirectory $PSScriptRoot

    Assert-True -Condition $result.Succeeded -Message 'buffer-boundary stream output is fully drained'
    Assert-Equal -Actual $result.StandardOutput.Length -Expected 65537 -Message 'stdout does not truncate at a pump boundary'
    Assert-Equal -Actual $result.StandardError.Length -Expected 65536 -Message 'stderr does not truncate at a pump boundary'
}

function Test-AdapterCommandDrainsConcurrentLargeStreams {
    $result = Invoke-AdapterCommand -Command @('pwsh', '-NoProfile', '-Command', '[Console]::Out.Write("x" * 8388608); [Console]::Error.Write("y" * 8388608)') -WorkingDirectory $PSScriptRoot

    Assert-True -Condition $result.Succeeded -Message 'simultaneous large redirected streams drain without deadlock'
    Assert-Equal -Actual $result.StandardOutput.Length -Expected 8388608 -Message 'stdout retains every drained large-stream character'
    Assert-Equal -Actual $result.StandardError.Length -Expected 8388608 -Message 'stderr retains every drained large-stream character'
}

function Test-RelativeExecutableResolution {
    $scratch = Join-Path (Split-Path $PSScriptRoot -Parent) ('.tmp/relative-exe-' + [guid]::NewGuid().ToString('N'))
    try {
        $toolRoot = Join-Path $scratch 'dump-tool'
        [void] [IO.Directory]::CreateDirectory($toolRoot)
        Copy-Item -LiteralPath (Join-Path $env:WINDIR 'System32\cmd.exe') -Destination (Join-Path $toolRoot 'dedump.exe') -Force

        # A separator-containing relative argv[0] is resolved against the working directory
        # by CORE before spawning (spec section 8); the child working directory alone does
        # not locate the executable on .NET.
        $relativeWithSeparator = Invoke-AdapterCommand -Command @('dump-tool\dedump.exe', '/c', 'exit 3') -WorkingDirectory $scratch
        Assert-True -Condition $relativeWithSeparator.Started -Message 'a separator-containing relative executable is resolved against the working directory'
        Assert-Equal -Actual $relativeWithSeparator.ExitCode -Expected 3 -Message 'the working-directory-resolved relative start reaches its ordinary exit'

        # A bare name (no separator) resolves via PATH only, never from the working
        # directory: dedump.exe exists there but is not on PATH, so the start fails.
        $bareNotOnPath = Invoke-AdapterCommand -Command @('dedump.exe', '/c', 'exit 3') -WorkingDirectory $toolRoot
        Assert-False -Condition $bareNotOnPath.Started -Message 'a bare name resolves via PATH and is not found when it is not on PATH'
        Assert-True -Condition ($null -ne $bareNotOnPath.TransportException) -Message 'the unpathable bare name is retained as transport evidence'

        $absolute = Invoke-AdapterCommand -Command @((Join-Path $toolRoot 'dedump.exe'), '/c', 'exit 3') -WorkingDirectory $scratch
        Assert-True -Condition $absolute.Started -Message 'the absolute path starts the same executable'
        Assert-Equal -Actual $absolute.ExitCode -Expected 3 -Message 'the absolute-path start reaches its ordinary exit'
    }
    finally {
        Remove-Item -LiteralPath $scratch -Recurse -Force -ErrorAction SilentlyContinue
    }
}

$tests = [ordered]@{ Streams = ${function:Test-AdapterCommandCapturesBothStreamsAndExitCode}; CleanExit = ${function:Test-AdapterCommandAcceptsCleanExit}; InheritedPipe = ${function:Test-AdapterCommandTimesOutWhenAnInheritedPipePreventsEof}; BoundaryOutput = ${function:Test-AdapterCommandDrainsBufferBoundaryOutput}; LargeStreams = ${function:Test-AdapterCommandDrainsConcurrentLargeStreams}; StreamCloseFailure = ${function:Test-AdapterCommandReportsInjectedStreamCloseFailure}; KillFailure = ${function:Test-AdapterCommandReportsInjectedKillFailureAndDiscardsCapture}; RelativeExecutableResolution = ${function:Test-RelativeExecutableResolution} }
if ($Only -eq 'All') { foreach ($test in $tests.Values) { & $test } } else { & $tests[$Only] }

Write-Output 'PASS: Process runner'
