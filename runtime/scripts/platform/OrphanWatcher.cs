#nullable enable
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;
using System.Threading;
using Microsoft.Win32.SafeHandles;

namespace Companion.Runtime;

public static class OrphanWatcher
{
    public static string Reconcile(int processId, string created, string jobName)
    {
        if (processId < 1 || !Regex.IsMatch(created, @"^[1-9][0-9]{0,18}$", RegexOptions.CultureInvariant)
            || !long.TryParse(created, NumberStyles.None, CultureInfo.InvariantCulture, out _)
            || !Regex.IsMatch(jobName, @"^Global\\game-companion-process-[a-f0-9]{32}-watcher$", RegexOptions.CultureInvariant))
        {
            throw new ArgumentException("Invalid watcher recovery identity.");
        }

        Process process;
        try
        {
            process = Process.GetProcessById(processId);
        }
        catch (ArgumentException)
        {
            // A missing PID is affirmative absence, not a failed process probe.

            return "absent";
        }

        using (process)
        {
            if (process.StartTime.ToUniversalTime().ToFileTimeUtc().ToString(CultureInfo.InvariantCulture) != created)
            {
                return "reused";
            }

            var handle = process.Handle;
            using var job = OpenJobObjectW(0x0004 | 0x0008, false, jobName);
            if (job.IsInvalid)
            {
                if (process.HasExited)
                {
                    return "absent";
                }

                throw new Win32Exception(Marshal.GetLastWin32Error());
            }

            if (!IsProcessInJob(handle, job, out var member))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }

            if (!member)
            {
                throw new IOException("Recorded watcher is not owned by this scope.");
            }

            if (!TerminateJobObject(job, 1))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }

            var deadline = Stopwatch.StartNew();
            do
            {
                if (!QueryInformationJobObject(job, 1, out var accounting, (uint)Marshal.SizeOf<Accounting>(), out var bytes) || bytes != Marshal.SizeOf<Accounting>())
                {
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                }

                if (accounting.ActiveProcesses == 0)
                {
                    return "terminated";
                }

                Thread.Sleep(20);
            }
            while (deadline.ElapsedMilliseconds < 10000);

            throw new IOException("Watcher tree termination did not complete.");
        }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Accounting
    {
        public long UserTime;
        public long KernelTime;
        public long PeriodUserTime;
        public long PeriodKernelTime;
        public uint PageFaults;
        public uint TotalProcesses;
        public uint ActiveProcesses;
        public uint TerminatedProcesses;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, ExactSpelling = true)]
    private static extern SafeFileHandle OpenJobObjectW(uint access, [MarshalAs(UnmanagedType.Bool)] bool inherit, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsProcessInJob(IntPtr process, SafeFileHandle job, [MarshalAs(UnmanagedType.Bool)] out bool result);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool TerminateJobObject(SafeFileHandle job, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool QueryInformationJobObject(SafeFileHandle job, int informationClass, out Accounting information, uint length, out uint returnedLength);
}
