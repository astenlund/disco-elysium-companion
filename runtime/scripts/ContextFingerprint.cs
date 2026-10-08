#nullable enable
using System;
using System.Globalization;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Companion.Runtime;

public static class ContextFingerprint
{
    private enum Scope { Other, Context, Freshness, Events, Event, Diff, State }
    private static readonly UTF8Encoding Utf8 = new(false, true);

    public static string Compute(byte[] contextJson, string instructionsSha256, string providerFingerprint)
    {
        JsonDocuments.Validate(contextJson, "state-event");
        if (!Hex(instructionsSha256) || !Hex(providerFingerprint))
        {
            throw new DocumentInvalidException("Context fingerprint dependencies are invalid.");
        }

        using var document = JsonDocument.Parse(contextJson);
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        Atom(hash, 'v', "companion-context-semantic-v1");
        Atom(hash, 'i', instructionsSha256);
        Atom(hash, 'p', providerFingerprint);
        Append(hash, document.RootElement, Scope.Context);

        return Convert.ToHexStringLower(hash.GetHashAndReset());
    }

    private static bool Hex(string value)
    {
        return value.Length == 64 && value.All(character => character is >= '0' and <= '9' or >= 'a' and <= 'f');
    }

    private static void Atom(IncrementalHash hash, char kind, string value)
    {
        var bytes = Utf8.GetBytes(value);
        hash.AppendData([(byte)kind]);
        hash.AppendData(Encoding.ASCII.GetBytes(bytes.Length.ToString(CultureInfo.InvariantCulture)));
        hash.AppendData([(byte)':']);
        hash.AppendData(bytes);
    }

    private static bool Omitted(Scope scope, string name)
    {
        return scope switch
        {
            Scope.Context => name is "interactionId" or "requestReceivedAt",
            Scope.Freshness => name == "lastGoodGeneratedAt",
            Scope.Event => name is "eventId" or "sequence" or "redelivery",
            Scope.Diff => name is "baselineGeneratedAt" or "currentGeneratedAt" or "currentSource",
            Scope.State => name is "generatedAt" or "source",
            _ => false,
        };
    }

    private static Scope Child(Scope scope, string name)
    {
        return (scope, name) switch
        {
            (Scope.Context, "freshness") => Scope.Freshness,
            (Scope.Context, "events") => Scope.Events,
            (Scope.Context, "state") => Scope.State,
            (Scope.Event, "diff") => Scope.Diff,
            _ => Scope.Other,
        };
    }

    private static void Append(IncrementalHash hash, JsonElement value, Scope scope)
    {
        switch (value.ValueKind)
        {
            case JsonValueKind.Object:
                var properties = value.EnumerateObject().Where(property => !Omitted(scope, property.Name)).OrderBy(property => property.Name, StringComparer.Ordinal).ToArray();
                Atom(hash, 'o', properties.Length.ToString(CultureInfo.InvariantCulture));
                foreach (var property in properties)
                {
                    Atom(hash, 'k', property.Name);
                    Append(hash, property.Value, Child(scope, property.Name));
                }

                break;
            case JsonValueKind.Array:
                Atom(hash, 'a', value.GetArrayLength().ToString(CultureInfo.InvariantCulture));
                foreach (var item in value.EnumerateArray())
                {
                    Append(hash, item, scope == Scope.Events ? Scope.Event : Scope.Other);
                }

                break;
            case JsonValueKind.String:
                Atom(hash, 's', value.GetString()!);
                break;
            case JsonValueKind.Number:
                Atom(hash, 'n', NormalizeNumber(value.GetRawText()));
                break;
            case JsonValueKind.True:
                Atom(hash, 'b', "true");
                break;
            case JsonValueKind.False:
                Atom(hash, 'b', "false");
                break;
            case JsonValueKind.Null:
                Atom(hash, 'z', string.Empty);
                break;
            default:
                throw new DocumentInvalidException("Context value is unsupported.");
        }
    }

    // Decimal normalization never converts a game number to a machine floating
    // point value and never expands an exponent into a potentially enormous number.
    private static string NormalizeNumber(string raw)
    {
        var negative = raw[0] == '-';
        var exponentAt = raw.IndexOfAny(['e', 'E']);
        var coefficient = raw[(negative ? 1 : 0)..(exponentAt < 0 ? raw.Length : exponentAt)];
        var exponent = exponentAt < 0 ? "0" : raw[(exponentAt + 1)..];
        var decimalAt = coefficient.IndexOf('.');
        var fraction = decimalAt < 0 ? 0 : coefficient.Length - decimalAt - 1;
        var digits = coefficient.Replace(".", string.Empty, StringComparison.Ordinal).TrimStart('0');
        if (digits.Length == 0)
        {
            return "0";
        }

        var trailing = 0;
        while (digits[digits.Length - trailing - 1] == '0')
        {
            trailing++;
        }

        digits = digits[..(digits.Length - trailing)];

        return (negative ? "-" : string.Empty) + digits + "e" + AddExponent(exponent, trailing - fraction);
    }

    private static string AddExponent(string exponent, int offset)
    {
        var negative = exponent[0] == '-';
        var magnitude = (exponent[0] is '-' or '+' ? exponent[1..] : exponent).TrimStart('0');
        if (magnitude.Length == 0)
        {
            return offset.ToString(CultureInfo.InvariantCulture);
        }

        if (offset == 0)
        {
            return (negative ? "-" : string.Empty) + magnitude;
        }

        var adjustment = Math.Abs(offset).ToString(CultureInfo.InvariantCulture);
        if (negative == (offset < 0))
        {
            return (negative ? "-" : string.Empty) + AddMagnitude(magnitude, adjustment);
        }

        var comparison = magnitude.Length.CompareTo(adjustment.Length);
        if (comparison == 0)
        {
            comparison = string.CompareOrdinal(magnitude, adjustment);
        }

        if (comparison == 0)
        {
            return "0";
        }

        var result = comparison > 0 ? SubtractMagnitude(magnitude, adjustment) : SubtractMagnitude(adjustment, magnitude);
        var resultNegative = comparison > 0 ? negative : offset < 0;

        return (resultNegative ? "-" : string.Empty) + result;
    }

    private static string AddMagnitude(string left, string right)
    {
        var output = new char[Math.Max(left.Length, right.Length) + 1];
        var carry = 0;
        for (var position = 0; position < output.Length; position++)
        {
            var a = position < left.Length ? left[left.Length - position - 1] - '0' : 0;
            var b = position < right.Length ? right[right.Length - position - 1] - '0' : 0;
            var value = a + b + carry;
            output[output.Length - position - 1] = (char)('0' + value % 10);
            carry = value / 10;
        }

        return new string(output).TrimStart('0');
    }

    private static string SubtractMagnitude(string left, string right)
    {
        var output = new char[left.Length];
        var borrow = 0;
        for (var position = 0; position < output.Length; position++)
        {
            var a = left[left.Length - position - 1] - '0';
            var b = position < right.Length ? right[right.Length - position - 1] - '0' : 0;
            var value = a - b - borrow;
            borrow = value < 0 ? 1 : 0;
            output[output.Length - position - 1] = (char)('0' + (value < 0 ? value + 10 : value));
        }

        return new string(output).TrimStart('0');
    }
}
