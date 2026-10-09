#nullable enable
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Companion.Runtime;

// The output is bounded aggregate control metadata. Every retained event is
// inspected in this process, so unbounded compact history is never truncated.
public static class ResourceInventory
{
    private const int QuarantineFileLimit = 256;
    private static readonly Regex EventName = new("^[0-9]{16}[.]json$", RegexOptions.CultureInvariant);
    private static readonly Regex OperationName = new("^(jr|rl|ho)-[0-9a-f]{32}[.]json$", RegexOptions.CultureInvariant);
    private static readonly Regex TemporaryName = new("[.][0-9a-f]{32}[.](tmp|bak)$", RegexOptions.CultureInvariant);
    private static readonly Regex QuarantineName = new("^[A-Za-z0-9.-]+[.][0-9a-f]{32}[.]quarantined$", RegexOptions.CultureInvariant);
    private static readonly HashSet<string> Fixed = new(StringComparer.Ordinal)
    {
        "scope.json", "runtime.json", "agent-session.json", "agent-session-index.json", "state-safety.json",
        "journal/journal.json", "journal/cursor-agent-session.json", "journal/recovery-event.json", "prepared-context.txt", "codec.json",
    };

    public static byte[] Read(string root, string scopeSha256, bool markerOnly, string? companionRoot = null)
    {
        VerifyScope(root, scopeSha256);
        var handoffs = new HashSet<string>(StringComparer.Ordinal);
        var potentialHandoffs = new HashSet<string>(StringComparer.Ordinal);
        var journalSources = new HashSet<string>(StringComparer.Ordinal);
        var uncompacted = 0;
        var invalidEvents = 0;
        var invalidOperations = 0;
        var terminalOperations = 0;
        var unfinishedOperations = 0;
        var residue = false;
        foreach (var file in Enumerate(root, root, markerOnly))
        {
            var relative = Path.GetRelativePath(root, file).Replace('\\', '/');
            if (TemporaryName.IsMatch(relative) || relative == "codec.json" || relative == "prepared-context.txt")
            {
                residue = true;
                continue;
            }

            if (markerOnly || relative.StartsWith("quarantine/", StringComparison.Ordinal))
            {
                continue;
            }

            if (relative.StartsWith("journal/events/", StringComparison.Ordinal) || relative == "journal/recovery-event.json")
            {
                try
                {
                    var bytes = JsonDocuments.ReadBounded(file, JsonDocuments.Budget("state-event").Bytes);
                    using var metadata = JsonDocument.Parse(RuntimeCodec.InspectFrozen(bytes, false));
                    var value = metadata.RootElement;
                    var eventFile = relative != "journal/recovery-event.json";
                    if (eventFile && (!EventName.IsMatch(Path.GetFileName(file)) || !long.TryParse(Path.GetFileNameWithoutExtension(file), NumberStyles.None, CultureInfo.InvariantCulture, out var sequence)
                        || !value.TryGetProperty("sequence", out var position) || position.ValueKind != JsonValueKind.Number
                        || !position.TryGetInt64(out var actualSequence) || actualSequence != sequence))
                    {
                        throw new DocumentInvalidException("Event position differs from filename.");
                    }

                    if (eventFile && !value.GetProperty("compacted").GetBoolean())
                    {
                        uncompacted++;
                    }

                    if (eventFile)
                    {
                        // Header recovery preserves readable compact identities too.
                        potentialHandoffs.Add(Identity(value));
                        journalSources.Add(EventDocuments.Hex(value.GetProperty("recordSha256"), 64) + ":" + EventDocuments.LogicalSequence(value.GetProperty("logicalOutboxId")).ToString(CultureInfo.InvariantCulture));
                    }
                }
                catch (DocumentInvalidException)
                {
                    _ = JsonDocuments.ObserveRaw(file);
                    invalidEvents++;
                    if (relative != "journal/recovery-event.json")
                    {
                        uncompacted++;
                    }
                }

                continue;
            }

            if (relative.StartsWith("operations/", StringComparison.Ordinal))
            {
                if (!OperationName.IsMatch(Path.GetFileName(file)))
                {
                    throw new IOException("Unexpected operation member.");
                }

                try
                {
                    var bytes = JsonDocuments.ReadBounded(file, JsonDocuments.Budget("state-event").Bytes);
                    JsonDocuments.Validate(bytes, "state-event");
                    using var document = JsonDocument.Parse(bytes);
                    var value = document.RootElement;
                    if (!value.TryGetProperty("compacted", out var compacted) || compacted.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
                    {
                        throw new DocumentInvalidException("Operation shape unavailable.");
                    }

                    if (!compacted.GetBoolean())
                    {
                        if (value.GetProperty("completedAt").ValueKind == JsonValueKind.Null)
                        {
                            unfinishedOperations++;
                        }
                        else
                        {
                            terminalOperations++;
                        }

                        if (value.GetProperty("kind").GetString() == "repair")
                        {
                            foreach (var handoff in value.GetProperty("plan").GetProperty("handoffs").EnumerateArray())
                            {
                                var identity = Identity(handoff);
                                handoffs.Add(identity);
                                potentialHandoffs.Add(identity);
                            }
                        }
                    }
                }
                catch (Exception exception) when (exception is DocumentInvalidException or JsonException or InvalidOperationException or KeyNotFoundException)
                {
                    _ = JsonDocuments.ObserveRaw(file);
                    invalidOperations++;
                }
            }
        }

        VerifyScope(root, scopeSha256);
        var free = new DriveInfo(Path.GetPathRoot(root)!).AvailableFreeSpace;
        var pendingOutbox = markerOnly || string.IsNullOrEmpty(companionRoot) ? 0 : CountOutbox(companionRoot, journalSources);

        return JsonSerializer.SerializeToUtf8Bytes(new { uncompactedEvents = uncompacted, retainedHandoffs = handoffs.Count, retainedHandoffIdentitySha256 = IdentitySetHash(handoffs), potentialHandoffs = potentialHandoffs.Count,
            fullTerminalOperations = terminalOperations, unfinishedOperations, invalidEvents, invalidOperations, pendingOutbox, uncertainWorkspace = residue, freeBytes = free.ToString(CultureInfo.InvariantCulture) });
    }

    private static int CountOutbox(string companionRoot, HashSet<string> journalSources)
    {
        var directory = NativeFiles.AdmitWithin(companionRoot, Path.Combine(companionRoot, "state", "outbox"), true);
        if (!directory.Exists)
        {
            return 0;
        }

        if (!directory.IsDirectory)
        {
            throw new IOException("Outbox inventory is not a directory.");
        }

        var count = 0;
        var inspected = 0;
        foreach (var entry in Directory.EnumerateFileSystemEntries(directory.Path))
        {
            if (++inspected > 1032)
            {
                throw new IOException("Outbox discovery is incomplete.");
            }

            var name = Path.GetFileName(entry);
            if (name.StartsWith("event-", StringComparison.Ordinal) && EventName.IsMatch(name[6..]))
            {
                var record = NativeFiles.AdmitWithin(companionRoot, entry, false);
                if (record.IsDirectory)
                {
                    throw new IOException("Outbox record is not an ordinary file.");
                }

                var sequence = long.Parse(name.AsSpan(6, 16), NumberStyles.None, CultureInfo.InvariantCulture);
                if (sequence < 1 || sequence > EventDocuments.MaximumSequence)
                {
                    continue;
                }

                var duplicate = false;
                if (journalSources.Count > 0 && new FileInfo(record.Path).Length <= JsonDocuments.Budget("state-event").Bytes)
                {
                    duplicate = journalSources.Contains(JsonDocuments.ObserveRaw(record.Path).Sha256 + ":" + sequence.ToString(CultureInfo.InvariantCulture));
                }

                if (!duplicate)
                {
                    count = checked(count + 1);
                }
            }
        }

        return count;
    }

    private static string IdentitySetHash(HashSet<string> identities)
    {
        var ordered = new List<string>(identities);
        ordered.Sort(StringComparer.Ordinal);

        return Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(string.Join(((char)10).ToString(), ordered))));
    }

    private static string Identity(JsonElement value)
    {
        var logical = EventDocuments.Text(value.GetProperty("logicalOutboxId"));
        var hash = EventDocuments.Hex(value.GetProperty("recordSha256"), 64);

        return logical + ":" + hash;
    }

    private static void VerifyScope(string root, string expected)
    {
        var binding = NativeFiles.AdmitWithin(root, Path.Combine(root, "scope.json"), false);
        if (binding.IsDirectory || Convert.ToHexStringLower(SHA256.HashData(JsonDocuments.ReadBounded(binding.Path, JsonDocuments.Budget("config").Bytes))) != expected)
        {
            throw new IOException("Immutable scope changed.");
        }
    }

    private static IEnumerable<string> Enumerate(string root, string directory, bool markerOnly)
    {
        foreach (var entry in Directory.EnumerateFileSystemEntries(directory))
        {
            var admitted = NativeFiles.AdmitWithin(root, entry, false);
            var relative = Path.GetRelativePath(root, entry).Replace('\\', '/');
            if (admitted.IsDirectory)
            {
                if (markerOnly)
                {
                    continue;
                }

                if (relative is not ("journal" or "journal/events" or "operations" or "quarantine"))
                {
                    throw new IOException("Unexpected runtime directory.");
                }

                foreach (var child in Enumerate(root, entry, false))
                {
                    yield return child;
                }
            }
            else if (markerOnly)
            {
                if (relative == "runtime.json" || relative.StartsWith("runtime.json.", StringComparison.Ordinal))
                {
                    yield return entry;
                }
            }
            else
            {
                if (!Fixed.Contains(relative) && !TemporaryName.IsMatch(relative)
                    && !relative.StartsWith("journal/events/", StringComparison.Ordinal) && !relative.StartsWith("operations/", StringComparison.Ordinal) && !relative.StartsWith("quarantine/", StringComparison.Ordinal))
                {
                    throw new IOException("Unexpected runtime file.");
                }

                yield return entry;
            }
        }
    }

    public static void CheckEventExpansion(byte[] bytes)
    {
        PayloadCodec.ValidateFinalizationBudget(bytes);
    }

    public static byte[] TrimQuarantine(string root, string scopeSha256, byte[] protectedBytes)
    {
        VerifyScope(root, scopeSha256);
        JsonDocuments.Validate(protectedBytes, "config");
        using var document = JsonDocument.Parse(protectedBytes);
        if (document.RootElement.ValueKind != JsonValueKind.Array)
        {
            throw new DocumentInvalidException("Quarantine protection inventory is invalid.");
        }

        var protectedPaths = new HashSet<string>(StringComparer.Ordinal);
        foreach (var value in document.RootElement.EnumerateArray())
        {
            var relative = EventDocuments.Text(value);
            if (!relative.StartsWith("quarantine/", StringComparison.Ordinal) || !QuarantineName.IsMatch(relative[11..]))
            {
                throw new DocumentInvalidException("Quarantine protection is outside its owned directory.");
            }

            protectedPaths.Add(relative[11..]);
        }

        var directory = NativeFiles.AdmitWithin(root, Path.Combine(root, "quarantine"), true);
        if (!directory.Exists)
        {
            return JsonSerializer.SerializeToUtf8Bytes(new { removed = 0, remaining = 0 });
        }

        if (!directory.IsDirectory)
        {
            throw new IOException("Quarantine is not an ordinary directory.");
        }

        var files = new List<(string Path, string Name, DateTime Written)>();
        foreach (var entry in Directory.EnumerateFileSystemEntries(directory.Path))
        {
            var admitted = NativeFiles.AdmitWithin(root, entry, false);
            var name = Path.GetFileName(entry);
            if (admitted.IsDirectory || !QuarantineName.IsMatch(name))
            {
                throw new IOException("Quarantine inventory is incomplete.");
            }

            files.Add((entry, name, File.GetLastWriteTimeUtc(entry)));
        }

        files.Sort((left, right) => left.Written != right.Written ? left.Written.CompareTo(right.Written) : string.CompareOrdinal(left.Name, right.Name));
        var removed = 0;
        foreach (var file in files)
        {
            if (files.Count - removed <= QuarantineFileLimit)
            {
                break;
            }

            if (protectedPaths.Contains(file.Name))
            {
                continue;
            }

            VerifyScope(root, scopeSha256);
            var before = NativeFiles.AdmitWithin(root, file.Path, false);
            var observed = JsonDocuments.ObserveRaw(file.Path);
            var after = NativeFiles.AdmitWithin(root, file.Path, false);
            if (before.IsDirectory || after.IsDirectory || before.Volume != after.Volume || before.Identity != after.Identity || JsonDocuments.ObserveRaw(file.Path).Sha256 != observed.Sha256)
            {
                throw new IOException("Quarantine target changed during retention.");
            }

            File.Delete(file.Path);
            removed++;
        }

        return JsonSerializer.SerializeToUtf8Bytes(new { removed, remaining = files.Count - removed });
    }
}
