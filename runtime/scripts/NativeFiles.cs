#nullable enable
using System;
using System.ComponentModel;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using Microsoft.Win32.SafeHandles;

namespace Companion.Runtime;

public sealed record PathAdmission(string Path, bool Exists, bool IsDirectory, uint Links, string Volume, string Identity, string[] Missing);

public static class NativeFiles
{
    private const uint ReadAttributes = 0x80;
    private const uint ShareReadWriteDelete = 7;
    private const uint OpenExisting = 3;
    private const uint OpenReparsePoint = 0x00200000;
    private const uint BackupSemantics = 0x02000000;
    private const uint DirectoryAttribute = 0x10;
    private const uint ReparseAttribute = 0x400;
    private const uint DiskFileType = 1;
    private const int FileIdInfoClass = 18;
    private const int MaximumComponents = 64;
    private const int MaximumPathCharacters = 32760;
    private static readonly UTF8Encoding StrictUtf8 = new(false, true);
    private static readonly Regex ReservedName = new(@"^(CON|PRN|AUX|NUL|COM[1-9\u00b9\u00b2\u00b3]|LPT[1-9\u00b9\u00b2\u00b3])(?:\.|$)", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

    public static string NormalizePath(string candidate)
    {
        ArgumentNullException.ThrowIfNull(candidate);
        _ = StrictUtf8.GetByteCount(candidate);
        var normalized = candidate.Replace('/', '\\');
        if (normalized.Length < 3 || normalized.Length > MaximumPathCharacters || !char.IsAsciiLetter(normalized[0]) || normalized[1] != ':' || normalized[2] != '\\')
        {
            throw new IOException("A local drive-qualified path is required.");
        }

        normalized = normalized.Length == 3 ? normalized : normalized.TrimEnd('\\');
        var components = normalized[3..].Split('\\', StringSplitOptions.None);
        if (normalized.Length > 3 && (components.Length > MaximumComponents || Array.Exists(components, InvalidComponent)))
        {
            throw new IOException("Ambiguous or unsupported path spelling.");
        }

        return System.IO.Path.GetFullPath(normalized);
    }

    public static PathAdmission AdmitWithin(string root, string candidate, bool allowMissing)
    {
        var admittedRoot = Admit(root, false);
        if (!admittedRoot.IsDirectory)
        {
            throw new IOException("Admission root must be a directory.");
        }

        var full = NormalizePath(candidate);
        var rootPath = NormalizePath(root);
        var prefix = rootPath.EndsWith('\\') ? rootPath : rootPath + '\\';
        if (!string.Equals(full, rootPath, StringComparison.OrdinalIgnoreCase) && !full.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
        {
            throw new IOException("Path is outside its admitted root.");
        }

        // Textual containment alone is insufficient in a case-sensitive Windows directory.
        var actualRoot = Admit(full[..rootPath.Length], false);
        if (actualRoot.Volume != admittedRoot.Volume || actualRoot.Identity != admittedRoot.Identity)
        {
            throw new IOException("Path names a different root object.");
        }

        return Admit(full, allowMissing);
    }

    public static PathAdmission Admit(string candidate, bool allowMissing)
    {
        var full = NormalizePath(candidate);
        var current = full[..3];
        var metadata = Inspect(current) ?? throw new DirectoryNotFoundException("Drive root is unavailable.");
        RequireOrdinary(metadata);
        if (full.Length == 3)
        {
            return metadata;
        }

        var components = full[3..].Split('\\');
        for (var index = 0; index < components.Length; index++)
        {
            if (!metadata.IsDirectory)
            {
                throw new IOException("An ancestor is not a directory.");
            }

            current = System.IO.Path.Combine(current, components[index]);
            var next = Inspect(current);
            if (next is null)
            {
                if (!allowMissing)
                {
                    throw new FileNotFoundException("Required path is absent.");
                }

                return new PathAdmission(full, false, false, 0, string.Empty, string.Empty, components[index..]);
            }

            RequireOrdinary(next);
            metadata = next;
        }

        return metadata;
    }

    private static bool InvalidComponent(string component)
    {
        return component.Length == 0 || component is "." or ".." || component.EndsWith(' ') || component.EndsWith('.') || component.IndexOfAny(System.IO.Path.GetInvalidFileNameChars()) >= 0 || ReservedName.IsMatch(component);
    }

    private static void RequireOrdinary(PathAdmission metadata)
    {
        if (!metadata.IsDirectory && metadata.Links != 1)
        {
            throw new IOException("File link count is not exactly one.");
        }
    }

    private static PathAdmission? Inspect(string path)
    {
        // The admitted drive path gets an internal extended prefix so long paths are not mistaken for absence.
        using var handle = CreateFileW(@"\\?\" + path, ReadAttributes, ShareReadWriteDelete, IntPtr.Zero, OpenExisting, OpenReparsePoint | BackupSemantics, IntPtr.Zero);
        if (handle.IsInvalid)
        {
            var error = Marshal.GetLastWin32Error();
            if (error is 2 or 3)
            {
                return null;
            }

            throw new Win32Exception(error);
        }

        if (GetFileType(handle) != DiskFileType)
        {
            throw new IOException("Object is not an ordinary disk file or directory.");
        }

        if (!GetFileInformationByHandle(handle, out var information))
        {
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }

        if ((information.Attributes & ReparseAttribute) != 0)
        {
            throw new IOException("Reparse objects are not admitted.");
        }

        if (!GetFileInformationByHandleEx(handle, FileIdInfoClass, out var identity, (uint)Marshal.SizeOf<FileIdentity>()))
        {
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }

        if (identity.Low == 0 && identity.High == 0)
        {
            throw new IOException("A reliable file identity is unavailable.");
        }

        var buffer = new StringBuilder(MaximumPathCharacters + 8);
        var length = GetFinalPathNameByHandleW(handle, buffer, (uint)buffer.Capacity, 0);
        if (length == 0)
        {
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }

        if (length >= buffer.Capacity)
        {
            throw new IOException("Canonical path exceeds its bound.");
        }

        var canonical = buffer.ToString();
        if (canonical.StartsWith(@"\\?\", StringComparison.Ordinal))
        {
            canonical = canonical[4..];
        }

        canonical = NormalizePath(canonical);
        if (!string.Equals(canonical, path, StringComparison.OrdinalIgnoreCase))
        {
            throw new IOException("Path spelling does not identify its canonical object.");
        }

        var volume = identity.Volume.ToString("x16", CultureInfo.InvariantCulture);
        var fileId = identity.Low.ToString("x16", CultureInfo.InvariantCulture) + identity.High.ToString("x16", CultureInfo.InvariantCulture);

        return new PathAdmission(canonical, true, (information.Attributes & DirectoryAttribute) != 0, information.Links, volume, fileId, []);
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct FileInformation
    {
        public uint Attributes;
        public System.Runtime.InteropServices.ComTypes.FILETIME Created;
        public System.Runtime.InteropServices.ComTypes.FILETIME Accessed;
        public System.Runtime.InteropServices.ComTypes.FILETIME Written;
        public uint Volume;
        public uint SizeHigh;
        public uint SizeLow;
        public uint Links;
        public uint IndexHigh;
        public uint IndexLow;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct FileIdentity
    {
        public ulong Volume;
        public ulong Low;
        public ulong High;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, ExactSpelling = true)]
    private static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint GetFileType(SafeFileHandle handle);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetFileInformationByHandle(SafeFileHandle handle, out FileInformation information);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetFileInformationByHandleEx(SafeFileHandle handle, int kind, out FileIdentity information, uint bytes);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, ExactSpelling = true)]
    private static extern uint GetFinalPathNameByHandleW(SafeFileHandle handle, StringBuilder name, uint capacity, uint flags);
}
