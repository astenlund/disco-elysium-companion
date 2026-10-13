#Requires -Version 7.5
[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string] $Path,
    [switch] $Hold,
    [string] $StopPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$scriptName = [IO.Path]::GetFileNameWithoutExtension($PSCommandPath)
try {
    $stream = [IO.FileStream]::new($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::None)
    try {
        [Console]::Out.WriteLine('ready')
        if ($Hold) {
            if ([string]::IsNullOrEmpty($StopPath)) { throw [ArgumentException]::new('A stop path is required.') }
            $deadline = [Diagnostics.Stopwatch]::StartNew()
            while (-not [IO.File]::Exists($StopPath) -and $deadline.ElapsedMilliseconds -lt 30000) { [Threading.Thread]::Sleep(25) }
            if (-not [IO.File]::Exists($StopPath)) { throw [TimeoutException]::new('Exclusive hold timed out.') }
        }
    }
    finally { $stream.Dispose() }
    exit 0
}
catch {
    [Console]::Error.WriteLine("${scriptName}: exclusive-open-unavailable")
    exit 1
}
