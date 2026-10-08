#nullable enable
using System;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Companion.Runtime;

public static class PayloadCodec
{
    private static readonly UTF8Encoding Utf8 = new(false, true);

    // Pending records reserve their later acceptance and acknowledgement controls.
    // The payload's raw token text remains unchanged while measuring that state.
    public static void ValidateFinalizationBudget(byte[] bytes)
    {
        _ = Verify(bytes);
        using var document = JsonDocument.Parse(bytes);
        var root = document.RootElement;
        using var output = new MemoryStream();
        using (var writer = new Utf8JsonWriter(output))
        {
            writer.WriteStartObject();
            foreach (var property in root.EnumerateObject())
            {
                writer.WritePropertyName(property.Name);
                if (property.Name == "acknowledgedAt" && property.Value.ValueKind == JsonValueKind.Null)
                {
                    writer.WriteStringValue("9999-12-31T23:59:59.9999999Z");
                }
                else if (property.Name == "acceptance" && property.Value.ValueKind == JsonValueKind.Null)
                {
                    writer.WriteStartObject();
                    writer.WriteString("journalId", root.GetProperty("journalId").GetString());
                    writer.WriteString("eventId", root.GetProperty("eventId").GetString());
                    writer.WriteString("generation", new string('f', 32));
                    writer.WriteEndObject();
                }
                else if (property.Name == "settlement")
                {
                    writer.WriteStringValue("accepted");
                }
                else
                {
                    writer.WriteRawValue(property.Value.GetRawText(), false);
                }
            }

            writer.WriteEndObject();
        }

        JsonDocuments.Validate(output.ToArray(), "state-event");
    }

    public static byte[] CreateEvent(byte[] frozenSource, byte[] metadata)
    {
        JsonDocuments.Validate(frozenSource, "state-event");
        using var source = JsonDocument.Parse(frozenSource);
        EventDocuments.ValidateOutbox(source.RootElement);
        JsonDocuments.Validate(metadata, "state-event");
        using var control = JsonDocument.Parse(metadata);
        EventDocuments.ValidateMetadata(control.RootElement);
        EventDocuments.CorrelateSource(source.RootElement, control.RootElement);
        var sourceHash = Convert.ToHexStringLower(SHA256.HashData(frozenSource));
        using var payloadBuffer = new MemoryStream();
        using (var writer = new Utf8JsonWriter(payloadBuffer))
        {
            writer.WriteStartObject();
            foreach (var field in EventDocuments.PayloadFields)
            {
                writer.WritePropertyName(field);
                writer.WriteRawValue(source.RootElement.GetProperty(field).GetRawText(), false);
            }

            writer.WriteEndObject();
        }

        var payload = payloadBuffer.ToArray();

        return WriteEvent(metadata, sourceHash, Binding(sourceHash, payload), payload, false);
    }

    public static string Verify(byte[] eventBytes)
    {
        JsonDocuments.Validate(eventBytes, "state-event");
        using var document = JsonDocument.Parse(eventBytes);
        var root = document.RootElement;
        EventDocuments.ValidateMetadata(root, true);
        var sourceHash = ReadHash(root.GetProperty("recordSha256"));
        var binding = ReadHash(root.GetProperty("payloadBindingSha256"));
        if (!root.GetProperty("compacted").GetBoolean())
        {
            var payload = root.GetProperty("payload");
            if (!string.Equals(Binding(sourceHash, Utf8.GetBytes(payload.GetRawText())), binding, StringComparison.Ordinal))
            {
                throw new DocumentInvalidException("Retained payload no longer matches its source binding.");
            }
        }

        return binding;
    }

    public static byte[] RewriteEvent(byte[] eventBytes, byte[] metadata, bool compact)
    {
        var binding = Verify(eventBytes);
        using var document = JsonDocument.Parse(eventBytes);
        var root = document.RootElement;
        JsonDocuments.Validate(metadata, "state-event");
        using var control = JsonDocument.Parse(metadata);
        EventDocuments.ValidateMetadata(control.RootElement);
        EventDocuments.CorrelateRewrite(root, control.RootElement);
        var wasCompacted = root.GetProperty("compacted").GetBoolean();
        if (wasCompacted && !compact)
        {
            throw new DocumentInvalidException("Compact evidence cannot restore a payload.");
        }

        var payload = compact ? null : Utf8.GetBytes(root.GetProperty("payload").GetRawText());

        return WriteEvent(metadata, ReadHash(root.GetProperty("recordSha256")), binding, payload, compact);
    }

    public static byte[] ReconstructEvent(byte[] frozenSource, byte[] metadata, string expectedBinding)
    {
        JsonDocuments.Validate(metadata, "state-event");
        using var document = JsonDocument.Parse(metadata);
        EventDocuments.ValidateMetadata(document.RootElement);
        if (document.RootElement.GetProperty("compacted").GetBoolean())
        {
            throw new DocumentInvalidException("Recovery requires a complete payload.");
        }

        using var initial = new MemoryStream();
        using (var writer = new Utf8JsonWriter(initial))
        {
            writer.WriteStartObject();
            foreach (var field in EventDocuments.MetadataFields)
            {
                writer.WritePropertyName(field);
                if (field is "acceptance" or "acknowledgedAt")
                {
                    writer.WriteNullValue();
                }
                else if (field == "settlement")
                {
                    writer.WriteStringValue("pending");
                }
                else
                {
                    writer.WriteRawValue(document.RootElement.GetProperty(field).GetRawText(), false);
                }
            }

            writer.WriteEndObject();
        }

        var created = CreateEvent(frozenSource, initial.ToArray());
        if (!string.Equals(Verify(created), expectedBinding, StringComparison.Ordinal))
        {
            throw new DocumentInvalidException("Recovered source does not match the retained original binding.");
        }

        return RewriteEvent(created, metadata, false);
    }

    public static string Binding(string sourceHash, byte[] payload)
    {
        if (!EventDocuments.IsHex(sourceHash, 64))
        {
            throw new DocumentInvalidException("Source hash is invalid.");
        }

        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        hash.AppendData(Utf8.GetBytes("companion-core-payload-v1\n"));
        hash.AppendData(Encoding.ASCII.GetBytes(sourceHash));
        hash.AppendData([10]);
        hash.AppendData(payload);

        return Convert.ToHexStringLower(hash.GetHashAndReset());
    }

    private static byte[] WriteEvent(byte[] metadata, string sourceHash, string binding, byte[]? payload, bool compact)
    {
        JsonDocuments.Validate(metadata, "state-event");
        using var document = JsonDocument.Parse(metadata);
        var root = document.RootElement;
        EventDocuments.ValidateMetadata(root);
        if (!string.Equals(ReadHash(root.GetProperty("recordSha256")), sourceHash, StringComparison.Ordinal) || root.GetProperty("compacted").ValueKind != (compact ? JsonValueKind.True : JsonValueKind.False))
        {
            throw new DocumentInvalidException("A metadata rewrite cannot change source binding or payload availability.");
        }

        using var output = new MemoryStream();
        using (var writer = new Utf8JsonWriter(output))
        {
            writer.WriteStartObject();
            foreach (var field in EventDocuments.MetadataFields)
            {
                writer.WritePropertyName(field);
                writer.WriteRawValue(root.GetProperty(field).GetRawText(), false);
            }

            writer.WriteString("payloadBindingSha256", binding);
            if (payload is not null)
            {
                writer.WritePropertyName("payload");
                writer.WriteRawValue(Utf8.GetString(payload), false);
            }

            writer.WriteEndObject();
        }

        var result = output.ToArray();
        _ = Verify(result);

        return result;
    }

    private static string ReadHash(JsonElement value)
    {
        return EventDocuments.Hex(value, 64);
    }
}
