$script:AdapterCommandTestHooks = $null

if ($null -eq ('CompanionProcessPump' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

public static class CompanionProcessPump
{
    public static async Task<string> ReadAsync(StreamReader reader, CancellationToken cancellationToken)
    {
        var buffer = new char[65536];
        var output = new StringBuilder();
        while (true)
        {
            var count = await reader.ReadAsync(buffer.AsMemory(0, buffer.Length), cancellationToken).ConfigureAwait(false);
            if (count == 0)
            {
                return output.ToString();
            }

            output.Append(buffer, 0, count);
        }
    }
}
'@
}

function Invoke-AdapterCommandTeardownOperation {
    param(
        [Parameter(Mandatory)] [ValidateSet('Kill', 'CloseStandardOutput', 'CloseStandardError')] [string] $Operation,
        [Parameter(Mandatory)] [object] $Target
    )

    if ($null -ne $script:AdapterCommandTestHooks -and $script:AdapterCommandTestHooks.ContainsKey($Operation)) {
        & $script:AdapterCommandTestHooks[$Operation] $Target

        return
    }

    if ([string]::Equals($Operation, 'Kill', [System.StringComparison]::Ordinal)) {
        $Target.Kill($true)

        return
    }

    $Target.BaseStream.Close()
}

function Invoke-AdapterCommand {
    param(
        [Parameter(Mandatory)] [string[]] $Command,
        [Parameter(Mandatory)] [string] $WorkingDirectory,
        [Parameter()] [int] $TimeoutSeconds = 120,
        [Parameter()] [Threading.CancellationToken] $CancellationToken = [Threading.CancellationToken]::None
    )

    $result = [AdapterCommandResult]::new()
    $result.ExitCode = -1
    $result.StandardOutput = ''
    $result.StandardError = ''
    if ($Command.Length -eq 0 -or $TimeoutSeconds -le 0) {
        $result.TransportException = [ArgumentException]::new('Invalid adapter command.')

        return $result
    }

    $process = $null
    $pumpCancellation = $null
    try {
        $startInfo = [Diagnostics.ProcessStartInfo]::new()
        $argv0 = $Command[0]
        # A relative argv[0] containing a separator is resolved against the working
        # directory by CORE before spawning: .NET locates the executable from the parent
        # process, never the child working directory (spec section 8). Bare names without
        # a separator resolve via PATH; absolute paths pass through untouched.
        if (-not [IO.Path]::IsPathFullyQualified($argv0) -and ($argv0.IndexOf([IO.Path]::DirectorySeparatorChar) -ge 0 -or $argv0.IndexOf([IO.Path]::AltDirectorySeparatorChar) -ge 0)) {
            $argv0 = [IO.Path]::GetFullPath((Join-Path $WorkingDirectory $argv0))
        }
        $startInfo.FileName = $argv0
        $startInfo.WorkingDirectory = $WorkingDirectory
        $startInfo.UseShellExecute = $false
        $startInfo.RedirectStandardOutput = $true
        $startInfo.RedirectStandardError = $true
        if ($Command.Length -gt 1) {
            foreach ($argument in $Command[1..($Command.Length - 1)]) { [void] $startInfo.ArgumentList.Add($argument) }
        }
        $process = [Diagnostics.Process]::new()
        $process.StartInfo = $startInfo
        if (-not $process.Start()) {
            $result.TransportException = [InvalidOperationException]::new('Adapter process did not start.')

            return $result
        }
        $result.Started = $true
        $pumpCancellation = [Threading.CancellationTokenSource]::new()
        $stdoutTask = [CompanionProcessPump]::ReadAsync($process.StandardOutput, $pumpCancellation.Token)
        $stderrTask = [CompanionProcessPump]::ReadAsync($process.StandardError, $pumpCancellation.Token)
        $exitTask = $process.WaitForExitAsync()
        $timeoutTask = [Threading.Tasks.Task]::Delay([TimeSpan]::FromSeconds($TimeoutSeconds), $CancellationToken)
        $completionTask = [Threading.Tasks.Task]::WhenAll(@($exitTask, $stdoutTask, $stderrTask))
        $completed = [Threading.Tasks.Task]::WhenAny(@($completionTask, $timeoutTask)).GetAwaiter().GetResult()
        if ($CancellationToken.IsCancellationRequested) { $result.Cancelled = $true }
        elseif ($completed -eq $timeoutTask) { $result.TimedOut = $true }
        elseif ($completionTask.IsFaulted) { $result.TransportException = $completionTask.Exception }
        if ($result.Cancelled -or $result.TimedOut) {
            try {
                Invoke-AdapterCommandTeardownOperation -Operation Kill -Target $process
            }
            catch {
                $result.TransportException = $_.Exception
            }

            foreach ($streamOperation in @(
                    [pscustomobject]@{ Name = 'CloseStandardOutput'; Reader = $process.StandardOutput },
                    [pscustomobject]@{ Name = 'CloseStandardError'; Reader = $process.StandardError })) {
                try {
                    Invoke-AdapterCommandTeardownOperation -Operation $streamOperation.Name -Target $streamOperation.Reader
                }
                catch {
                    if ($null -eq $result.TransportException) {
                        $result.TransportException = $_.Exception
                    }
                }
            }

            $pumpCancellation.Cancel()
        }
        try {
            $completionTask.Wait([TimeSpan]::FromSeconds(5)) | Out-Null
        }
        catch {
            if ($null -eq $result.TransportException -and -not $result.Cancelled -and -not $result.TimedOut) {
                $result.TransportException = $_.Exception
            }
        }
        if (-not $result.TimedOut -and -not $result.Cancelled -and $null -eq $result.TransportException -and $completionTask.IsCompletedSuccessfully) {
            $result.StandardOutput = $stdoutTask.GetAwaiter().GetResult()
            $result.StandardError = $stderrTask.GetAwaiter().GetResult()
        }
        if ($process.HasExited) { $result.ExitCode = $process.ExitCode }
        $result.Succeeded = $result.Started -and -not $result.TimedOut -and -not $result.Cancelled -and $null -eq $result.TransportException -and $result.ExitCode -eq 0
    }
    catch {
        $result.TransportException = $_.Exception
    }
    finally {
        if ($null -ne $pumpCancellation) { $pumpCancellation.Dispose() }
        if ($null -ne $process) { $process.Dispose() }
    }

    return $result
}
