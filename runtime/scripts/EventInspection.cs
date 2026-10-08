#nullable enable
using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Companion.Runtime;

// Read-only status and inventory use the same verifier as staged publication. An
// unreadable member fails the whole batch, never an absent or clean classification.
public static class EventInspection
{
    private const int MaximumReplyBytes = 65536;
    private const int MaximumBatchRecords = 512;

    public static byte[] Read(string root, string requestsJson, bool source)
    {
        var requestBytes = new UTF8Encoding(false, true).GetBytes(requestsJson);
        if (requestBytes.Length > MaximumReplyBytes)
        {
            throw new DocumentInvalidException("Inspection control exceeds its stream budget.");
        }

        using var requests = Requests(requestBytes, 8);
        var documents = new List<byte[]>();
        foreach (var request in requests.RootElement.EnumerateArray())
        {
            documents.Add(Inspect(root, request, source, long.MaxValue, false, out _)!);
        }

        var reply = Reply(documents, documents.Count);
        if (reply.Length > MaximumReplyBytes)
        {
            throw new DocumentInvalidException("Inspection result exceeds its control-stream budget.");
        }

        return reply;
    }

    public static byte[] ReadBatch(string root, Stream input)
    {
        var budget = JsonDocuments.Budget("config");
        var requestBytes = JsonDocuments.ReadBounded(input, budget.Bytes);
        using var requests = Requests(requestBytes, MaximumBatchRecords);
        var requestSha256 = Convert.ToHexStringLower(SHA256.HashData(requestBytes));
        var documents = new List<byte[]>();
        long expandedBytes = Reply(documents, 0, requestSha256).Length;
        long remainingWork = JsonDocuments.Budget("state-event").Bytes;
        foreach (var request in requests.RootElement.EnumerateArray())
        {
            var document = Inspect(root, request, false, remainingWork, documents.Count > 0, out var observedBytes);
            if (document is null)
            {
                break;
            }

            remainingWork -= observedBytes;
            expandedBytes += document.Length + (documents.Count == 0 ? 0 : 1);
            if (expandedBytes > budget.Bytes)
            {
                break;
            }

            documents.Add(document);
            if (remainingWork <= 0)
            {
                break;
            }
        }

        // Every candidate is a complete ordered prefix. No field is truncated and
        // no partial prefix grants cache authority if the inventory later fails.
        for (var count = documents.Count; count > 0; count /= 2)
        {
            var expanded = Reply(documents, count, requestSha256);
            try
            {
                JsonDocuments.Validate(expanded, "config");
            }
            catch (DocumentInvalidException)
            {
                // Aggregate decoded text or tokens can bind before raw byte size.
                continue;
            }

            using var output = new MemoryStream();
            using (var compressor = new ZLibStream(output, CompressionLevel.Optimal, true))
            {
                compressor.Write(expanded);
            }

            if (output.Length <= MaximumReplyBytes)
            {

                return output.ToArray();
            }
        }

        throw new DocumentInvalidException("One inspection result cannot fit its control budgets.");
    }

    private static JsonDocument Requests(byte[] bytes, int maximumRecords)
    {
        JsonDocuments.Validate(bytes, "config");
        var document = JsonDocument.Parse(bytes);
        try
        {
            var array = document.RootElement;
            if (array.ValueKind != JsonValueKind.Array || array.GetArrayLength() < 1 || array.GetArrayLength() > maximumRecords)
            {
                throw new DocumentInvalidException("Inspection batch is invalid.");
            }

            foreach (var request in array.EnumerateArray())
            {
                EventDocuments.Fields(request, ["path", "sequence"]);
                _ = EventDocuments.Text(request.GetProperty("path"));
                _ = EventDocuments.Integer(request.GetProperty("sequence"), 0, EventDocuments.MaximumSequence);
            }

            return document;
        }
        catch
        {
            document.Dispose();
            throw;
        }
    }

    private static byte[]? Inspect(string root, JsonElement request, bool source, long remainingWork, bool allowPrefix, out long observedBytes)
    {
        observedBytes = 0;
        var path = EventDocuments.Text(request.GetProperty("path"));
        var sequence = EventDocuments.Integer(request.GetProperty("sequence"), 0, EventDocuments.MaximumSequence);
        var admitted = NativeFiles.AdmitWithin(root, path, true);
        if (admitted.IsDirectory)
        {
            throw new IOException("Inspection target is not an ordinary file.");
        }

        // Size selects a work chunk only. Returned authority still requires the
        // complete frozen bytes, full hash, payload verification and path checks.
        if (admitted.Exists && allowPrefix && new FileInfo(admitted.Path).Length > remainingWork)
        {

            return null;
        }

        var status = "absent";
        string? sha256 = null;
        byte[]? description = null;
        if (admitted.Exists)
        {
            try
            {
                var bytes = JsonDocuments.ReadBounded(admitted.Path, JsonDocuments.Budget("state-event").Bytes);
                observedBytes = bytes.Length;
                sha256 = Convert.ToHexStringLower(SHA256.HashData(bytes));
                description = RuntimeCodec.InspectFrozen(bytes, source, sequence);
                if (!source && sequence != 0)
                {
                    using var metadata = JsonDocument.Parse(description);
                    if (EventDocuments.Integer(metadata.RootElement.GetProperty("sequence")) != sequence)
                    {
                        throw new DocumentInvalidException("Event position does not match its filename.");
                    }
                }

                status = "valid";
            }
            catch (DocumentInvalidException)
            {
                // Complete raw evidence permits recovery, never payload admission.
                if (sha256 is null)
                {
                    var raw = JsonDocuments.ObserveRaw(admitted.Path);
                    sha256 = raw.Sha256;
                    observedBytes = raw.Bytes;
                }

                var current = NativeFiles.AdmitWithin(root, admitted.Path, false);
                if (current.IsDirectory || current.Volume != admitted.Volume || current.Identity != admitted.Identity)
                {
                    throw new IOException("Diagnostic preimage changed during observation.");
                }

                status = "invalid";
                description = null;
            }
        }

        using var output = new MemoryStream();
        using (var writer = new Utf8JsonWriter(output))
        {
            writer.WriteStartObject();
            writer.WriteString("path", path);
            writer.WriteString("status", status);
            writer.WriteString("sha256", sha256);
            writer.WritePropertyName("metadata");
            if (description is null)
            {
                writer.WriteNullValue();
            }
            else
            {
                writer.WriteRawValue(description, false);
            }

            writer.WriteEndObject();
        }

        return output.ToArray();
    }

    private static byte[] Reply(IReadOnlyList<byte[]> documents, int count, string? requestSha256 = null)
    {
        using var output = new MemoryStream();
        using (var writer = new Utf8JsonWriter(output))
        {
            writer.WriteStartObject();
            if (requestSha256 is not null)
            {
                writer.WriteString("requestSha256", requestSha256);
            }

            writer.WriteStartArray("documents");
            for (var index = 0; index < count; index++)
            {
                writer.WriteRawValue(documents[index], false);
            }

            writer.WriteEndArray();
            writer.WriteEndObject();
        }

        return output.ToArray();
    }
}
