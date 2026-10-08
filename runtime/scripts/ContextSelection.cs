#nullable enable
using System;
using System.Collections.Generic;

namespace Companion.Runtime;

public static class ContextSelection
{
    // The enumerable is consumed only through the first event that does not fit.
    // Callers load and verify records lazily, so historic payloads are not accumulated.
    public static ContextRendering? Select(int shape, byte[] template, IEnumerable<ContextEventSelection> events, VerifiedContextRecord? state, bool stateWanted,
        string generation, string instructionsSha256, string providerFingerprint, int? failedBlockBytes = null)
    {
        if (shape is < 1 or > 4 || stateWanted && state is null || failedBlockBytes is < 1 or > ContextCodec.MaximumBlockBytes)
        {
            throw new DocumentInvalidException("Context selection inputs are inconsistent.");
        }

        if (shape == 2 && failedBlockBytes is null)
        {

            return null;
        }

        using var source = events.GetEnumerator();
        var first = source.MoveNext() ? source.Current : null;
        if (first is not null && !stateWanted)
        {
            throw new DocumentInvalidException("Carried events require the current state to be wanted.");
        }

        ContextRendering? Render(IReadOnlyList<ContextEventSelection> selected, VerifiedContextRecord? selectedState, string? degraded, bool omitDiff = false, bool omitWarnings = false, int maximum = ContextCodec.MaximumBlockBytes)
        {

            return ContextCodec.Render(template, selected, selectedState, generation, degraded, omitDiff, omitWarnings, instructionsSha256, providerFingerprint, maximum);
        }

        ContextRendering Floor()
        {
            IReadOnlyList<ContextEventSelection> selected = first is null ? [] : [first];
            var degraded = stateWanted ? "stateTooLarge" : "eventTooLarge";
            var result = Render(selected, null, degraded, true) ?? Render(selected, null, degraded, true, true);

            return result ?? throw new DocumentInvalidException("Required context fields exceed the header-only floor.");
        }

        ContextRendering WithoutDiff()
        {
            IReadOnlyList<ContextEventSelection> selected = first is null ? [] : [first];
            var result = Render(selected, stateWanted ? state : null, first is null ? null : "eventTooLarge", first is not null);

            return result ?? Floor();
        }

        if (shape == 4)
        {

            return Floor();
        }

        if (shape == 3)
        {

            return WithoutDiff();
        }

        var maximum = shape == 2 ? failedBlockBytes!.Value / 2 : ContextCodec.MaximumBlockBytes;
        if (maximum < 1)
        {

            return null;
        }

        var empty = Render([], stateWanted ? state : null, null, maximum: maximum);
        if (empty is null)
        {

            return shape == 1 ? WithoutDiff() : null;
        }

        var selected = new List<ContextEventSelection>();
        long bytes = empty.Bytes.Length;
        var current = first;
        while (current is not null)
        {
            var candidateBytes = bytes + ContextCodec.EventBytes(current) + (selected.Count == 0 ? 0 : 1);
            if (candidateBytes > maximum)
            {
                break;
            }

            selected.Add(current);
            bytes = candidateBytes;
            current = source.MoveNext() ? source.Current : null;
        }

        if (first is not null && selected.Count == 0)
        {

            return shape == 1 ? WithoutDiff() : null;
        }

        var chosen = Render(selected, stateWanted ? state : null, null, maximum: maximum);
        if (chosen is null || chosen.Bytes.Length != bytes)
        {
            throw new DocumentInvalidException("Context byte planning differs from its exact encoding.");
        }

        return chosen;
    }
}
