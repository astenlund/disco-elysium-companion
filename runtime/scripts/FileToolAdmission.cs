#nullable enable
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text.Json;

namespace Companion.Runtime;

public static class FileToolAdmission
{
    private const int MaximumEntries = 8192;
    private const int MaximumDescendantDepth = 64;
    private const int MaximumMilliseconds = 5000;

    public static byte[] Inspect(string companionRoot, string target, string tool)
    {
        var clock = Stopwatch.StartNew();
        var root = NativeFiles.Admit(companionRoot, false);
        if (!root.IsDirectory || tool is not ("Read" or "Edit" or "Write" or "Grep" or "Glob"))
        {
            throw new IOException("File-tool root or kind is unavailable.");
        }

        var write = tool is "Edit" or "Write";
        var destination = NativeFiles.AdmitWithin(root.Path, target, tool == "Write");
        if (Excluded(root.Path, destination.Path) || !destination.Exists && destination.Missing.Length != 1)
        {
            throw new IOException("File-tool destination is unavailable.");
        }

        if (write)
        {
            var memory = NativeFiles.AdmitWithin(root.Path, Path.Combine(root.Path, "memory"), false);
            if (!memory.IsDirectory || destination.IsDirectory)
            {
                throw new IOException("File-tool write area is unavailable.");
            }

            _ = NativeFiles.AdmitWithin(memory.Path, destination.Path, tool == "Write");
        }

        if (tool == "Read" && destination.IsDirectory || tool == "Glob" && !destination.IsDirectory
            || tool is "Grep" or "Glob" && destination.Path.Equals(root.Path, StringComparison.OrdinalIgnoreCase))
        {
            throw new IOException("File-tool target has an unsupported role.");
        }

        var seen = new HashSet<string>(StringComparer.Ordinal);
        var count = 0;
        using var output = new MemoryStream();
        using (var writer = new Utf8JsonWriter(output))
        {
            writer.WriteStartObject();
            writer.WriteString("root", root.Path);
            writer.WriteString("target", destination.Path);
            writer.WriteBoolean("missingLeaf", !destination.Exists);
            writer.WriteStartArray("entries");

            void Retain(PathAdmission admission)
            {
                if (!seen.Add(admission.Path))
                {
                    return;
                }

                if (++count > MaximumEntries || clock.ElapsedMilliseconds >= MaximumMilliseconds)
                {
                    throw new IOException("File-tool admission bound exceeded.");
                }

                writer.WriteStartObject();
                writer.WriteString("path", admission.Path);
                writer.WriteBoolean("exists", admission.Exists);
                writer.WriteString("kind", admission.Exists ? admission.IsDirectory ? "directory" : "file" : null);
                writer.WriteString("volume", admission.Exists ? admission.Volume : null);
                writer.WriteString("identity", admission.Exists ? admission.Identity : null);
                if (admission.Exists)
                {
                    writer.WriteNumber("links", admission.Links);
                }
                else
                {
                    writer.WriteNull("links");
                }

                writer.WriteEndObject();
                writer.Flush();
                if (output.Length > 65000)
                {
                    throw new IOException("File-tool metadata exceeds its control stream.");
                }
            }

            Retain(root);
            var relative = Path.GetRelativePath(root.Path, destination.Path);
            var current = root.Path;
            if (relative != ".")
            {
                foreach (var component in relative.Split(Path.DirectorySeparatorChar))
                {
                    current = Path.Combine(current, component);
                    Retain(NativeFiles.AdmitWithin(root.Path, current, tool == "Write"));
                }
            }

            if (destination.IsDirectory)
            {
                var directories = new Stack<(string Path, int Depth)>();
                directories.Push((destination.Path, 0));
                while (directories.Count > 0)
                {
                    var directory = directories.Pop();
                    foreach (var candidate in Directory.EnumerateFileSystemEntries(directory.Path))
                    {
                        if (clock.ElapsedMilliseconds >= MaximumMilliseconds || count >= MaximumEntries || Excluded(root.Path, candidate))
                        {
                            throw new IOException("File-tool traversal cannot be admitted completely.");
                        }

                        var admission = NativeFiles.AdmitWithin(root.Path, candidate, false);
                        Retain(admission);
                        if (admission.IsDirectory)
                        {
                            var depth = directory.Depth + 1;
                            if (depth > MaximumDescendantDepth)
                            {
                                throw new IOException("File-tool traversal is too deep.");
                            }

                            directories.Push((admission.Path, depth));
                        }
                    }
                }
            }

            writer.WriteEndArray();
            writer.WriteNumber("inspected", count);
            writer.WriteEndObject();
        }

        if (clock.ElapsedMilliseconds >= MaximumMilliseconds)
        {
            throw new IOException("File-tool admission timed out.");
        }

        var bytes = output.ToArray();
        JsonDocuments.Validate(bytes, "config");

        return bytes;
    }

    private static bool Excluded(string root, string candidate)
    {
        var relative = Path.GetRelativePath(root, candidate);
        var first = relative.Split(Path.DirectorySeparatorChar)[0];

        return first.Equals("state", StringComparison.OrdinalIgnoreCase) || first.Equals("runtime-data", StringComparison.OrdinalIgnoreCase) || first.Equals(".tmp", StringComparison.OrdinalIgnoreCase);
    }
}
