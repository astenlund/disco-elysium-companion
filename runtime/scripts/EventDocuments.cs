#nullable enable
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Companion.Runtime;

// Only transport metadata and cross-document invariants are interpreted here. Nested
// game values remain producer-validated JSON and never cross a JavaScript number boundary.
public static class EventDocuments
{
    public const long MaximumSequence = 9007199254740991;
    internal static readonly string[] PayloadFields = ["baseline", "sourceFloor", "refresh", "warnings", "baselineReset", "diff", "state"];
    internal static readonly string[] OutboxFields = ["stateEventVersion", "logicalOutboxId", "incarnationId", "sequence", "kind", "createdAt", "principal", "repairOperationId", "adapterVersion", "game", .. PayloadFields];
    internal static readonly string[] MetadataFields = ["eventVersion", "journalId", "sequence", "eventId", "type", "occurredAt", "runtimeInstanceId", "adapter", "adapterBindingEpoch", "principal", "logicalOutboxId", "recordSha256", "coreRepairOperationId", "attemptRef", "schemaVersion", "adapterVersion", "settlement", "acceptance", "acknowledgedAt", "compacted"];
    private static readonly UTF8Encoding Utf8 = new(false, true);
    private static readonly HashSet<string> RecordWarnings = new(StringComparer.Ordinal)
    {
        "pipeline-cache-degraded", "pipeline-bookkeeping-degraded", "pipeline-baseline-unreadable", "pipeline-guard-discarded",
        "pipeline-current-self-healed", "diff-exclude-path-unused", "pipeline-cleanup-degraded", "pipeline-reaper-discovery-limit-exceeded",
    };

    public static void ValidateOutbox(JsonElement root, long expectedSequence = 0)
    {
        Fields(root, OutboxFields);
        Require(Integer(Property(root, "stateEventVersion")) == 1);
        var incarnation = Hex(Property(root, "incarnationId"), 32);
        var sequence = Integer(Property(root, "sequence"), 1, MaximumSequence);
        Require(expectedSequence == 0 || sequence == expectedSequence);
        Require(Text(Property(root, "logicalOutboxId")) == incarnation + "-" + sequence.ToString(CultureInfo.InvariantCulture));
        var kind = Choice(Property(root, "kind"), "consumed", "snapshot", "resync");
        _ = Utc(Property(root, "createdAt"));
        _ = Token(Property(root, "principal"));
        RepairToken(Property(root, "repairOperationId"), kind == "resync");
        var version = Integer(Property(root, "adapterVersion"));
        var game = Text(Property(root, "game"));
        ValidatePayload(root, kind, version, game);
    }

    public static void ValidateMetadata(JsonElement root, bool fullEvent = false)
    {
        var compacted = Boolean(Property(root, "compacted"));
        Fields(root, fullEvent ? compacted ? [.. MetadataFields, "payloadBindingSha256"] : [.. MetadataFields, "payloadBindingSha256", "payload"] : MetadataFields);
        Require(Integer(Property(root, "eventVersion")) == 1);
        _ = Token(Property(root, "journalId"));
        _ = Integer(Property(root, "sequence"), 1, MaximumSequence);
        _ = Hex(Property(root, "eventId"), 32);
        var type = Choice(Property(root, "type"), "state.consumed", "state.snapshot", "state.resync");
        _ = Utc(Property(root, "occurredAt"));
        _ = Hex(Property(root, "runtimeInstanceId"), 32);
        _ = Hex(Property(root, "adapterBindingEpoch"), 32);
        _ = Token(Property(root, "principal"));
        var game = Text(Property(root, "adapter"));
        _ = LogicalSequence(Property(root, "logicalOutboxId"));
        _ = Hex(Property(root, "recordSha256"), 64);
        RepairToken(Property(root, "coreRepairOperationId"), type == "state.resync");
        var association = Property(root, "attemptRef");
        if (association.ValueKind != JsonValueKind.Null)
        {
            Require(type == "state.resync");
            Fields(association, ["operationId", "attemptOrdinal"]);
            var operation = Text(Property(association, "operationId"));
            Require(operation.StartsWith("jr-", StringComparison.Ordinal) && IsHex(operation[3..], 32));
            _ = Integer(Property(association, "attemptOrdinal"), 0, MaximumSequence);
        }

        var schema = Integer(Property(root, "schemaVersion"));
        var adapter = Integer(Property(root, "adapterVersion"));
        var settlement = Choice(Property(root, "settlement"), "pending", "accepted", "unknown");
        var acceptance = Property(root, "acceptance");
        if (acceptance.ValueKind != JsonValueKind.Null)
        {
            Fields(acceptance, ["journalId", "eventId", "generation"]);
            _ = Token(Property(acceptance, "journalId"));
            _ = Token(Property(acceptance, "eventId"));
            _ = Hex(Property(acceptance, "generation"), 32);
        }

        Require(settlement != "accepted" || acceptance.ValueKind != JsonValueKind.Null);
        var acknowledged = Property(root, "acknowledgedAt");
        if (acknowledged.ValueKind != JsonValueKind.Null)
        {
            _ = Utc(acknowledged);
        }

        if (fullEvent)
        {
            _ = Hex(Property(root, "payloadBindingSha256"), 64);
            if (!compacted)
            {
                var payload = Property(root, "payload");
                Fields(payload, PayloadFields);
                ValidatePayload(payload, type[6..], adapter, game);
                Require(Integer(Property(Property(payload, "state"), "schemaVersion")) == schema);
            }
        }
    }

    public static void CorrelateSource(JsonElement source, JsonElement metadata)
    {
        Require(Text(Property(metadata, "logicalOutboxId")) == Text(Property(source, "logicalOutboxId")));
        Require(Text(Property(metadata, "type")) == "state." + Text(Property(source, "kind")));
        Require(Text(Property(metadata, "principal")) == Text(Property(source, "principal")));
        Require(Text(Property(metadata, "adapter")) == Text(Property(source, "game")));
        Require(JsonElement.DeepEquals(Property(metadata, "coreRepairOperationId"), Property(source, "repairOperationId")));
        Require(Integer(Property(metadata, "adapterVersion")) == Integer(Property(source, "adapterVersion")));
        Require(Integer(Property(metadata, "schemaVersion")) == Integer(Property(Property(source, "state"), "schemaVersion")));
        Require(Property(metadata, "settlement").GetString() == "pending" && Property(metadata, "acceptance").ValueKind == JsonValueKind.Null);
        Require(Property(metadata, "acknowledgedAt").ValueKind == JsonValueKind.Null && !Boolean(Property(metadata, "compacted")));
    }

    public static void CorrelateRewrite(JsonElement original, JsonElement metadata)
    {
        foreach (var field in new[] { "type", "principal", "adapter", "logicalOutboxId", "recordSha256", "coreRepairOperationId", "schemaVersion", "adapterVersion" })
        {
            Require(JsonElement.DeepEquals(Property(original, field), Property(metadata, field)));
        }

        var reference = Property(original, "attemptRef");
        Require(reference.ValueKind == JsonValueKind.Null || JsonElement.DeepEquals(reference, Property(metadata, "attemptRef")));
        var acceptance = Property(original, "acceptance");
        if (acceptance.ValueKind != JsonValueKind.Null)
        {
            var next = Property(metadata, "acceptance");
            Require(next.ValueKind == JsonValueKind.Object);
            foreach (var field in new[] { "journalId", "eventId" })
            {
                Require(JsonElement.DeepEquals(Property(acceptance, field), Property(next, field)));
            }
        }
    }

    internal static void ValidatePayload(JsonElement root, string kind, long adapterVersion, string game)
    {
        var baseline = Property(root, "baseline");
        if (baseline.ValueKind != JsonValueKind.Null)
        {
            Fields(baseline, ["generatedAt", "source"]);
            _ = Utc(Property(baseline, "generatedAt"));
            Source(Property(baseline, "source"), true);
        }

        var floor = Property(root, "sourceFloor");
        Source(floor, false);
        var refresh = Property(root, "refresh");
        Fields(refresh, ["attempted", "commitObserved", "attempts"]);
        var attempts = Integer(Property(refresh, "attempts"), 0, 3);
        var attempted = Boolean(Property(refresh, "attempted"));
        Require(attempted == (attempts > 0) && (!Boolean(Property(refresh, "commitObserved")) || attempted));
        Warnings(Property(root, "warnings"));
        var reset = Boolean(Property(root, "baselineReset"));
        var state = Property(root, "state");
        var diff = Property(root, "diff");
        var source = Property(state, "source");
        Source(source, true);
        Source(Property(diff, "currentSource"), true);
        Require(JsonElement.DeepEquals(source, Property(diff, "currentSource")));
        var generated = Utc(Property(state, "generatedAt"));
        Require(Utc(Property(diff, "currentGeneratedAt")) == generated);
        Require(Integer(Property(state, "schemaVersion")) == Integer(Property(diff, "schemaVersion")));
        Require(Integer(Property(state, "adapterVersion")) == adapterVersion && Integer(Property(diff, "adapterVersion")) == adapterVersion);
        Require(Text(Property(state, "game")) == game && Text(Property(diff, "game")) == game);
        Require(Text(Property(floor, "domainId")) == Text(Property(source, "domainId")));
        var timeOrder = string.CompareOrdinal(Utc(Property(source, "savedAt")), Utc(Property(floor, "savedAt")));
        Require(timeOrder > 0 || timeOrder == 0 && string.CompareOrdinal(Text(Property(source, "saveFile")), Text(Property(floor, "saveFile"))) >= 0);
        var diffBaseline = Property(diff, "baselineGeneratedAt");
        Require(reset == (baseline.ValueKind == JsonValueKind.Null) && reset == (diffBaseline.ValueKind == JsonValueKind.Null));
        var targetEqualsBaseline = false;
        if (baseline.ValueKind != JsonValueKind.Null)
        {
            var baselineTime = Utc(Property(baseline, "generatedAt"));
            Require(Utc(diffBaseline) == baselineTime);
            targetEqualsBaseline = baselineTime == generated && JsonElement.DeepEquals(Property(baseline, "source"), source);
        }

        Require(kind != "consumed" || !targetEqualsBaseline);
        Require(kind != "snapshot" || targetEqualsBaseline && !reset && EmptyDiff(diff));
        Require(kind != "resync" || reset && EmptyDiff(diff));
    }

    internal static void Fields(JsonElement value, string[] fields)
    {
        Require(value.ValueKind == JsonValueKind.Object && value.EnumerateObject().Count() == fields.Length && fields.All(field => value.TryGetProperty(field, out _)));
    }

    internal static JsonElement Property(JsonElement value, string field)
    {
        if (value.ValueKind != JsonValueKind.Object || !value.TryGetProperty(field, out var property))
        {
            throw new DocumentInvalidException("Required document member is absent.");
        }

        return property;
    }

    internal static string Text(JsonElement value)
    {
        Require(value.ValueKind == JsonValueKind.String);
        var text = value.GetString();
        Require(!string.IsNullOrEmpty(text));

        return text!;
    }

    internal static long Integer(JsonElement value, long minimum = long.MinValue, long maximum = long.MaxValue)
    {
        if (value.ValueKind != JsonValueKind.Number || !value.TryGetInt64(out var number) || !Regex.IsMatch(value.GetRawText(), @"\A-?(0|[1-9][0-9]*)\z", RegexOptions.CultureInvariant) || number < minimum || number > maximum)
        {
            throw new DocumentInvalidException("Document integer is invalid.");
        }

        return number;
    }

    internal static bool Boolean(JsonElement value)
    {
        Require(value.ValueKind is JsonValueKind.True or JsonValueKind.False);

        return value.GetBoolean();
    }

    internal static string Hex(JsonElement value, int length)
    {
        var text = Text(value);
        Require(IsHex(text, length));

        return text;
    }

    internal static bool IsHex(string value, int length)
    {
        return value.Length == length && value.All(character => character is >= '0' and <= '9' or >= 'a' and <= 'f');
    }

    internal static string Token(JsonElement value)
    {
        var text = Text(value);
        Require(text.IsNormalized(NormalizationForm.FormC) && Utf8.GetByteCount(text) <= 512);
        var count = 0;
        foreach (var rune in text.EnumerateRunes())
        {
            Require(rune.Value > 31 && rune.Value is not (>= 128 and <= 159));
            count++;
        }

        Require(count <= 128);

        return text;
    }

    internal static string Utc(JsonElement value)
    {
        var text = Text(value);
        Require(DateTime.TryParseExact(text, "o", CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out var parsed) && parsed.Kind == DateTimeKind.Utc && parsed.ToString("o", CultureInfo.InvariantCulture) == text);

        return text;
    }

    internal static long LogicalSequence(JsonElement value)
    {
        var text = Text(value);
        Require(text.Length >= 34 && text[32] == '-' && IsHex(text[..32], 32));
        var suffix = text[33..];
        Require(long.TryParse(suffix, NumberStyles.None, CultureInfo.InvariantCulture, out var sequence) && sequence > 0 && sequence <= MaximumSequence && sequence.ToString(CultureInfo.InvariantCulture) == suffix);

        return sequence;
    }

    private static void Source(JsonElement value, bool full)
    {
        Fields(value, full ? ["domainId", "saveFile", "savedAt", "byteLength", "contentSha256"] : ["domainId", "saveFile", "savedAt"]);
        _ = Hex(Property(value, "domainId"), 64);
        var name = Text(Property(value, "saveFile"));
        Require(name.IndexOfAny(['/', (char)92]) < 0);
        _ = Utc(Property(value, "savedAt"));
        if (full)
        {
            _ = Integer(Property(value, "byteLength"), 1);
            _ = Hex(Property(value, "contentSha256"), 64);
        }
    }

    private static void RepairToken(JsonElement value, bool resync)
    {
        if (resync)
        {
            _ = Token(value);
        }
        else
        {
            Require(value.ValueKind == JsonValueKind.Null);
        }
    }

    internal static string Choice(JsonElement value, params string[] choices)
    {
        var text = Text(value);
        Require(choices.Contains(text, StringComparer.Ordinal));

        return text;
    }

    private static void Warnings(JsonElement value)
    {
        Require(value.ValueKind == JsonValueKind.Array);
        string? previous = null;
        foreach (var warning in value.EnumerateArray())
        {
            Fields(warning, ["code", "detail"]);
            var code = Text(Property(warning, "code"));
            var detailValue = Property(warning, "detail");
            var detail = detailValue.ValueKind == JsonValueKind.Null ? null : Text(detailValue);
            Require(RecordWarnings.Contains(code));
            Require(code switch
            {
                "pipeline-reaper-discovery-limit-exceeded" => detail is "tmp" or "state",
                "diff-exclude-path-unused" => detail?.StartsWith("/", StringComparison.Ordinal) == true,
                _ => detail is null,
            });
            var key = code + (char)0 + detail;
            Require(previous is null || string.CompareOrdinal(previous, key) < 0);
            previous = key;
        }
    }

    private static bool EmptyDiff(JsonElement value)
    {
        var character = Property(value, "character");
        var inventory = Property(value, "inventory");
        var objectives = Property(value, "objectives");

        return !Boolean(Property(value, "hasChanges")) && !Boolean(Property(value, "hasUnrepresentedChanges")) && Property(value, "sessionChange").ValueKind == JsonValueKind.Null
            && Empty(Property(objectives, "added")) && Empty(Property(objectives, "removed")) && Empty(Property(objectives, "statusChanged"))
            && Integer(Property(character, "levelDelta")) == 0 && Integer(Property(character, "xpDelta")) == 0 && Zero(Property(character, "moneyDelta"))
            && Empty(Property(character, "skillChanges")) && Empty(Property(inventory, "gained")) && Empty(Property(inventory, "lost"))
            && !Boolean(Property(inventory, "equippedChanged")) && Empty(Property(value, "extraChanges"));
    }

    private static bool Empty(JsonElement value)
    {
        return value.ValueKind == JsonValueKind.Array && value.GetArrayLength() == 0;
    }

    private static bool Zero(JsonElement value)
    {
        return value.ValueKind == JsonValueKind.Number && value.TryGetDecimal(out var number) && number == 0;
    }

    internal static void Require(bool condition)
    {
        if (!condition)
        {
            throw new DocumentInvalidException("Event document invariant is invalid.");
        }
    }
}
