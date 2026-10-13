#Requires -Version 7.5
[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string] $CompanionRoot,
    [Parameter(Mandatory)] [string] $DataRoot,
    [Parameter(Mandatory)] [string] $SourceRoot
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$scriptName = [IO.Path]::GetFileNameWithoutExtension($PSCommandPath)
$maximumSourceBytes = 1048576
$sourceNames = @('StartupMetadataWorker.ps1', 'NativeFiles.cs', 'JsonDocuments.cs', 'FileHashes.cs')

function Read-AdmittedSource {
    param([string] $Root, [string[]] $Targets)

    $before = @($Targets | ForEach-Object { [Companion.Runtime.NativeFiles]::AdmitWithin($Root, $_, $false) })
    $bytes = [Collections.Generic.List[byte[]]]::new()
    foreach ($item in $before) {
        if (-not $item.Exists -or $item.IsDirectory -or $item.Links -ne 1) { throw [IO.IOException]::new('Source admission failed.') }
        $bytes.Add([Companion.Runtime.JsonDocuments]::ReadBounded($item.Path, $maximumSourceBytes))
    }
    $after = @($Targets | ForEach-Object { [Companion.Runtime.NativeFiles]::AdmitWithin($Root, $_, $false) })
    for ($index = 0; $index -lt $Targets.Count; $index++) {
        if (-not $after[$index].Exists -or $after[$index].IsDirectory -or $after[$index].Links -ne 1 -or
            [string]::CompareOrdinal($before[$index].Volume, $after[$index].Volume) -ne 0 -or
            [string]::CompareOrdinal($before[$index].Identity, $after[$index].Identity) -ne 0) {
            throw [IO.IOException]::new('Source changed during admission.')
        }
        $again = [Companion.Runtime.JsonDocuments]::ReadBounded($after[$index].Path, $maximumSourceBytes)
        if (-not [Collections.StructuralComparisons]::StructuralEqualityComparer.Equals($bytes[$index], $again)) {
            throw [IO.IOException]::new('Source changed during observation.')
        }
    }

    return ,$bytes.ToArray()
}

try {
    if (-not $IsWindows) { throw [PlatformNotSupportedException]::new('Windows metadata is required.') }
    Add-Type -Path @((Join-Path $PSScriptRoot 'NativeFiles.cs'), (Join-Path $PSScriptRoot 'JsonDocuments.cs'))
    $temp = [Companion.Runtime.NativeFiles]::AdmitWithin($CompanionRoot, (Join-Path $CompanionRoot '.tmp'), $true)
    if (-not $temp.Exists) {
        [Console]::Out.Write('{"status":"absent"}')
        exit 0
    }
    if (-not $temp.IsDirectory) { throw [IO.IOException]::new('Temporary directory is invalid.') }
    $scope = Read-AdmittedSource -Root $CompanionRoot -Targets @((Join-Path $DataRoot 'scope.json'))
    $sources = Read-AdmittedSource -Root $SourceRoot -Targets @($sourceNames | ForEach-Object { Join-Path $SourceRoot (Join-Path 'runtime/scripts' $_) })
    $scopeSha256 = [Convert]::ToHexStringLower([Security.Cryptography.SHA256]::HashData($scope[0]))
    $bundle = [IO.MemoryStream]::new()
    try {
        foreach ($bytes in $sources) {
            $length = $bytes.Length
            $header = [byte[]]::new(4)
            $header[0] = [byte](($length -shr 24) -band 255)
            $header[1] = [byte](($length -shr 16) -band 255)
            $header[2] = [byte](($length -shr 8) -band 255)
            $header[3] = [byte]($length -band 255)
            $bundle.Write($header, 0, $header.Length)
            $bundle.Write($bytes, 0, $length)
        }
        $sourceSha256 = [Convert]::ToHexStringLower([Security.Cryptography.SHA256]::HashData($bundle.ToArray()))
    }
    finally { $bundle.Dispose() }
    [Console]::Out.Write((ConvertTo-Json -InputObject ([ordered]@{ status = 'present'; scopeSha256 = $scopeSha256; sourceSha256 = $sourceSha256 }) -Compress))
    exit 0
}
catch {
    [Console]::Error.WriteLine("${scriptName}: source-evidence-unavailable")
    exit 1
}
