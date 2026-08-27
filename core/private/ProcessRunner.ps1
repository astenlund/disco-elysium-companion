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

if ($null -eq ('CompanionBoundedBytePump' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

public sealed class CompanionBoundedByteCapture
{
    public CompanionBoundedByteCapture(byte[] bytes, bool overflow)
    {
        Bytes = bytes;
        Overflow = overflow;
    }

    public byte[] Bytes { get; }

    public bool Overflow { get; }
}

public static class CompanionBoundedBytePump
{
    public static async Task<CompanionBoundedByteCapture> ReadAsync(
        Stream stream,
        int maximumBytes,
        TaskCompletionSource<bool> failureSignal,
        CancellationToken cancellationToken)
    {
        try
        {
            var encoding = new UTF8Encoding(false, true);
            var decoder = encoding.GetDecoder();
            var byteBuffer = new byte[65536];
            var charBuffer = new char[encoding.GetMaxCharCount(byteBuffer.Length)];
            using var output = new MemoryStream(Math.Min(maximumBytes, byteBuffer.Length));

            while (true)
            {
                var remainingWithOverflowSentinel = (long)maximumBytes - output.Length + 1;
                var requested = (int)Math.Min(byteBuffer.Length, remainingWithOverflowSentinel);
                var count = await stream.ReadAsync(byteBuffer.AsMemory(0, requested), cancellationToken).ConfigureAwait(false);
                if (count == 0)
                {
                    decoder.Convert(ReadOnlySpan<byte>.Empty, charBuffer.AsSpan(), true, out _, out _, out _);

                    return new CompanionBoundedByteCapture(output.ToArray(), false);
                }

                if (output.Length + count > maximumBytes)
                {
                    failureSignal.TrySetResult(true);

                    return new CompanionBoundedByteCapture(Array.Empty<byte>(), true);
                }

                output.Write(byteBuffer, 0, count);
                var bytesUsed = 0;
                while (bytesUsed < count)
                {
                    decoder.Convert(
                        byteBuffer.AsSpan(bytesUsed, count - bytesUsed),
                        charBuffer.AsSpan(),
                        false,
                        out var convertedBytes,
                        out _,
                        out _);
                    bytesUsed += convertedBytes;
                }
            }
        }
        catch
        {
            failureSignal.TrySetResult(true);
            throw;
        }
    }
}

public static class CompanionProcessTeardown
{
    public static Task RunAsync(
        Process process,
        Stream standardOutput,
        Stream standardError,
        CancellationTokenSource pumpCancellation,
        Task[] transportTasks,
        string failureOperation)
    {
        var killTask = Task.Run(() => TryKill(process, failureOperation));
        var standardOutputTask = Task.Run(() => TryClose(standardOutput, failureOperation, "CloseStandardOutput"));
        var standardErrorTask = Task.Run(() => TryClose(standardError, failureOperation, "CloseStandardError"));
        var cancellationTask = Task.Run(() => TryCancel(pumpCancellation));
        var drainTask = ObserveTransportAsync(transportTasks);

        return CompleteAsync(process, pumpCancellation, new[] { killTask, standardOutputTask, standardErrorTask, cancellationTask, drainTask });
    }

    private static void TryKill(Process process, string failureOperation)
    {
        try
        {
            if (string.Equals(failureOperation, "BlockKill", StringComparison.Ordinal))
            {
                Thread.Sleep(10000);
            }
            if (string.Equals(failureOperation, "Kill", StringComparison.Ordinal))
            {
                throw new InvalidOperationException("Injected child-kill failure.");
            }
            if (!process.HasExited)
            {
                process.Kill(true);
            }
        }
        catch
        {
            // Teardown is best-effort; the latched transport failure remains authoritative.
        }
    }

    private static void TryClose(Stream stream, string failureOperation, string operation)
    {
        try
        {
            if (string.Equals(failureOperation, operation, StringComparison.Ordinal))
            {
                throw new InvalidOperationException("Injected stream-close failure.");
            }
            stream.Close();
        }
        catch
        {
            // Teardown is best-effort; the latched transport failure remains authoritative.
        }
    }

    private static void TryCancel(CancellationTokenSource pumpCancellation)
    {
        try
        {
            pumpCancellation?.Cancel();
        }
        catch
        {
            // Teardown is best-effort; the latched transport failure remains authoritative.
        }
    }

    private static async Task ObserveTransportAsync(Task[] transportTasks)
    {
        try
        {
            await Task.WhenAll(transportTasks).ConfigureAwait(false);
        }
        catch
        {
            // Teardown is best-effort; the latched transport failure remains authoritative.
        }
    }

    private static async Task CompleteAsync(Process process, CancellationTokenSource pumpCancellation, Task[] teardownTasks)
    {
        await Task.WhenAll(teardownTasks).ConfigureAwait(false);
        try
        {
            pumpCancellation?.Dispose();
        }
        catch
        {
            // Teardown is best-effort; the latched transport failure remains authoritative.
        }

        try
        {
            process.Dispose();
        }
        catch
        {
            // Teardown is best-effort; the latched transport failure remains authoritative.
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
