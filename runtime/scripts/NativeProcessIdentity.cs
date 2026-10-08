#nullable enable
using System;
using System.Diagnostics;
using System.Globalization;

namespace Companion.Runtime;

public sealed record ProcessIdentity(int Pid, string Created);

public static class NativeProcessIdentity
{
    public static ProcessIdentity? Read(int processId)
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

        using (process)
        {
            _ = process.Handle;

            return new ProcessIdentity(process.Id, process.StartTime.ToUniversalTime().ToFileTimeUtc().ToString(CultureInfo.InvariantCulture));
        }
    }
}
