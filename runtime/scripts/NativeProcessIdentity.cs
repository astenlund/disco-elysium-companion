#nullable enable
using System;
using System.Diagnostics;
using System.Globalization;

namespace Companion.Runtime;

public sealed record ProcessIdentity(int Pid, string Created);

public sealed class PinnedProcessIdentity : IDisposable
{
    private readonly Process process;

    internal PinnedProcessIdentity(Process process)
    {
        this.process = process;
        Pid = process.Id;
        Created = process.StartTime.ToUniversalTime().ToFileTimeUtc().ToString(CultureInfo.InvariantCulture);
    }

    public int Pid { get; }

    public string Created { get; }

    public void Dispose()
    {
        process.Dispose();
    }
}

public static class NativeProcessIdentity
{
    public static ProcessIdentity? Read(int processId)
    {
        using var pinned = Pin(processId);
        if (pinned is null)
        {

            return null;
        }

        return new ProcessIdentity(pinned.Pid, pinned.Created);
    }

    public static PinnedProcessIdentity? Pin(int processId)
    {
        if (processId <= 0)
        {
            throw new ArgumentOutOfRangeException(nameof(processId));
        }

        Process process;
        try
        {
            process = Process.GetProcessById(processId);
        }
        catch (ArgumentException)
        {
            // GetProcessById positively reports that this valid PID is not running.

            return null;
        }

        try
        {
            _ = process.Handle;

            return new PinnedProcessIdentity(process);
        }
        catch
        {
            process.Dispose();
            throw;
        }
    }
}
