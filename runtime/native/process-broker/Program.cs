#nullable enable
using System;
using System.IO;
using Companion.Runtime;

internal static class Program
{
    private static int Main()
    {
        var scriptName = Path.GetFileNameWithoutExtension(Environment.ProcessPath ?? "Invoke-OwnedProcess");
        try
        {
            if (!OperatingSystem.IsWindows())
            {
                throw new PlatformNotSupportedException("Windows process ownership is required.");
            }

            var code = ProcessBroker.RunAsync(Console.OpenStandardInput(), Console.OpenStandardOutput(), Console.OpenStandardError(), allowChildEnvironment: true).GetAwaiter().GetResult();
            Environment.Exit(code);

            return code;
        }
        catch
        {
            // The broker exposes only the fixed one-line failure token.
            Console.Error.WriteLine($"{scriptName}: owned-process-failed");
            Console.Error.Flush();
            Environment.Exit(125);

            return 125;
        }
    }
}
