#nullable enable
using System;
using System.Buffers.Binary;
using System.Collections.Generic;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Companion.Runtime;

public sealed class VerifiedContextRecord
{
    private VerifiedContextRecord(JsonElement root, string generation, bool includeState)
    {
        var payload = root.GetProperty("payload");
        Generation = generation;
        JournalId = root.GetProperty("journalId").GetString()!;
        Game = root.GetProperty("adapter").GetString()!;
        Principal = root.GetProperty("principal").GetString()!;
        EventId = root.GetProperty("eventId").GetString()!;
        Sequence = EventDocuments.Integer(root.GetProperty("sequence"));
        Type = root.GetProperty("type").GetString()!;
        BaselineReset = payload.GetProperty("baselineReset").GetBoolean();
        Warnings = payload.GetProperty("warnings").GetRawText();
        Diff = payload.GetProperty("diff").GetRawText();
        State = includeState ? payload.GetProperty("state").GetRawText() : null;
    }

    public string Generation { get; }
    public string JournalId { get; }
    public string Game { get; }
    public string Principal { get; }
    public string EventId { get; }
    public long Sequence { get; }
    public string Type { get; }
    public bool BaselineReset { get; }
    internal string Warnings { get; }
    internal string Diff { get; }
    internal string? State { get; }

    public static VerifiedContextRecord FromFrozen(byte[] bytes, string expectedSha256, string generation, bool includeState = true)
    {
        if (!EventDocuments.IsHex(expectedSha256, 64) || !EventDocuments.IsHex(generation, 32) || Convert.ToHexStringLower(SHA256.HashData(bytes)) != expectedSha256)
        {
            throw new DocumentInvalidException("Context record bytes do not match their verified identity.");
        }

        _ = PayloadCodec.Verify(bytes);
        using var document = JsonDocument.Parse(bytes);
        var root = document.RootElement;
        var acceptance = root.GetProperty("acceptance");
        if (root.GetProperty("compacted").GetBoolean() || acceptance.ValueKind != JsonValueKind.Object || acceptance.GetProperty("generation").GetString() != generation)
        {
            throw new DocumentInvalidException("Context record has no current full-payload acceptance.");
        }

        return new(root, generation, includeState);
    }
}

public sealed record ContextEventSelection(VerifiedContextRecord Record, bool Redelivery);
public sealed record ContextRendering(byte[] Bytes, string Fingerprint, int EventCount, bool StateIncluded, string? Degraded);
public sealed record ContextRedeliveryRendering(byte[] Bytes, uint[] Offsets);
public sealed record ContextRedeliveryOffsets(string Encoded, int[] Deltas);

public static class ContextCodec
{
    public const int MaximumBlockBytes = 4194304;
    public const int MaximumEvents = 8192;
    private static readonly byte[] Opening = Encoding.ASCII.GetBytes("<companion-turn-context>");
    private static readonly byte[] Closing = Encoding.ASCII.GetBytes("</companion-turn-context>");
    private static readonly string[] TemplateFields = ["companionTurnContextVersion", "interactionId", "requestReceivedAt", "sessionOpening", "freshness", "operational", "correction"];

    // A null result means only that the exact tagged bytes exceed the requested cap.
    // Format, integrity and generation failures remain errors, never size evidence.
    public static ContextRendering? Render(byte[] templateBytes, IReadOnlyList<ContextEventSelection> events, VerifiedContextRecord? state, string generation, string? degraded,
        bool omitDiff, bool omitWarnings, string instructionsSha256, string providerFingerprint, int maximumBytes = MaximumBlockBytes)
    {
        if (maximumBytes is < 1 or > MaximumBlockBytes || !EventDocuments.IsHex(generation, 32) || degraded is not (null or "eventTooLarge" or "stateTooLarge")
            || (omitDiff || omitWarnings) && events.Count > 1 || omitWarnings && !omitDiff || omitDiff && degraded is null)
        {
            throw new DocumentInvalidException("Context rendering options are invalid.");
        }

        JsonDocuments.Validate(templateBytes, "state-event");
        using var template = JsonDocument.Parse(templateBytes);
        ValidateTemplate(template.RootElement);
        var identities = new HashSet<string>(StringComparer.Ordinal);
        long previous = 0;
        foreach (var selection in events)
        {
            if (selection.Record.Generation != generation || selection.Record.Sequence <= previous || !identities.Add(selection.Record.EventId))
            {
                throw new DocumentInvalidException("Context events are unordered, duplicated or from another generation.");
            }

            previous = selection.Record.Sequence;
        }

        if (state is not null && state.Generation != generation)
        {
            throw new DocumentInvalidException("Context state belongs to another generation.");
        }

        if (state is not null && state.State is null)
        {
            throw new DocumentInvalidException("Context state was not retained for the selected record.");
        }

        using var output = new MemoryStream();
        using (var writer = new Utf8JsonWriter(output))
        {
            writer.WriteStartObject();
            foreach (var field in TemplateFields)
            {
                writer.WritePropertyName(field);
                writer.WriteRawValue(template.RootElement.GetProperty(field).GetRawText(), false);
            }

            writer.WriteString("degraded", degraded);
            writer.WriteStartArray("events");
            foreach (var selection in events)
            {
                WriteEvent(writer, selection, omitDiff, omitWarnings);
                writer.Flush();
                if (output.Length + Opening.Length + Closing.Length > maximumBytes)
                {

                    return null;
                }
            }

            writer.WriteEndArray();
            writer.WritePropertyName("state");
            writer.WriteRawValue(state?.State ?? "null", false);
            writer.WriteEndObject();
        }

        if (output.Length + Opening.Length + Closing.Length > maximumBytes)
        {

            return null;
        }

        var json = output.ToArray();
        var fingerprint = ContextFingerprint.Compute(json, instructionsSha256, providerFingerprint);
        using var block = new MemoryStream(Opening.Length + json.Length + Closing.Length);
        block.Write(Opening);
        block.Write(json);
        block.Write(Closing);

        return new(block.ToArray(), fingerprint, events.Count, state is not null, degraded);
    }

    public static ContextRedeliveryRendering Redeliver(ContextRendering rendered, string instructionsSha256, string providerFingerprint)
    {
        var bytes = rendered.Bytes;
        if (bytes.Length > MaximumBlockBytes || !bytes.AsSpan().StartsWith(Opening) || !bytes.AsSpan().EndsWith(Closing))
        {
            throw new DocumentInvalidException("Redelivery requires a complete bounded context block.");
        }

        var reader = new Utf8JsonReader(bytes.AsSpan(Opening.Length, bytes.Length - Opening.Length - Closing.Length));
        var offsets = new List<uint>();
        var foundEvents = false;
        var inEvents = false;
        var hasRedelivery = false;
        var eventCount = 0;
        while (reader.Read())
        {
            if (!inEvents)
            {
                if (reader.TokenType == JsonTokenType.PropertyName && reader.CurrentDepth == 1 && reader.ValueTextEquals("events"))
                {
                    EventDocuments.Require(!foundEvents && reader.Read() && reader.TokenType == JsonTokenType.StartArray);
                    foundEvents = true;
                    inEvents = true;
                }

                continue;
            }

            if (reader.TokenType == JsonTokenType.EndArray && reader.CurrentDepth == 1)
            {
                inEvents = false;
            }
            else if (reader.TokenType == JsonTokenType.StartObject && reader.CurrentDepth == 2)
            {
                eventCount++;
                EventDocuments.Require(eventCount <= MaximumEvents);
                hasRedelivery = false;
            }
            else if (reader.TokenType == JsonTokenType.PropertyName && reader.CurrentDepth == 3 && reader.ValueTextEquals("redelivery"))
            {
                EventDocuments.Require(!hasRedelivery && reader.Read() && reader.TokenType is JsonTokenType.True or JsonTokenType.False);
                hasRedelivery = true;
                if (reader.TokenType == JsonTokenType.False)
                {
                    offsets.Add(checked((uint)(Opening.Length + reader.TokenStartIndex)));
                }
            }
            else if (reader.TokenType == JsonTokenType.EndObject && reader.CurrentDepth == 2)
            {
                EventDocuments.Require(hasRedelivery);
            }
        }

        EventDocuments.Require(foundEvents && !inEvents && eventCount == rendered.EventCount);
        if (offsets.Count == 0)
        {

            return new(bytes, []);
        }

        var redelivery = new byte[bytes.Length - offsets.Count];
        var sourceAt = 0;
        var destinationAt = 0;
        foreach (var offset in offsets)
        {
            var count = checked((int)offset) - sourceAt;
            bytes.AsSpan(sourceAt, count).CopyTo(redelivery.AsSpan(destinationAt));
            destinationAt += count;
            "true"u8.CopyTo(redelivery.AsSpan(destinationAt));
            destinationAt += 4;
            sourceAt = checked((int)offset) + 5;
        }

        bytes.AsSpan(sourceAt).CopyTo(redelivery.AsSpan(destinationAt));
        var json = redelivery.AsSpan(Opening.Length, redelivery.Length - Opening.Length - Closing.Length).ToArray();
        EventDocuments.Require(ContextFingerprint.Compute(json, instructionsSha256, providerFingerprint) == rendered.Fingerprint);

        return new(redelivery, offsets.ToArray());
    }

    public static ContextRedeliveryOffsets PackRedeliveryOffsets(IReadOnlyList<ContextRedeliveryRendering> candidates)
    {
        uint[] common = [];
        foreach (var candidate in candidates)
        {
            EventDocuments.Require(candidate.Offsets.Length <= MaximumEvents);
            if (candidate.Offsets.Length > common.Length)
            {
                common = candidate.Offsets;
            }
        }

        var deltas = new int[candidates.Count];
        for (var candidateIndex = 0; candidateIndex < candidates.Count; candidateIndex++)
        {
            var offsets = candidates[candidateIndex].Offsets;
            var delta = offsets.Length == 0 ? 0 : checked((int)offsets[0] - (int)common[0]);
            for (var index = 0; index < offsets.Length; index++)
            {
                EventDocuments.Require(offsets[index] <= MaximumBlockBytes - 5 && (index == 0 || offsets[index] >= offsets[index - 1] + 5)
                    && (long)common[index] + delta == offsets[index]);
            }

            deltas[candidateIndex] = delta;
        }

        var packed = new byte[common.Length * sizeof(uint)];
        for (var index = 0; index < common.Length; index++)
        {
            BinaryPrimitives.WriteUInt32LittleEndian(packed.AsSpan(index * sizeof(uint), sizeof(uint)), common[index]);
        }

        return new(Convert.ToBase64String(packed), deltas);
    }

    internal static long EventBytes(ContextEventSelection selection)
    {
        using var output = new MemoryStream();
        using (var writer = new Utf8JsonWriter(output))
        {
            WriteEvent(writer, selection, false, false);
        }

        return output.Length;
    }

    private static void WriteEvent(Utf8JsonWriter writer, ContextEventSelection selection, bool omitDiff, bool omitWarnings)
    {
        var record = selection.Record;
        writer.WriteStartObject();
        writer.WriteString("eventId", record.EventId);
        writer.WriteNumber("sequence", record.Sequence);
        writer.WriteString("type", record.Type);
        writer.WriteBoolean("redelivery", selection.Redelivery);
        writer.WriteBoolean("baselineReset", record.BaselineReset);
        writer.WritePropertyName("warnings");
        writer.WriteRawValue(omitWarnings ? "[]" : record.Warnings, false);
        writer.WritePropertyName("diff");
        writer.WriteRawValue(omitDiff ? "null" : record.Diff, false);
        writer.WriteEndObject();
    }

    private static void ValidateTemplate(JsonElement root)
    {
        EventDocuments.Fields(root, TemplateFields);
        EventDocuments.Require(EventDocuments.Integer(root.GetProperty("companionTurnContextVersion")) == 1);
        _ = EventDocuments.Token(root.GetProperty("interactionId"));
        _ = EventDocuments.Utc(root.GetProperty("requestReceivedAt"));
        _ = EventDocuments.Boolean(root.GetProperty("sessionOpening"));
        var freshness = root.GetProperty("freshness");
        EventDocuments.Fields(freshness, ["state", "class", "reason", "lastGoodGeneratedAt"]);
        var fresh = EventDocuments.Choice(freshness.GetProperty("state"), "fresh", "failed") == "fresh";
        foreach (var field in new[] { "class", "reason" })
        {
            var value = freshness.GetProperty(field);
            EventDocuments.Require(fresh ? value.ValueKind == JsonValueKind.Null : value.ValueKind == JsonValueKind.String && value.GetString()!.Length > 0);
        }

        var generated = freshness.GetProperty("lastGoodGeneratedAt");
        if (generated.ValueKind != JsonValueKind.Null)
        {
            _ = EventDocuments.Utc(generated);
        }

        var operational = root.GetProperty("operational");
        EventDocuments.Fields(operational, ["state", "warnings"]);
        _ = EventDocuments.Choice(operational.GetProperty("state"), "current", "unknown");
        EventDocuments.Require(operational.GetProperty("warnings").ValueKind == JsonValueKind.Array);
        foreach (var warning in operational.GetProperty("warnings").EnumerateArray())
        {
            EventDocuments.Fields(warning, ["code", "detail"]);
            _ = EventDocuments.Text(warning.GetProperty("code"));
            EventDocuments.Require(warning.GetProperty("detail").ValueKind is JsonValueKind.String or JsonValueKind.Null);
        }

        var correction = root.GetProperty("correction");
        if (correction.ValueKind != JsonValueKind.Null)
        {
            EventDocuments.Fields(correction, ["correctionId", "reason"]);
            _ = EventDocuments.Hex(correction.GetProperty("correctionId"), 32);
            _ = EventDocuments.Choice(correction.GetProperty("reason"), "coreRejected", "contextUncertain");
        }
    }
}
