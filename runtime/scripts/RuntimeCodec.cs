#nullable enable
using System;
using System.IO;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Companion.Runtime;

public static class RuntimeCodec
{
    public static byte[] Execute(string root, string target, string input, string inputSha256, string controlPath, string controlSha256, bool verifyOnly, bool preview = false)
    {
        var destination = NativeFiles.AdmitWithin(root, target, true);
        if (destination.IsDirectory || destination.Missing.Length > 1)
        {
            throw new IOException("Codec target is inadmissible.");
        }

        target = destination.Path;
        var frozen = ReadStaged(root, target, input, inputSha256, "state-event");
        var controlBytes = ReadStaged(root, target, controlPath, controlSha256, "config");
        if (string.Equals(input, controlPath, StringComparison.OrdinalIgnoreCase))
        {
            throw new IOException("Codec source and control must be distinct.");
        }

        using var control = JsonDocument.Parse(controlBytes);
        var request = control.RootElement;
        EventDocuments.Fields(request, ["mode", "metadata", "compact", "expectedSequence", "createOnly", "binding"]);
        var mode = EventDocuments.Text(request.GetProperty("mode"));
        var compact = EventDocuments.Boolean(request.GetProperty("compact"));
        var createOnly = EventDocuments.Boolean(request.GetProperty("createOnly"));
        var expectedSequence = EventDocuments.Integer(request.GetProperty("expectedSequence"), 0, EventDocuments.MaximumSequence);
        var metadata = request.GetProperty("metadata");
        var mutation = mode is "create" or "rewrite" or "reconstruct";
        var binding = request.GetProperty("binding");
        if (mode == "reconstruct" ? binding.ValueKind != JsonValueKind.String : binding.ValueKind != JsonValueKind.Null)
        {
            throw new DocumentInvalidException("Codec binding request is invalid.");
        }

        if (!mutation && (metadata.ValueKind != JsonValueKind.Null || compact || createOnly || preview) || mode is not ("source" or "create" or "reconstruct") && expectedSequence != 0)
        {
            throw new DocumentInvalidException("Codec request contains inapplicable options.");
        }

        byte[] result;
        if (mode is "source" or "create" or "reconstruct")
        {
            using var source = JsonDocument.Parse(frozen);
            EventDocuments.ValidateOutbox(source.RootElement, expectedSequence);
            result = mode switch
            {
                "source" => frozen,
                "create" => PayloadCodec.CreateEvent(frozen, System.Text.Encoding.UTF8.GetBytes(metadata.GetRawText())),
                _ => PayloadCodec.ReconstructEvent(frozen, System.Text.Encoding.UTF8.GetBytes(metadata.GetRawText()), EventDocuments.Hex(binding, 64)),
            };
        }
        else if (mode is "event" or "rewrite")
        {
            _ = PayloadCodec.Verify(frozen);
            result = mode == "event" ? frozen : PayloadCodec.RewriteEvent(frozen, System.Text.Encoding.UTF8.GetBytes(metadata.GetRawText()), compact);
        }
        else
        {
            throw new DocumentInvalidException("Codec operation is unsupported.");
        }

        if (mutation)
        {
            PayloadCodec.ValidateFinalizationBudget(result);
        }

        var resultHash = Hash(result);
        var description = Describe(result, mode == "source");
        // Bound the entire response before publication, so a large control projection
        // cannot mutate authority and then fail the supervisor's control stream cap.
        var preliminary = Reply(resultHash, description, false, false);
        if (preliminary.Length > 65000)
        {
            throw new DocumentInvalidException("Codec metadata exceeds its control-stream budget.");
        }

        var matches = false;
        var cleanupComplete = true;
        if (mutation && !verifyOnly && !preview)
        {
            var publication = RuntimeFilePublication.PublishFrozen(root, target, result, "state-event", createOnly);
            cleanupComplete = publication.RetainedSiblings.Length == 0;
        }

        if (mutation && !preview)
        {
            var observed = NativeFiles.AdmitWithin(root, target, true);
            if (observed.Exists)
            {
                if (observed.IsDirectory)
                {
                    throw new IOException("Codec target became a directory.");
                }

                var actual = JsonDocuments.ReadBounded(observed.Path, JsonDocuments.Budget("state-event").Bytes);
                matches = actual.AsSpan().SequenceEqual(result);
            }
        }

        return Reply(resultHash, description, mutation && matches, cleanupComplete);
    }

    private static byte[] ReadStaged(string root, string target, string input, string expectedHash, string profile)
    {
        var source = NativeFiles.AdmitWithin(root, input, false);
        if (source.IsDirectory || !EventDocuments.IsHex(expectedHash, 64)
            || !string.Equals(Path.GetDirectoryName(source.Path), Path.GetDirectoryName(target), StringComparison.OrdinalIgnoreCase)
            || !Regex.IsMatch(Path.GetFileName(source.Path), @"\A" + Regex.Escape(Path.GetFileName(target)) + @"\.[a-f0-9]{32}\.tmp\z", RegexOptions.CultureInvariant))
        {
            throw new IOException("Codec input is not an admitted owned sibling.");
        }

        var bytes = JsonDocuments.ReadBounded(source.Path, JsonDocuments.Budget(profile).Bytes);
        if (!string.Equals(Hash(bytes), expectedHash, StringComparison.Ordinal))
        {
            throw new IOException("Codec input changed before its frozen read.");
        }

        JsonDocuments.Validate(bytes, profile);

        return bytes;
    }

    private static byte[] Describe(byte[] bytes, bool source)
    {
        using var document = JsonDocument.Parse(bytes);
        var root = document.RootElement;
        using var output = new MemoryStream();
        using (var writer = new Utf8JsonWriter(output))
        {
            writer.WriteStartObject();
            foreach (var field in source
                ? new[] { "stateEventVersion", "logicalOutboxId", "incarnationId", "sequence", "kind", "createdAt", "principal", "repairOperationId", "adapterVersion", "game" }
                : [.. EventDocuments.MetadataFields, "payloadBindingSha256"])
            {
                writer.WritePropertyName(field);
                writer.WriteRawValue(root.GetProperty(field).GetRawText(), false);
            }

            var hasState = source || !root.GetProperty("compacted").GetBoolean();
            var state = hasState ? (source ? root : root.GetProperty("payload")).GetProperty("state") : default;
            if (source)
            {
                writer.WriteNumber("schemaVersion", EventDocuments.Integer(state.GetProperty("schemaVersion")));
            }

            writer.WriteString("targetIdentitySha256", hasState ? TargetHash(state) : null);
            writer.WriteString("stateGeneratedAt", hasState ? state.GetProperty("generatedAt").GetString() : null);
            writer.WriteEndObject();
        }

        return output.ToArray();
    }

    public static byte[] InspectFrozen(byte[] bytes, bool source, long expectedSequence = 0)
    {
        JsonDocuments.Validate(bytes, "state-event");
        if (source)
        {
            using var document = JsonDocument.Parse(bytes);
            EventDocuments.ValidateOutbox(document.RootElement, expectedSequence);
        }
        else
        {
            _ = PayloadCodec.Verify(bytes);
        }

        return Describe(bytes, source);
    }

    public static string TargetHash(JsonElement state)
    {
        using var output = new MemoryStream();
        using (var writer = new Utf8JsonWriter(output))
        {
            writer.WriteStartObject();
            writer.WriteString("generatedAt", state.GetProperty("generatedAt").GetString());
            var source = state.GetProperty("source");
            foreach (var field in new[] { "domainId", "saveFile", "savedAt", "contentSha256" })
            {
                writer.WriteString(field, source.GetProperty(field).GetString());
            }

            writer.WriteNumber("byteLength", EventDocuments.Integer(source.GetProperty("byteLength"), 1));
            writer.WriteEndObject();
        }

        return Hash(output.ToArray());
    }

    private static byte[] Reply(string sha256, byte[] description, bool published, bool cleanupComplete)
    {
        using var output = new MemoryStream();
        using (var writer = new Utf8JsonWriter(output))
        {
            writer.WriteStartObject();
            writer.WriteNumber("codecVersion", 1);
            writer.WriteString("sha256", sha256);
            writer.WriteBoolean("published", published);
            writer.WriteBoolean("cleanupComplete", cleanupComplete);
            writer.WritePropertyName("metadata");
            writer.WriteRawValue(description, false);
            writer.WriteEndObject();
        }

        return output.ToArray();
    }

    private static string Hash(byte[] bytes)
    {
        return Convert.ToHexStringLower(SHA256.HashData(bytes));
    }
}
