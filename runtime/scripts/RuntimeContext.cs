#nullable enable
using System;
using System.Collections.Generic;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Companion.Runtime;

public static class RuntimeContext
{
    private const int MaximumReplyBytes = 65536;
    private sealed record Reference(long Sequence, string Sha256, bool Redelivery);
    private sealed record Candidate(int Shape, ContextRendering Value, ContextRedeliveryRendering Redelivery, string Sha256, string RedeliverySha256);
    private static readonly string[] RequestFields = ["contextRequestVersion", "scopeSha256", "safetySha256", "generation", "journalId", "game", "principal", "template", "events", "state", "stateWanted", "shape", "failedBlockBytes", "instructionsSha256", "providerFingerprint", "disclosure"];

    public static byte[] Execute(string root, string inputPath, string inputSha256, string mode)
    {
        if (mode is not ("Preview" or "Publish" or "Verify"))
        {
            throw new DocumentInvalidException("Context request mode is invalid.");
        }

        var input = NativeFiles.AdmitWithin(root, inputPath, false);
        if (input.IsDirectory || !string.Equals(Path.GetDirectoryName(input.Path), NativeFiles.NormalizePath(root), StringComparison.OrdinalIgnoreCase)
            || !Regex.IsMatch(Path.GetFileName(input.Path), @"\Aprepared-context\.txt\.[a-f0-9]{32}\.tmp\z", RegexOptions.CultureInvariant))
        {
            throw new IOException("Context request is not an owned prepared-context sibling.");
        }

        var bytes = ReadExact(root, input.Path, inputSha256, "state-event");
        using var request = JsonDocument.Parse(bytes);
        var value = request.RootElement;
        EventDocuments.Fields(value, RequestFields);
        EventDocuments.Require(EventDocuments.Integer(value.GetProperty("contextRequestVersion")) == 1);
        var scopeHash = EventDocuments.Hex(value.GetProperty("scopeSha256"), 64);
        var safetyHash = EventDocuments.Hex(value.GetProperty("safetySha256"), 64);
        var generation = EventDocuments.Hex(value.GetProperty("generation"), 32);
        var game = EventDocuments.Token(value.GetProperty("game"));
        var principal = EventDocuments.Token(value.GetProperty("principal"));
        var disclosure = EventDocuments.Boolean(value.GetProperty("disclosure"));
        var stateWanted = EventDocuments.Boolean(value.GetProperty("stateWanted"));
        var instructions = EventDocuments.Hex(value.GetProperty("instructionsSha256"), 64);
        var provider = EventDocuments.Hex(value.GetProperty("providerFingerprint"), 64);
        int? shape = value.GetProperty("shape").ValueKind == JsonValueKind.Null ? null : (int)EventDocuments.Integer(value.GetProperty("shape"), 1, 4);
        int? failedBytes = value.GetProperty("failedBlockBytes").ValueKind == JsonValueKind.Null ? null : (int)EventDocuments.Integer(value.GetProperty("failedBlockBytes"), 1, ContextCodec.MaximumBlockBytes);
        EventDocuments.Require(mode == "Preview" || shape is not null);
        var journalId = value.GetProperty("journalId").ValueKind == JsonValueKind.Null ? null : EventDocuments.Token(value.GetProperty("journalId"));
        EventDocuments.Require(disclosure || journalId is not null);
        using var scope = JsonDocument.Parse(ReadExact(root, Path.Combine(root, "scope.json"), scopeHash, "config"));
        EventDocuments.Fields(scope.RootElement, ["runtimeScopeVersion", "game", "principal"]);
        EventDocuments.Require(EventDocuments.Integer(scope.RootElement.GetProperty("runtimeScopeVersion")) == 1 && scope.RootElement.GetProperty("game").GetString() == game && scope.RootElement.GetProperty("principal").GetString() == principal);
        using var safety = JsonDocument.Parse(ReadExact(root, Path.Combine(root, "state-safety.json"), safetyHash, "config"));
        // The controller must reconcile protected operation obligations before this
        // call. These exact-byte fences are not a replacement for that full proof.
        EventDocuments.Require(safety.RootElement.GetProperty("generation").GetString() == generation && safety.RootElement.GetProperty("pendingCheck").ValueKind == JsonValueKind.Null);
        var correction = safety.RootElement.GetProperty("correction");
        var presentedCorrection = value.GetProperty("template").GetProperty("correction");
        if (correction.ValueKind == JsonValueKind.Null)
        {
            EventDocuments.Require(presentedCorrection.ValueKind == JsonValueKind.Null);
        }
        else
        {
            EventDocuments.Fields(presentedCorrection, ["correctionId", "reason"]);
            EventDocuments.Require(presentedCorrection.GetProperty("correctionId").GetString() == correction.GetProperty("correctionId").GetString()
                && presentedCorrection.GetProperty("reason").GetString() == correction.GetProperty("reason").GetString());
        }

        var template = Encoding.UTF8.GetBytes(value.GetProperty("template").GetRawText());
        var references = new List<Reference>();
        var events = value.GetProperty("events");
        EventDocuments.Require(events.ValueKind == JsonValueKind.Array && events.GetArrayLength() <= ContextCodec.MaximumEvents);
        long previous = 0;
        foreach (var entry in events.EnumerateArray())
        {
            EventDocuments.Fields(entry, ["sequence", "sha256", "redelivery"]);
            var reference = ParseReference(entry, EventDocuments.Boolean(entry.GetProperty("redelivery")));
            EventDocuments.Require(reference.Sequence > previous);
            previous = reference.Sequence;
            references.Add(reference);
        }

        Reference? stateReference = null;
        var stateValue = value.GetProperty("state");
        if (stateValue.ValueKind != JsonValueKind.Null)
        {
            EventDocuments.Fields(stateValue, ["sequence", "sha256"]);
            stateReference = ParseReference(stateValue, false);
            foreach (var reference in references)
            {
                EventDocuments.Require(reference.Sequence != stateReference.Sequence || reference.Sha256 == stateReference.Sha256);
            }
        }

        EventDocuments.Require(!disclosure || references.Count == 0 && stateReference is null && (shape is null or 1));
        var cache = new Dictionary<long, VerifiedContextRecord>();
        VerifiedContextRecord Load(Reference reference)
        {
            if (!cache.TryGetValue(reference.Sequence, out var record))
            {
                var file = Path.Combine(root, "journal", "events", reference.Sequence.ToString("D16", System.Globalization.CultureInfo.InvariantCulture) + ".json");
                record = VerifiedContextRecord.FromFrozen(ReadExact(root, file, reference.Sha256, "state-event"), reference.Sha256, generation,
                    stateReference is not null && reference.Sequence == stateReference.Sequence);
                EventDocuments.Require(record.Sequence == reference.Sequence && record.JournalId == journalId && record.Game == game && record.Principal == principal);
                cache.Add(reference.Sequence, record);
            }

            return record;
        }

        IEnumerable<ContextEventSelection> Selections()
        {
            foreach (var reference in references)
            {
                yield return new(Load(reference), reference.Redelivery);
            }
        }

        var state = stateReference is null ? null : Load(stateReference);
        var candidates = new List<Candidate>();
        foreach (var candidateShape in shape is null ? new[] { 1, 2, 3, 4 } : [shape.Value])
        {
            if (disclosure && candidateShape != 1)
            {
                continue;
            }

            var rendered = disclosure
                ? ContextCodec.Render(template, [], null, generation, null, false, false, instructions, provider)
                : ContextSelection.Select(candidateShape, template, Selections(), state, stateWanted, generation, instructions, provider, failedBytes);
            if (rendered is not null)
            {
                var redelivery = ContextCodec.Redeliver(rendered, instructions, provider);
                candidates.Add(new(candidateShape, rendered, redelivery, Hash(rendered.Bytes), Hash(redelivery.Bytes)));
            }
        }

        var offsets = ContextCodec.PackRedeliveryOffsets(candidates.ConvertAll(candidate => candidate.Redelivery));
        // False is the longer JSON Boolean. Prove the largest result before publication.
        _ = CreateReply(inputSha256, candidates, offsets, false, false);
        var published = false;
        var cleanupComplete = true;
        if (mode != "Preview" && candidates.Count == 1)
        {
            var rendered = candidates[0].Value;
            var target = NativeFiles.AdmitWithin(root, Path.Combine(root, "prepared-context.txt"), true);
            if (mode == "Verify")
            {
                published = target.Exists && !target.IsDirectory && JsonDocuments.ReadBounded(target.Path, ContextCodec.MaximumBlockBytes).AsSpan().SequenceEqual(rendered.Bytes);
                cleanupComplete = false;
            }
            else
            {
                var result = RuntimeFilePublication.PublishPreparedContext(root, rendered.Bytes);
                published = result.Sha256 == Hash(rendered.Bytes);
                cleanupComplete = result.RetainedSiblings.Length == 0;
            }
        }

        return CreateReply(inputSha256, candidates, offsets, published, cleanupComplete);
    }

    private static byte[] CreateReply(string inputSha256, IReadOnlyList<Candidate> candidates, ContextRedeliveryOffsets offsets, bool published, bool cleanupComplete)
    {
        using var output = new MemoryStream();
        using (var writer = new Utf8JsonWriter(output))
        {
            writer.WriteStartObject();
            writer.WriteNumber("contextResultVersion", 1);
            writer.WriteString("requestSha256", inputSha256);
            writer.WriteBoolean("published", published);
            writer.WriteBoolean("cleanupComplete", cleanupComplete);
            writer.WriteBase64String("redeliveryOffsets", Convert.FromBase64String(offsets.Encoded));
            writer.WriteStartArray("candidates");
            for (var index = 0; index < candidates.Count; index++)
            {
                var candidate = candidates[index];
                var rendered = candidate.Value;
                writer.WriteStartObject();
                writer.WriteNumber("shape", candidate.Shape);
                writer.WriteString("sha256", candidate.Sha256);
                writer.WriteString("fingerprint", rendered.Fingerprint);
                writer.WriteNumber("bytes", rendered.Bytes.Length);
                writer.WriteNumber("eventCount", rendered.EventCount);
                writer.WriteBoolean("stateIncluded", rendered.StateIncluded);
                writer.WriteString("degraded", rendered.Degraded);
                writer.WriteString("redeliverySha256", candidate.RedeliverySha256);
                writer.WriteNumber("redeliveryBytes", candidate.Redelivery.Bytes.Length);
                writer.WriteNumber("redeliveryChanges", candidate.Redelivery.Offsets.Length);
                writer.WriteNumber("redeliveryOffsetDelta", offsets.Deltas[index]);
                writer.WriteEndObject();
            }

            writer.WriteEndArray();
            writer.WriteEndObject();
        }

        EventDocuments.Require(output.Length <= MaximumReplyBytes);

        return output.ToArray();
    }

    private static Reference ParseReference(JsonElement value, bool redelivery)
    {

        return new(EventDocuments.Integer(value.GetProperty("sequence"), 1, EventDocuments.MaximumSequence), EventDocuments.Hex(value.GetProperty("sha256"), 64), redelivery);
    }

    private static byte[] ReadExact(string root, string path, string expectedHash, string profile)
    {
        var admitted = NativeFiles.AdmitWithin(root, path, false);
        if (admitted.IsDirectory || !EventDocuments.IsHex(expectedHash, 64))
        {
            throw new IOException("Context source is not an exact owned file.");
        }

        var bytes = JsonDocuments.ReadBounded(admitted.Path, JsonDocuments.Budget(profile).Bytes);
        if (Hash(bytes) != expectedHash)
        {
            throw new IOException("Context dependency changed.");
        }

        JsonDocuments.Validate(bytes, profile);

        return bytes;
    }

    private static string Hash(byte[] bytes)
    {

        return Convert.ToHexStringLower(SHA256.HashData(bytes));
    }
}
