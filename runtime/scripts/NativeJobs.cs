#nullable enable
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;
using Microsoft.Win32.SafeHandles;

namespace Companion.Runtime;

public static class NativeJobs
{
    private const uint KillOnClose = 0x2000;
    private const uint QueryAccess = 0x0004;
    private const int AccountingClass = 1;
    private const int ExtendedLimitsClass = 9;
    private static SafeFileHandle? ownedJob;

    public static void OwnCurrentProcess(string name)
    {
        ValidateName(name);
        if (ownedJob is not null)
        {
            throw new InvalidOperationException("This broker already owns a job.");
        }

        var job = CreateJobObjectW(IntPtr.Zero, name);
        var error = Marshal.GetLastWin32Error();
        var transferred = false;
        try
        {
            if (job.IsInvalid)
            {
                throw new Win32Exception(error);
            }

            if (error == 183)
            {
                throw new IOException("A predecessor still owns the process job.");
            }

            var limits = new ExtendedLimits { Basic = new BasicLimits { Flags = KillOnClose } };
            if (!SetInformationJobObject(job, ExtendedLimitsClass, ref limits, (uint)Marshal.SizeOf<ExtendedLimits>()))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }

            using var process = Process.GetCurrentProcess();
            if (!AssignProcessToJobObject(job, process.Handle))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }

            // The broker retains this handle for its entire lifetime. Closing it kills its tree.
            ownedJob = job;
            transferred = true;
        }
        finally
        {
            if (!transferred)
            {
                job.Dispose();
            }
        }
    }

    public static uint CurrentCount()
    {
        if (ownedJob is null)
        {
            throw new InvalidOperationException("No process job is owned.");
        }

        return Count(ownedJob);
    }

    public static uint? Observe(string name)
    {
        ValidateName(name);
        using var job = OpenJobObjectW(QueryAccess, false, name);
        if (job.IsInvalid)
        {
            var error = Marshal.GetLastWin32Error();
            if (error == 2)
            {
                return null;
            }

            throw new Win32Exception(error);
        }

        return Count(job);
    }

    private static uint Count(SafeFileHandle job)
    {
        if (!QueryInformationJobObject(job, AccountingClass, out var information, (uint)Marshal.SizeOf<Accounting>(), out var bytes) || bytes != Marshal.SizeOf<Accounting>())
        {
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }

        return information.ActiveProcesses;
    }

    public static int[] Members(string name, int maximum = 64)
    {
        ValidateName(name);
        if (maximum < 1 || maximum > 1024)
        {
            throw new ArgumentOutOfRangeException(nameof(maximum));
        }

        using var job = OpenJobObjectW(QueryAccess, false, name);
        if (job.IsInvalid)
        {
            var error = Marshal.GetLastWin32Error();
            if (error == 2)
            {
                return [];
            }

            throw new Win32Exception(error);
        }

        var capacity = 8 + maximum * IntPtr.Size;
        var buffer = Marshal.AllocHGlobal(capacity);
        try
        {
            if (!QueryInformationJobObject(job, 3, buffer, (uint)capacity, out var returned))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }

            var assigned = Marshal.ReadInt32(buffer);
            var count = Marshal.ReadInt32(buffer, 4);
            if (assigned != count || count < 0 || count > maximum || returned < 8 + count * IntPtr.Size || returned > capacity)
            {
                throw new IOException("Job membership could not be read completely.");
            }

            var members = new int[count];
            for (var index = 0; index < count; index++)
            {
                var processId = Marshal.ReadIntPtr(buffer, 8 + index * IntPtr.Size).ToInt64();
                if (processId < 1 || processId > int.MaxValue)
                {
                    throw new IOException("Job process identity is invalid.");
                }

                members[index] = (int)processId;
            }

            return members;
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    private static void ValidateName(string name)
    {
        if (!Regex.IsMatch(name, @"^Global\\game-companion-process-[a-f0-9]{32}-(core|publication|provider|watcher|metadata)$", RegexOptions.CultureInvariant))
        {
            throw new ArgumentException("Invalid process job name.", nameof(name));
        }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct BasicLimits
    {
        public long ProcessTime;
        public long JobTime;
        public uint Flags;
        public UIntPtr MinimumWorkingSet;
        public UIntPtr MaximumWorkingSet;
        public uint ActiveLimit;
        public UIntPtr Affinity;
        public uint Priority;
        public uint Scheduling;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters
    {
        public ulong ReadOperations;
        public ulong WriteOperations;
        public ulong OtherOperations;
        public ulong ReadBytes;
        public ulong WriteBytes;
        public ulong OtherBytes;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ExtendedLimits
    {
        public BasicLimits Basic;
        public IoCounters Io;
        public UIntPtr ProcessMemory;
        public UIntPtr JobMemory;
        public UIntPtr PeakProcessMemory;
        public UIntPtr PeakJobMemory;
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
    private static extern SafeFileHandle CreateJobObjectW(IntPtr security, string name);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, ExactSpelling = true)]
    private static extern SafeFileHandle OpenJobObjectW(uint access, [MarshalAs(UnmanagedType.Bool)] bool inherit, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool AssignProcessToJobObject(SafeFileHandle job, IntPtr process);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetInformationJobObject(SafeFileHandle job, int kind, ref ExtendedLimits information, uint bytes);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool QueryInformationJobObject(SafeFileHandle job, int kind, out Accounting information, uint bytes, out uint returnedBytes);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool QueryInformationJobObject(SafeFileHandle job, int kind, IntPtr information, uint bytes, out uint returnedBytes);
}
