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
$metadataNames = @('StartupMetadataWorker.ps1', 'StartupWorkerProtocol.ps1', 'NativeFiles.cs', 'JsonDocuments.cs',
    'FileHashes.cs', 'EventDocuments.cs', 'PayloadCodec.cs', 'RuntimeFilePublication.cs', 'RuntimeCodec.cs',
    'resource-lifecycle/ResourceInventory.cs')
$coreReplyNames = @('StartupCoreReplyWorker.ps1', 'StartupWorkerProtocol.ps1', 'Read-CoreReply.ps1',
    'CoreReplyValidation.ps1', 'NativeFiles.cs', 'JsonDocuments.cs', 'EventDocuments.cs',
    'PayloadCodec.cs', 'RuntimeFilePublication.cs', 'RuntimeCodec.cs')
$mutationNames = @('StartupMutationWorker.ps1', 'StartupWorkerProtocol.ps1', 'Write-RuntimeFile.ps1',
    'Invoke-PayloadCodec.ps1', 'NativeFiles.cs', 'JsonDocuments.cs', 'EventDocuments.cs',
    'PayloadCodec.cs', 'RuntimeFilePublication.cs', 'RuntimeCodec.cs')
$coreNames = @('DigestDiff.psm1', 'private/CompanionJson.ps1', 'private/SourceIdentity.ps1',
    'private/DocumentValidation.ps1', 'private/AdapterConfig.ps1', 'private/DiffEngine.ps1',
    'private/ProcessRunner.ps1', 'private/Acquisition.ps1', 'private/StateFiles.ps1',
    'private/Consumption.ps1', 'private/TurnContext.ps1', 'private/StateEvents.ps1',
    'private/StateEventStorage.ps1', 'private/Watcher.ps1', 'private/WalkProtocol.ps1')

function Read-AdmittedFile {
    param([string] $Root, [string] $Target)
    $before = [Companion.Runtime.NativeFiles]::AdmitWithin($Root, $Target, $false)
    if (-not $before.Exists -or $before.IsDirectory -or $before.Links -ne 1) { throw [IO.IOException]::new('Source admission failed.') }
    $bytes = [Companion.Runtime.JsonDocuments]::ReadBounded($before.Path, $maximumSourceBytes)
    $after = [Companion.Runtime.NativeFiles]::AdmitWithin($Root, $Target, $false)
    if (-not $after.Exists -or $after.IsDirectory -or $after.Links -ne 1 -or
        [string]::CompareOrdinal($before.Volume, $after.Volume) -ne 0 -or
        [string]::CompareOrdinal($before.Identity, $after.Identity) -ne 0) {
        throw [IO.IOException]::new('Source changed during admission.')
    }
    $again = [Companion.Runtime.JsonDocuments]::ReadBounded($after.Path, $maximumSourceBytes)
    if ($again.Length -ne $bytes.Length -or -not [Collections.StructuralComparisons]::StructuralEqualityComparer.Equals($bytes, $again)) {
        throw [IO.IOException]::new('Source changed during observation.')
    }

    return ,$bytes
}

function Add-BundleFile {
    param([IO.MemoryStream] $Bundle, [string] $Root, [string] $Target)
    $bytes = Read-AdmittedFile -Root $Root -Target $Target
    $length = $bytes.Length
    $header = [byte[]]::new(4)
    $header[0] = [byte](($length -shr 24) -band 255)
    $header[1] = [byte](($length -shr 16) -band 255)
    $header[2] = [byte](($length -shr 8) -band 255)
    $header[3] = [byte]($length -band 255)
    $Bundle.Write($header, 0, 4)
    $Bundle.Write($bytes, 0, $length)
}

function Get-BundleHash {
    param([string[]] $RuntimeNames, [string[]] $CoreNames)
    $bundle = [IO.MemoryStream]::new()
    try {
        foreach ($name in $RuntimeNames) { Add-BundleFile -Bundle $bundle -Root $SourceRoot -Target (Join-Path $SourceRoot (Join-Path 'runtime/scripts' $name)) }
        $coreRoot = Join-Path $CompanionRoot 'core'
        foreach ($name in $CoreNames) { Add-BundleFile -Bundle $bundle -Root $CompanionRoot -Target (Join-Path $coreRoot $name) }

        return [Convert]::ToHexStringLower([Security.Cryptography.SHA256]::HashData($bundle.ToArray()))
    }
    finally { $bundle.Dispose() }
}

try {
    if (-not $IsWindows) { throw [PlatformNotSupportedException]::new('Windows metadata is required.') }
    Add-Type -Path @((Join-Path $PSScriptRoot 'NativeFiles.cs'), (Join-Path $PSScriptRoot 'JsonDocuments.cs'))
    $temp = [Companion.Runtime.NativeFiles]::AdmitWithin($CompanionRoot, (Join-Path $CompanionRoot '.tmp'), $true)
    if (-not $temp.Exists) {
        [Console]::Out.Write((ConvertTo-Json -InputObject ([ordered]@{ status = 'absent' }) -Compress))
        exit 0
    }
    if (-not $temp.IsDirectory) { throw [IO.IOException]::new('Temporary directory is invalid.') }
    $scope = Read-AdmittedFile -Root $CompanionRoot -Target (Join-Path $DataRoot 'scope.json')
    $scopeSha256 = [Convert]::ToHexStringLower([Security.Cryptography.SHA256]::HashData($scope))
    $metadataSha256 = Get-BundleHash -RuntimeNames $metadataNames -CoreNames @()
    $coreReplySha256 = Get-BundleHash -RuntimeNames $coreReplyNames -CoreNames $coreNames
    $mutationSha256 = Get-BundleHash -RuntimeNames $mutationNames -CoreNames @()
    [Console]::Out.Write((ConvertTo-Json -InputObject ([ordered]@{
        status = 'present'; scopeSha256 = $scopeSha256; metadataSha256 = $metadataSha256;
        coreReplySha256 = $coreReplySha256; mutationSha256 = $mutationSha256
    }) -Compress))
    exit 0
}
catch {
    [Console]::Error.WriteLine("${scriptName}: source-evidence-unavailable")
    exit 1
}
