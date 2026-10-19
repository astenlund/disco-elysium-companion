/**
 * Settings for any helper environment that redirects the .NET home. A fresh `DOTNET_CLI_HOME` looks like a first run to
 * the SDK, which then appends `<home>/.dotnet/tools` to the persistent user PATH and may install a development
 * certificate; `DOTNET_SKIP_FIRST_TIME_EXPERIENCE` alone does not prevent the PATH write.
 */
export const dotnetFirstRunOptOuts: Readonly<Record<string, string>> = Object.freeze({
  DOTNET_ADD_GLOBAL_TOOLS_TO_PATH: 'false', DOTNET_GENERATE_ASPNET_CERTIFICATE: 'false', DOTNET_CLI_TELEMETRY_OPTOUT: '1',
  DOTNET_NOLOGO: '1', DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1', DOTNET_CLI_WORKLOAD_UPDATE_NOTIFY_DISABLE: 'true',
});
