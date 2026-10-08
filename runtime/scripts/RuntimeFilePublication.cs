#nullable enable
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Security.Cryptography;
using System.Text.RegularExpressions;

namespace Companion.Runtime;

public sealed record PublicationResult(string Sha256, string[] RetainedSiblings);

public static class RuntimeFilePublication
{
    public static PublicationResult Publish(string root, string target, string input, string expectedSha256, string profile, bool createOnly)
    {
        var destination = NativeFiles.AdmitWithin(root, target, true);
        var source = NativeFiles.AdmitWithin(root, input, false);
        if (destination.IsDirectory || source.IsDirectory || destination.Missing.Length > 1 || !Regex.IsMatch(expectedSha256, @"\A[a-f0-9]{64}\z", RegexOptions.CultureInvariant))
        {
            throw new IOException("Publication target or source is inadmissible.");
        }

        target = destination.Path;
        input = source.Path;
        if (!string.Equals(Path.GetDirectoryName(target), Path.GetDirectoryName(input), StringComparison.OrdinalIgnoreCase) || !Regex.IsMatch(Path.GetFileName(input), @"\A" + Regex.Escape(Path.GetFileName(target)) + @"\.[a-f0-9]{32}\.tmp\z", RegexOptions.CultureInvariant))
        {
            throw new IOException("Publication input must be an owned target sibling.");
        }

        if (createOnly && destination.Exists)
        {
            throw new IOException("Create-only target already exists.");
        }

        var maximumBytes = JsonDocuments.Budget(profile).Bytes;
        var bytes = JsonDocuments.ReadBounded(input, maximumBytes);
        JsonDocuments.Validate(bytes, profile);
        var actualHash = Convert.ToHexStringLower(SHA256.HashData(bytes));
        if (!string.Equals(actualHash, expectedSha256, StringComparison.Ordinal))
        {
            throw new IOException("Publication input changed before its frozen read.");
        }

        return PublishFrozen(root, target, bytes, profile, createOnly);
    }

    public static PublicationResult PublishFrozen(string root, string target, byte[] bytes, string profile, bool createOnly)
    {

        return PublishValidated(root, target, bytes, value => JsonDocuments.Validate(value, profile), createOnly);
    }

    public static PublicationResult PublishPreparedContext(string root, byte[] bytes)
    {
        static void Validate(byte[] value)
        {
            ReadOnlySpan<byte> opening = "<companion-turn-context>"u8;
            ReadOnlySpan<byte> closing = "</companion-turn-context>"u8;
            if (value.Length > 4194304 || value.Length <= opening.Length + closing.Length || !value.AsSpan().StartsWith(opening) || !value.AsSpan().EndsWith(closing))
            {
                throw new DocumentInvalidException("Prepared context is not one bounded tagged block.");
            }

            JsonDocuments.Validate(value.AsSpan(opening.Length, value.Length - opening.Length - closing.Length).ToArray(), "state-event");
        }

        return PublishValidated(root, Path.Combine(root, "prepared-context.txt"), bytes, Validate, true);
    }

    private static PublicationResult PublishValidated(string root, string target, byte[] bytes, Action<byte[]> validate, bool createOnly)
    {
        var destination = NativeFiles.AdmitWithin(root, target, true);
        if (destination.IsDirectory || destination.Missing.Length > 1 || createOnly && destination.Exists)
        {
            throw new IOException("Publication destination is inadmissible or already exists.");
        }

        target = destination.Path;
        validate(bytes);
        var actualHash = Convert.ToHexStringLower(SHA256.HashData(bytes));

        var temporary = NewSibling(root, target, ".tmp");
        var backup = NewSibling(root, target, ".bak");
        var temporaryCreated = false;
        var backupCreated = false;
        var retained = new List<string>();
        try
        {
            using (var stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None))
            {
                temporaryCreated = true;
                stream.Write(bytes);
                stream.Flush(true);
            }

            var current = NativeFiles.AdmitWithin(root, target, true);
            if (current.IsDirectory || current.Missing.Length > 1)
            {
                throw new IOException("Publication destination changed kind.");
            }

            if (createOnly || !current.Exists)
            {
                File.Move(temporary, target, false);
            }
            else
            {
                if (NativeFiles.AdmitWithin(root, backup, true).Exists)
                {
                    throw new IOException("Publication backup collided.");
                }

                File.Replace(temporary, target, backup, true);
                backupCreated = true;
            }

            temporaryCreated = false;
        }
        finally
        {
            if (temporaryCreated && !RemoveOwned(root, temporary))
            {
                retained.Add(temporary);
            }

            if (backupCreated && !RemoveOwned(root, backup))
            {
                retained.Add(backup);
            }
        }

        return new PublicationResult(actualHash, [.. retained]);
    }

    private static string NewSibling(string root, string target, string suffix)
    {
        for (var attempt = 0; attempt < 4; attempt++)
        {
            var candidate = target + "." + Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(16)) + suffix;
            if (!NativeFiles.AdmitWithin(root, candidate, true).Exists)
            {
                return candidate;
            }
        }

        throw new IOException("Publication sibling allocation exhausted.");
    }

    private static bool RemoveOwned(string root, string target)
    {
        try
        {
            var admission = NativeFiles.AdmitWithin(root, target, true);
            if (admission.Exists)
            {
                if (admission.IsDirectory)
                {
                    return false;
                }

                File.Delete(admission.Path);
            }

            return true;
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or Win32Exception)
        {
            // Retain unverified residue; cleanup cannot undo completed publication.

            return false;
        }
    }
}
