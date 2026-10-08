#nullable enable
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Companion.Runtime;

public sealed class DocumentInvalidException(string message) : Exception(message)
{
}

public readonly record struct DocumentBudget(int Bytes, long Tokens, long TextBytes);
public readonly record struct RawFileObservation(string Sha256, long Bytes);

public static class JsonDocuments
{
    private static readonly UTF8Encoding StrictUtf8 = new(false, true);

    public static DocumentBudget Budget(string profile)
    {
        return profile switch
        {
            "config" => new(1048576, 65536, 524288),
            "state-event" => new(33554432, 2000000, 16777216),
            _ => throw new ArgumentOutOfRangeException(nameof(profile)),
        };
    }

    public static byte[] ReadBounded(string path, int maximumBytes)
    {
        using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
        if (stream.Length > maximumBytes)
        {
            throw new DocumentInvalidException("Document exceeds its byte budget.");
        }

        return ReadBounded(stream, maximumBytes);
    }

    // Raw evidence is deliberately separate from authoritative JSON admission.
    public static RawFileObservation ObserveRaw(string path, int timeoutMilliseconds = 30000)
    {
        if (timeoutMilliseconds is < 1 or > 30000)
        {
            throw new ArgumentOutOfRangeException(nameof(timeoutMilliseconds));
        }

        var started = Stopwatch.GetTimestamp();
        using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read | FileShare.Delete);
        var length = stream.Length;
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        var buffer = new byte[65536];
        long observed = 0;
        while (true)
        {
            if (Stopwatch.GetElapsedTime(started).TotalMilliseconds >= timeoutMilliseconds)
            {
                throw new IOException("Raw preimage observation exceeded its deadline.");
            }

            var count = stream.Read(buffer);
            observed += count;
            if (observed > length)
            {
                throw new IOException("Raw preimage grew during observation.");
            }

            if (count == 0)
            {
                break;
            }

            hash.AppendData(buffer, 0, count);
        }

        if (observed != length || stream.Length != length || Stopwatch.GetElapsedTime(started).TotalMilliseconds >= timeoutMilliseconds)
        {
            throw new IOException("Raw preimage observation is incomplete.");
        }

        return new(Convert.ToHexStringLower(hash.GetHashAndReset()), observed);
    }

    public static byte[] ReadBounded(Stream stream, int maximumBytes)
    {
        if (maximumBytes < 1 || maximumBytes == int.MaxValue)
        {
            throw new ArgumentOutOfRangeException(nameof(maximumBytes));
        }

        using var output = new MemoryStream(Math.Min(maximumBytes, 65536));
        var buffer = new byte[Math.Min(maximumBytes + 1, 65536)];
        while (true)
        {
            var count = stream.Read(buffer, 0, Math.Min(buffer.Length, maximumBytes - (int)output.Length + 1));
            if (count == 0)
            {
                return output.ToArray();
            }

            if (output.Length + count > maximumBytes)
            {
                throw new DocumentInvalidException("Document exceeds its byte budget.");
            }

            output.Write(buffer, 0, count);
        }
    }

    public static void Validate(byte[] bytes, string profile)
    {
        var budget = Budget(profile);
        if (bytes.Length > budget.Bytes || bytes.Length >= 3 && bytes[0] == 0xef && bytes[1] == 0xbb && bytes[2] == 0xbf)
        {
            throw new DocumentInvalidException("Document byte budget or encoding is invalid.");
        }

        try
        {
            _ = StrictUtf8.GetString(bytes);
            var reader = new Utf8JsonReader(bytes, new JsonReaderOptions { MaxDepth = 64, CommentHandling = JsonCommentHandling.Disallow, AllowTrailingCommas = false });
            var names = new Stack<HashSet<string>>();
            long tokens = 0;
            long textBytes = 0;
            while (reader.Read())
            {
                if (++tokens > budget.Tokens)
                {
                    throw new DocumentInvalidException("Document exceeds its token budget.");
                }

                if (reader.TokenType == JsonTokenType.StartObject)
                {
                    names.Push(new HashSet<string>(StringComparer.Ordinal));
                }
                else if (reader.TokenType == JsonTokenType.EndObject)
                {
                    names.Pop();
                }

                if (reader.TokenType is JsonTokenType.PropertyName or JsonTokenType.String)
                {
                    var value = reader.GetString() ?? throw new DocumentInvalidException("JSON string is unavailable.");
                    textBytes += StrictUtf8.GetByteCount(value);
                    if (textBytes > budget.TextBytes || reader.TokenType == JsonTokenType.PropertyName && !names.Peek().Add(value))
                    {
                        throw new DocumentInvalidException("Document text budget or property uniqueness is invalid.");
                    }
                }
            }

            if (tokens == 0)
            {
                throw new DocumentInvalidException("Document is empty.");
            }
        }
        catch (Exception exception) when (exception is JsonException or DecoderFallbackException or EncoderFallbackException or InvalidOperationException)
        {
            throw new DocumentInvalidException("Document is not strict JSON.");
        }
    }
}
