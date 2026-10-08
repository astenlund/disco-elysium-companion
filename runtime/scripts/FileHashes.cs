#nullable enable
using System;
using System.Diagnostics;
using System.IO;
using System.Security.Cryptography;
using System.Text.Json;

namespace Companion.Runtime;

// Hashes identify exact bytes only. They never admit payload or control semantics.
public static class FileHashes
{
    public static byte[] Read(string root, Stream input)
    {

        return Read(root, input, null);
    }

    public static byte[] Read(string root, Stream input, string? scopeSha256)
    {
        var started = Stopwatch.GetTimestamp();
        var request = JsonDocuments.ReadBounded(input, JsonDocuments.Budget("config").Bytes);
        JsonDocuments.Validate(request, "config");
        using var document = JsonDocument.Parse(request);
        if (document.RootElement.ValueKind != JsonValueKind.Array || document.RootElement.GetArrayLength() is < 1 or > 512)
        {
            throw new IOException("File observation batch is invalid.");
        }

        if (scopeSha256 is not null && (scopeSha256.Length != 64 || !System.Text.RegularExpressions.Regex.IsMatch(scopeSha256, "^[0-9a-f]{64}$")))
        {
            throw new IOException("Immutable scope hash is invalid.");
        }

        var scopePath = Path.Combine(root, "scope.json");
        if (scopeSha256 is not null && Observe(root, scopePath, started) != scopeSha256)
        {
            throw new IOException("Immutable scope authority changed.");
        }

        using var output = new MemoryStream();
        using (var writer = new Utf8JsonWriter(output))
        {
            writer.WriteStartObject();
            writer.WriteString("requestSha256", Convert.ToHexStringLower(SHA256.HashData(request)));
            writer.WriteStartArray("sha256");
            foreach (var target in document.RootElement.EnumerateArray())
            {
                if (target.ValueKind != JsonValueKind.String || string.IsNullOrEmpty(target.GetString()))
                {
                    throw new IOException("File observation target is invalid.");
                }

                writer.WriteStringValue(Observe(root, target.GetString()!, started));
            }

            writer.WriteEndArray();
            writer.WriteEndObject();
        }

        if (scopeSha256 is not null && Observe(root, scopePath, started) != scopeSha256)
        {
            throw new IOException("Immutable scope authority changed during observation.");
        }

        if (output.Length > 65536 || Stopwatch.GetElapsedTime(started).TotalMilliseconds >= 30000)
        {
            throw new IOException("File observation exceeds its control budget or deadline.");
        }

        return output.ToArray();
    }

    private static string? Observe(string root, string path, long started)
    {
        var admitted = NativeFiles.AdmitWithin(root, path, true);
        if (admitted.IsDirectory)
        {
            throw new IOException("File observation target is not a file.");
        }

        var remaining = 30000 - (int)Math.Ceiling(Stopwatch.GetElapsedTime(started).TotalMilliseconds);
        if (remaining <= 0)
        {
            throw new IOException("File observation exceeded its deadline.");
        }

        if (!admitted.Exists)
        {

            return null;
        }

        var sha256 = JsonDocuments.ObserveRaw(admitted.Path, remaining).Sha256;
        var current = NativeFiles.AdmitWithin(root, admitted.Path, false);
        if (current.IsDirectory || current.Volume != admitted.Volume || current.Identity != admitted.Identity)
        {
            throw new IOException("File observation changed its physical identity.");
        }

        return sha256;
    }
}
