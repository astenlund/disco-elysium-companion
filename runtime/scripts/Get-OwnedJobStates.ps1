#Requires -Version 7.5
[CmdletBinding()]
param([Parameter(Mandatory)] [string] $JobNamesJson)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$scriptName = [IO.Path]::GetFileNameWithoutExtension($PSCommandPath)

try {
    $document = [Text.Json.JsonDocument]::Parse($JobNamesJson)
    try {
        $root = $document.RootElement
        if ($root.ValueKind -ne [Text.Json.JsonValueKind]::Array) { throw [FormatException]::new('Job names must be an array.') }
        $names = @($root.EnumerateArray() | ForEach-Object {
            if ($_.ValueKind -ne [Text.Json.JsonValueKind]::String) { throw [FormatException]::new('A job name is invalid.') }
            $_.GetString()
        })
        if ($names.Count -lt 1 -or $names.Count -gt 8) { throw [FormatException]::new('Job count is invalid.') }
        $unique = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
        foreach ($name in $names) {
            if ([string]::IsNullOrEmpty($name) -or -not $unique.Add($name)) { throw [FormatException]::new('A job name is repeated or empty.') }
        }
    }
    finally { $document.Dispose() }
    Add-Type -Path (Join-Path $PSScriptRoot 'NativeJobs.cs')
    $jobs = foreach ($name in $names) {
        $count = [Companion.Runtime.NativeJobs]::Observe($name)
        [ordered]@{ name = $name; state = if ($null -eq $count) { 'absent' } else { 'present' }; processes = $count }
    }
    [Console]::Out.Write((ConvertTo-Json -InputObject ([ordered]@{ jobs = @($jobs) }) -Depth 4 -Compress))
    exit 0
}
catch {
    [Console]::Error.WriteLine("${scriptName}: job-state-unavailable")
    exit 1
}
