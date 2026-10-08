#nullable enable
using System;
using System.IO;

namespace Companion.Runtime;

public static class FileActions
{
    private static PathAdmission Exact(string root, string path, string sha256)
    {
        var source = NativeFiles.AdmitWithin(root, path, false);
        if (source.IsDirectory || !EventDocuments.IsHex(sha256, 64))
        {
            throw new IOException("Owned file action has invalid source authority.");
        }

        var observation = JsonDocuments.ObserveRaw(source.Path);
        var current = NativeFiles.AdmitWithin(root, source.Path, false);
        if (current.IsDirectory || current.Volume != source.Volume || current.Identity != source.Identity || !string.Equals(observation.Sha256, sha256, StringComparison.Ordinal))
        {
            throw new IOException("Owned file action source changed.");
        }

        return source;
    }

    public static void Move(string root, string sourcePath, string targetPath, string sha256)
    {
        var source = Exact(root, sourcePath, sha256);
        var target = NativeFiles.AdmitWithin(root, targetPath, true);
        if (target.Exists || target.Missing.Length != 1 || !string.Equals(Path.GetPathRoot(source.Path), Path.GetPathRoot(target.Path), StringComparison.OrdinalIgnoreCase))
        {
            throw new IOException("Owned move destination is unavailable.");
        }

        File.Move(source.Path, target.Path, false);
        _ = Exact(root, target.Path, sha256);
        if (NativeFiles.AdmitWithin(root, source.Path, true).Exists)
        {
            throw new IOException("Owned move source remains after publication.");
        }
    }

    public static void Remove(string root, string path, string sha256)
    {
        var source = Exact(root, path, sha256);
        File.Delete(source.Path);
        if (NativeFiles.AdmitWithin(root, source.Path, true).Exists)
        {
            throw new IOException("Owned removal cannot be verified.");
        }
    }
}
