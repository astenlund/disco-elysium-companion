#nullable enable
using System;
using System.ComponentModel;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;

using Microsoft.Win32.SafeHandles;

namespace Companion.Runtime;

public static class NativeImagePins
{
    private const uint ReadAttributes = 0x80;
    private const uint GenericRead = 0x80000000;
    private const uint ShareRead = 1;
    private const uint OpenExisting = 3;
    private const uint OpenReparsePoint = 0x00200000;
    private const uint BackupSemantics = 0x02000000;
    private const uint ProcessDuplicateHandle = 0x40;
    private const uint ProcessQueryLimitedInformation = 0x1000;
    private const uint DuplicateCloseSource = 1;
    private const uint DuplicateSameAccess = 2;

    public static SafeFileHandle OpenHeld(string path, bool directory)
    {
        var normalized = NativeFiles.NormalizePath(path);
        var admitted = NativeFiles.Admit(normalized, false);
        if (admitted.IsDirectory != directory || !directory && admitted.Links != 1)
        {
            throw new IOException("Image pin kind or link count is invalid.");
        }

        var prefix = new string((char)92, 2) + "?" + (char)92;
        var access = directory ? ReadAttributes : GenericRead;
        var flags = directory ? OpenReparsePoint | BackupSemantics : OpenReparsePoint;
        var handle = CreateFileW(prefix + normalized, access, ShareRead, IntPtr.Zero, OpenExisting, flags, IntPtr.Zero);
        if (handle.IsInvalid)
        {
            var error = Marshal.GetLastWin32Error();
            handle.Dispose();
            throw new Win32Exception(error);
        }

        try
        {
            var held = NativeFiles.DescribeHeld(handle, normalized);
            if (held.IsDirectory != directory || !directory && held.Links != 1
                || !string.Equals(held.Path, admitted.Path, StringComparison.Ordinal)
                || held.Volume != admitted.Volume || held.Identity != admitted.Identity)
            {
                throw new IOException("Image pin changed between admission and handle opening.");
            }

            return handle;
        }
        catch
        {
            handle.Dispose();
            throw;
        }
    }

    public static string HashHeld(SafeFileHandle handle, long maximumBytes)
    {
        ArgumentNullException.ThrowIfNull(handle);
        if (handle.IsInvalid)
        {
            throw new IOException("Pinned image handle is invalid.");
        }

        if (maximumBytes <= 0)
        {
            throw new ArgumentOutOfRangeException(nameof(maximumBytes));
        }

        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        var buffer = new byte[65536];
        long offset = 0;
        while (true)
        {
            var count = RandomAccess.Read(handle, buffer, offset);
            if (count == 0)
            {
                break;
            }

            offset = checked(offset + count);
            if (offset > maximumBytes)
            {
                throw new IOException("Pinned image exceeds its byte bound.");
            }

            hash.AppendData(buffer, 0, count);
        }

        return Convert.ToHexStringLower(hash.GetHashAndReset());
    }

    public static SafeFileHandle OpenTargetProcess(int processId, string expectedCreated)
    {
        ArgumentNullException.ThrowIfNull(expectedCreated);
        if (processId <= 0 || expectedCreated.Length is < 1 or > 19
            || expectedCreated[0] == '0' || !ulong.TryParse(expectedCreated, NumberStyles.None, CultureInfo.InvariantCulture, out var expected))
        {
            throw new ArgumentException("Target process identity is invalid.");
        }

        var target = OpenProcess(ProcessDuplicateHandle | ProcessQueryLimitedInformation, false, checked((uint)processId));
        if (target.IsInvalid)
        {
            var error = Marshal.GetLastWin32Error();
            target.Dispose();
            throw new Win32Exception(error);
        }

        try
        {
            if (!GetProcessTimes(target, out var created, out _, out _, out _))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }

            var observed = (ulong)(uint)created.dwLowDateTime | (ulong)(uint)created.dwHighDateTime << 32;
            if (observed != expected)
            {
                throw new IOException("Target process creation identity changed.");
            }

            return target;
        }
        catch
        {
            target.Dispose();
            throw;
        }
    }

    public static ulong DuplicateInto(SafeFileHandle source, SafeFileHandle target)
    {
        ArgumentNullException.ThrowIfNull(source);
        ArgumentNullException.ThrowIfNull(target);
        if (source.IsInvalid || target.IsInvalid)
        {
            throw new IOException("Image pin source or target handle is invalid.");
        }

        var sourceAdded = false;
        var targetAdded = false;
        var remote = IntPtr.Zero;
        try
        {
            source.DangerousAddRef(ref sourceAdded);
            target.DangerousAddRef(ref targetAdded);
            if (!DuplicateHandle(GetCurrentProcess(), source.DangerousGetHandle(),
                target.DangerousGetHandle(), out remote, 0, false, DuplicateSameAccess))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
        }
        finally
        {
            if (targetAdded) { target.DangerousRelease(); }
            if (sourceAdded) { source.DangerousRelease(); }
        }

        if (remote == IntPtr.Zero)
        {
            throw new IOException("Remote image pin handle is invalid.");
        }

        return unchecked((ulong)remote.ToInt64());
    }

    public static SafeFileHandle DuplicateBack(SafeFileHandle target, ulong remote)
    {
        ArgumentNullException.ThrowIfNull(target);
        if (target.IsInvalid || remote == 0)
        {
            throw new IOException("Remote image pin handle is invalid.");
        }

        var targetAdded = false;
        var local = IntPtr.Zero;
        try
        {
            target.DangerousAddRef(ref targetAdded);
            if (!DuplicateHandle(target.DangerousGetHandle(), new IntPtr(unchecked((long)remote)),
                GetCurrentProcess(), out local, 0, false, DuplicateSameAccess))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
        }
        finally
        {
            if (targetAdded) { target.DangerousRelease(); }
        }

        if (local == IntPtr.Zero)
        {
            throw new IOException("Returned image pin handle is invalid.");
        }

        return new SafeFileHandle(local, true);
    }

    public static void CloseRemote(SafeFileHandle target, ulong remote)
    {
        ArgumentNullException.ThrowIfNull(target);
        if (target.IsInvalid || remote == 0)
        {
            throw new IOException("Remote image pin handle is invalid.");
        }

        var targetAdded = false;
        try
        {
            target.DangerousAddRef(ref targetAdded);
            if (!DuplicateHandle(target.DangerousGetHandle(), new IntPtr(unchecked((long)remote)),
                IntPtr.Zero, out _, 0, false, DuplicateCloseSource))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
        }
        finally
        {
            if (targetAdded) { target.DangerousRelease(); }
        }
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, ExactSpelling = true)]
    private static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern SafeFileHandle OpenProcess(uint access, [MarshalAs(UnmanagedType.Bool)] bool inherit, uint processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetProcessTimes(SafeFileHandle handle, out System.Runtime.InteropServices.ComTypes.FILETIME created,
        out System.Runtime.InteropServices.ComTypes.FILETIME exited, out System.Runtime.InteropServices.ComTypes.FILETIME kernel,
        out System.Runtime.InteropServices.ComTypes.FILETIME user);

    [DllImport("kernel32.dll")]
    private static extern IntPtr GetCurrentProcess();

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool DuplicateHandle(IntPtr sourceProcess, IntPtr sourceHandle, IntPtr targetProcess,
        out IntPtr targetHandle, uint desiredAccess, [MarshalAs(UnmanagedType.Bool)] bool inherit, uint options);

}
