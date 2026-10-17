#nullable enable
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace Companion.Runtime;

public static class ProcessBroker
{
    public static async Task<int> RunAsync(Stream input, Stream output, Stream error, bool allowChildEnvironment = false)
    {
        using var bufferedInput = new BufferedStream(input, 65536);
        var frame = ReadFrame(bufferedInput);
        JsonDocuments.Validate(frame, "config");
        using var document = JsonDocument.Parse(frame, new JsonDocumentOptions { MaxDepth = 64 });
        var root = document.RootElement;
        string[] fields = allowChildEnvironment
            ? ["command", "args", "cwd", "jobName", "parentPid", "parentCreated", "brokerProtocolVersion", "childEnvironment"]
            : ["command", "args", "cwd", "jobName", "parentPid", "parentCreated"];
        if (root.ValueKind != JsonValueKind.Object || root.EnumerateObject().Count() != fields.Length || fields.Any(field => !root.TryGetProperty(field, out _)))
        {
            throw new InvalidDataException("Invalid broker control fields.");
        }

        var command = StringValue(root.GetProperty("command"));
        var childEnvironment = allowChildEnvironment ? ParseChildEnvironment(root) : null;
        var directory = StringValue(root.GetProperty("cwd"));
        var jobName = StringValue(root.GetProperty("jobName"));
        var expectedParent = StringValue(root.GetProperty("parentCreated"));
        if (!root.GetProperty("parentPid").TryGetInt32(out var parentPid) || parentPid <= 0 || parentPid == Environment.ProcessId || root.GetProperty("args").ValueKind != JsonValueKind.Array)
        {
            throw new InvalidDataException("Invalid broker parent or arguments.");
        }

        var arguments = root.GetProperty("args").EnumerateArray().Select(element => StringValue(element, true)).ToArray();
        using var parent = Process.GetProcessById(parentPid);
        _ = parent.Handle;
        var actualParent = parent.StartTime.ToUniversalTime().ToFileTimeUtc().ToString(CultureInfo.InvariantCulture);
        if (!string.Equals(actualParent, expectedParent, StringComparison.Ordinal) || parent.HasExited)
        {
            throw new InvalidOperationException("Broker parent identity is no longer current.");
        }

        NativeJobs.OwnCurrentProcess(jobName);
        using var monitorStop = new CancellationTokenSource();
        var monitor = MonitorParentAsync(parent, monitorStop.Token);
        try
        {
            using var child = new Process();
            child.StartInfo = new ProcessStartInfo(command)
            {
                WorkingDirectory = directory,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            };
            foreach (var argument in arguments)
            {
                child.StartInfo.ArgumentList.Add(argument);
            }

            if (childEnvironment is not null)
            {
                child.StartInfo.Environment.Clear();
                foreach (var (name, value) in childEnvironment)
                {
                    child.StartInfo.Environment.Add(name, value);
                }
            }

            if (parent.HasExited || !child.Start())
            {
                throw new InvalidOperationException("Owned child could not be started.");
            }

            using var current = Process.GetCurrentProcess();
            var header = new
            {
                ownedProcessVersion = 1,
                jobName,
                pid = child.Id,
                created = child.StartTime.ToUniversalTime().ToFileTimeUtc().ToString(CultureInfo.InvariantCulture),
                brokerPid = current.Id,
                brokerCreated = current.StartTime.ToUniversalTime().ToFileTimeUtc().ToString(CultureInfo.InvariantCulture),
            };
            var headerBytes = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(header) + "\n");
            await output.WriteAsync(headerBytes).ConfigureAwait(false);
            await output.FlushAsync().ConfigureAwait(false);
            var outputCopy = child.StandardOutput.BaseStream.CopyToAsync(output);
            var errorCopy = child.StandardError.BaseStream.CopyToAsync(error);
            _ = Task.Run(() => ForwardInputAsync(bufferedInput, child));
            await child.WaitForExitAsync().ConfigureAwait(false);
            await Task.WhenAll(outputCopy, errorCopy).ConfigureAwait(false);
            await output.FlushAsync().ConfigureAwait(false);
            await error.FlushAsync().ConfigureAwait(false);

            return child.ExitCode;
        }
        finally
        {
            monitorStop.Cancel();
            await monitor.ConfigureAwait(false);
        }
    }

    private static byte[] ReadFrame(Stream input)
    {
        var limit = JsonDocuments.Budget("config").Bytes;
        using var frame = new MemoryStream();
        while (frame.Length <= limit)
        {
            var value = input.ReadByte();
            if (value == 10)
            {

                return frame.ToArray();
            }

            if (value < 0)
            {
                throw new EndOfStreamException("Broker control frame is incomplete.");
            }

            frame.WriteByte((byte)value);
        }

        throw new InvalidDataException("Broker control frame exceeds its budget.");
    }

    private static string StringValue(JsonElement element, bool allowEmpty = false)
    {
        if (element.ValueKind != JsonValueKind.String)
        {
            throw new InvalidDataException("Expected a broker string.");
        }

        var value = element.GetString();
        if (value is null || !allowEmpty && value.Length == 0)
        {
            throw new InvalidDataException("Broker string is absent.");
        }

        return value;
    }

    private static Dictionary<string, string> ParseChildEnvironment(JsonElement root)
    {
        if (!root.GetProperty("brokerProtocolVersion").TryGetInt32(out var version) || version != 2)
        {
            throw new InvalidDataException("Invalid broker protocol version.");
        }

        var element = root.GetProperty("childEnvironment");
        if (element.ValueKind != JsonValueKind.Object)
        {
            throw new InvalidDataException("Invalid child environment.");
        }

        var environment = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var property in element.EnumerateObject())
        {
            var name = property.Name;
            var value = StringValue(property.Value, true);
            if (name.Length == 0 || name.Contains('=') || name.Contains('\0') || value.Contains('\0') || !environment.TryAdd(name, value))
            {
                throw new InvalidDataException("Invalid child environment entry.");
            }
        }

        return environment;
    }

    private static async Task MonitorParentAsync(Process parent, CancellationToken cancellationToken)
    {
        try
        {
            await parent.WaitForExitAsync(cancellationToken).ConfigureAwait(false);
            Environment.Exit(125);
        }
        catch (OperationCanceledException)
        {
            // Normal child completion ends the monitor while the parent remains alive.
        }
    }

    private static async Task ForwardInputAsync(Stream input, Process child)
    {
        try
        {
            await input.CopyToAsync(child.StandardInput.BaseStream).ConfigureAwait(false);
            child.StandardInput.Close();
        }
        catch (Exception exception) when (exception is IOException or ObjectDisposedException or InvalidOperationException)
        {
            // A broken command channel cannot leave a running helper accepting later work.
            try
            {
                if (!child.HasExited)
                {
                    Environment.Exit(125);
                }
            }
            catch (InvalidOperationException)
            {
                // The completed child was already disposed by the broker.
            }
        }
    }
}
