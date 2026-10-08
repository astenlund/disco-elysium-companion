#Requires -Version 7.5
[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string] $FixtureRoot,
    [Parameter(Mandatory)] [string] $Target,
    [Parameter(Mandatory)] [string] $InputFile
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$scriptName = [IO.Path]::GetFileNameWithoutExtension($PSCommandPath)
$repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../../..'))
$fixture = [IO.Path]::GetFullPath($FixtureRoot)
$targetPath = [IO.Path]::GetFullPath($Target)
$inputPath = [IO.Path]::GetFullPath($InputFile)
if (-not [string]::Equals([IO.Path]::GetDirectoryName($fixture), (Join-Path $repository '.tmp'), [StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($fixture) -cnotmatch '^runtime-fixture-[0-9]+-[a-f0-9]{32}$') {
    throw "${scriptName}: private fixture required"
}
$relative = [IO.Path]::GetRelativePath($fixture, $targetPath)
if ($relative.StartsWith('..', [StringComparison]::Ordinal) -or [IO.Path]::IsPathRooted($relative) -or [IO.Path]::GetFileName($targetPath) -cne 'cursor-agent-session.json') {
    throw "${scriptName}: private cursor target required"
}
if (-not [string]::Equals([IO.Path]::GetDirectoryName($targetPath), [IO.Path]::GetDirectoryName($inputPath), [StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($inputPath) -cnotmatch '^cursor-agent-session[.]json[.][a-f0-9]{32}[.]tmp$') {
    throw "${scriptName}: exact owned input sibling required"
}
$targetStream = $null
$inputStream = $null
try {
    $targetStream = [IO.FileStream]::new($targetPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    $inputStream = [IO.FileStream]::new($inputPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    [Console]::Out.WriteLine('locked')
    [Console]::Out.Flush()
    $null = [Console]::In.ReadLine()
}
finally {
    if ($null -ne $inputStream) { $inputStream.Dispose() }
    if ($null -ne $targetStream) { $targetStream.Dispose() }
}
