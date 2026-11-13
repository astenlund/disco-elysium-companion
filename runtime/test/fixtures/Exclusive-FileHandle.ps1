#Requires -Version 7.5
# Holds an existing file open without sharing, so no other process can read, write or delete it, until stdin closes.
# Prints 'ready' once the file is held; a file it cannot hold exits 1 without printing it.
[CmdletBinding()]
param([Parameter(Mandatory)] [string] $Path)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$scriptName = [IO.Path]::GetFileNameWithoutExtension($PSCommandPath)
try {
    $stream = [IO.FileStream]::new($Path, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
}
catch {
    [Console]::Error.WriteLine("${scriptName}: exclusive-open-unavailable")
    exit 1
}
try {
    [Console]::Out.WriteLine('ready')
    [Console]::Out.Flush()
    $null = [Console]::In.ReadLine()
}
finally {
    $stream.Dispose()
}
exit 0
