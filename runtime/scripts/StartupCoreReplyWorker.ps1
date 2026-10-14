#Requires -Version 7.5
[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string] $CompanionRoot,
    [Parameter(Mandatory)] [string] $DataRoot,
    [Parameter(Mandatory)] [string] $SourceRoot,
    [Parameter(Mandatory)] [string] $Nonce
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$scriptName = [IO.Path]::GetFileNameWithoutExtension($PSCommandPath)
$utf8 = [Text.UTF8Encoding]::new($false, $true)
$inputStream = [Console]::OpenStandardInput()
$outputStream = [Console]::OpenStandardOutput()
$maximumInputFrame = 2097152
$maximumOutputFrame = 65536
$runtimeNames = @('StartupCoreReplyWorker.ps1', 'StartupWorkerProtocol.ps1', 'Read-CoreReply.ps1',
    'CoreReplyValidation.ps1', 'NativeFiles.cs', 'JsonDocuments.cs', 'EventDocuments.cs',
    'PayloadCodec.cs', 'RuntimeFilePublication.cs', 'RuntimeCodec.cs')
$coreNames = @('DigestDiff.psm1', 'private/CompanionJson.ps1', 'private/SourceIdentity.ps1',
    'private/DocumentValidation.ps1', 'private/AdapterConfig.ps1', 'private/DiffEngine.ps1',
    'private/ProcessRunner.ps1', 'private/Acquisition.ps1', 'private/StateFiles.ps1',
    'private/Consumption.ps1', 'private/TurnContext.ps1', 'private/StateEvents.ps1',
    'private/StateEventStorage.ps1', 'private/Watcher.ps1', 'private/WalkProtocol.ps1')

# Bootstrap source admission must run before the shared protocol is imported.
function Read-BoundFile {
    param([string] $Root, [string] $Target, [int] $MaximumBytes)
    $before = [Companion.Runtime.NativeFiles]::AdmitWithin($Root, $Target, $false)
    if (-not $before.Exists -or $before.IsDirectory -or $before.Links -ne 1) { throw [IO.IOException]::new('Source admission failed.') }
    $bytes = [Companion.Runtime.JsonDocuments]::ReadBounded($before.Path, $MaximumBytes)
    $after = [Companion.Runtime.NativeFiles]::AdmitWithin($Root, $Target, $false)
    if (-not $after.Exists -or $after.IsDirectory -or $after.Links -ne 1 -or
        [string]::CompareOrdinal($before.Volume, $after.Volume) -ne 0 -or
        [string]::CompareOrdinal($before.Identity, $after.Identity) -ne 0) {
        throw [IO.IOException]::new('Source changed during admission.')
    }
    $again = [Companion.Runtime.JsonDocuments]::ReadBounded($after.Path, $MaximumBytes)
    if ($again.Length -ne $bytes.Length -or -not [Collections.StructuralComparisons]::StructuralEqualityComparer.Equals($bytes, $again)) {
        throw [IO.IOException]::new('Source changed during observation.')
    }

    return ,$bytes
}

function Add-BundleSource {
    param([IO.MemoryStream] $Bundle, [string] $Root, [string] $Target)
    $bytes = Read-BoundFile -Root $Root -Target $Target -MaximumBytes 1048576
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
    $bundle = [IO.MemoryStream]::new()
    try {
        foreach ($name in $runtimeNames) { Add-BundleSource -Bundle $bundle -Root $SourceRoot -Target (Join-Path $PSScriptRoot $name) }
        $coreRoot = Join-Path $CompanionRoot 'core'
        foreach ($name in $coreNames) { Add-BundleSource -Bundle $bundle -Root $CompanionRoot -Target (Join-Path $coreRoot $name) }

        return [Convert]::ToHexStringLower([Security.Cryptography.SHA256]::HashData($bundle.ToArray()))
    }
    finally { $bundle.Dispose() }
}

try {
    if (-not $IsWindows -or $Nonce -cnotmatch '^[a-f0-9]{32}$') { throw [IO.InvalidDataException]::new('Invalid worker startup.') }
    $sourceLocks = [Collections.Generic.List[IO.FileStream]]::new()
    try {
        foreach ($name in $runtimeNames) {
            $sourceLocks.Add([IO.FileStream]::new((Join-Path $PSScriptRoot $name), [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read))
        }
        $coreRoot = Join-Path $CompanionRoot 'core'
        foreach ($name in $coreNames) {
            $sourceLocks.Add([IO.FileStream]::new((Join-Path $coreRoot $name), [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read))
        }
        $sources = @('NativeFiles.cs', 'JsonDocuments.cs', 'EventDocuments.cs', 'PayloadCodec.cs', 'RuntimeFilePublication.cs', 'RuntimeCodec.cs')
        Add-Type -Path @($sources | ForEach-Object { Join-Path $PSScriptRoot $_ })
        $admittedData = [Companion.Runtime.NativeFiles]::AdmitWithin($CompanionRoot, $DataRoot, $false)
        $admittedSources = [Companion.Runtime.NativeFiles]::AdmitWithin($SourceRoot, $PSScriptRoot, $false)
        if (-not $admittedData.IsDirectory -or -not $admittedSources.IsDirectory) { throw [IO.IOException]::new('Worker scope is unavailable.') }
        $scopeBytes = Read-BoundFile -Root $CompanionRoot -Target (Join-Path $DataRoot 'scope.json') -MaximumBytes 1048576
        $scopeSha256 = [Convert]::ToHexStringLower([Security.Cryptography.SHA256]::HashData($scopeBytes))
        $protocolPath = Join-Path $PSScriptRoot 'StartupWorkerProtocol.ps1'
        $protocolBefore = Read-BoundFile -Root $SourceRoot -Target $protocolPath -MaximumBytes 1048576
        . $protocolPath
        $protocolAfter = Read-BoundFile -Root $SourceRoot -Target $protocolPath -MaximumBytes 1048576
        if (-not [Collections.StructuralComparisons]::StructuralEqualityComparer.Equals($protocolBefore, $protocolAfter)) {
            throw [IO.IOException]::new('Worker protocol changed during import.')
        }
        $validationPath = Join-Path $PSScriptRoot 'CoreReplyValidation.ps1'
        $validationBefore = Read-BoundFile -Root $SourceRoot -Target $validationPath -MaximumBytes 1048576
        . $validationPath
        $validationAfter = Read-BoundFile -Root $SourceRoot -Target $validationPath -MaximumBytes 1048576
        if (-not [Collections.StructuralComparisons]::StructuralEqualityComparer.Equals($validationBefore, $validationAfter)) {
            throw [IO.IOException]::new('Core validation changed during import.')
        }
        $beforeImport = Get-BundleHash
        $modulePath = Join-Path $CompanionRoot 'core/DigestDiff.psm1'
        $module = [Companion.Runtime.NativeFiles]::AdmitWithin($CompanionRoot, $modulePath, $false)
        if ($module.IsDirectory) { throw [IO.IOException]::new('Core module is not an ordinary file.') }
        Import-Module $module.Path -Force -DisableNameChecking
        $sourceSha256 = Get-BundleHash
        if ($sourceSha256 -cne $beforeImport) { throw [IO.IOException]::new('Core source changed during import.') }
    }
    finally { foreach ($held in $sourceLocks) { $held.Dispose() } }
    Write-Frame -Text (ConvertTo-Json -InputObject ([ordered]@{ version = 1; nonce = $Nonce; scopeSha256 = $scopeSha256; sourceSha256 = $sourceSha256 }) -Compress)

    $seenIds = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    while ($null -ne ($text = Read-Frame)) {
        $watch = [Diagnostics.Stopwatch]::StartNew()
        if ((Get-BundleHash) -cne $sourceSha256) { throw [IO.IOException]::new('Worker source changed.') }
        $document = [Text.Json.JsonDocument]::Parse($text)
        try {
            $request = $document.RootElement
            Assert-ExactFields -Element $request -Names @('version', 'id', 'op', 'root', 'remainingMs', 'operation', 'exitCode', 'stdout', 'stderr')
            if ((Read-Integer -Element ($request.GetProperty('version'))) -ne 1 -or
                (Read-String -Element ($request.GetProperty('op'))) -cne 'validateCore') {
                throw [IO.InvalidDataException]::new('Invalid core validation operation.')
            }
            $id = Read-String -Element ($request.GetProperty('id'))
            if ($id -cnotmatch '^[a-f0-9]{32}$' -or -not $seenIds.Add($id) -or $seenIds.Count -gt 8192) {
                throw [IO.InvalidDataException]::new('Invalid request identity.')
            }
            $root = Read-String -Element ($request.GetProperty('root'))
            $admittedRoot = [Companion.Runtime.NativeFiles]::AdmitWithin($CompanionRoot, $root, $false)
            if ([string]::CompareOrdinal($root, $CompanionRoot) -ne 0 -or -not $admittedRoot.IsDirectory) {
                throw [IO.InvalidDataException]::new('Invalid request root.')
            }
            $remainingMs = Read-Integer -Element ($request.GetProperty('remainingMs'))
            if ($remainingMs -lt 1 -or $remainingMs -gt 30000) { throw [IO.InvalidDataException]::new('Invalid request deadline.') }
            $operation = Read-String -Element ($request.GetProperty('operation'))
            if ($operation -cnotin @('Publish', 'Settlement', 'Consumer')) { throw [IO.InvalidDataException]::new('Invalid core operation.') }
            $exitCode = Read-Integer -Element ($request.GetProperty('exitCode'))
            if ($exitCode -cnotin @(0, 1)) { throw [IO.InvalidDataException]::new('Invalid core exit code.') }
            $stdout = Read-String -Element ($request.GetProperty('stdout'))
            $stderr = Read-String -Element ($request.GetProperty('stderr'))
            if ($utf8.GetByteCount($stdout) -gt 65536 -or $utf8.GetByteCount($stderr) -gt 65536) {
                throw [IO.InvalidDataException]::new('Core stream exceeds its capture bound.')
            }
            if ($watch.ElapsedMilliseconds -ge $remainingMs) { throw [TimeoutException]::new('Core validation deadline expired.') }
            $control = ConvertTo-Json -InputObject ([ordered]@{ exitCode = $exitCode; stdout = $stdout; stderr = $stderr }) -Compress
            $validationFailed = $false
            try {
                $reply = Convert-CoreReply -Operation $operation -InputBytes ($utf8.GetBytes($control))
            }
            catch {
                if ($_.Exception -is [TimeoutException]) { throw }
                $validationFailed = $true
            }
            if ($watch.ElapsedMilliseconds -ge $remainingMs) { throw [TimeoutException]::new('Core validation deadline expired.') }
            if ($validationFailed) { Write-WorkerReply -Id $id -Operation 'validateCore' -Status 'error' -ResultJson $null -Code 'coreReplyInvalid' }
            else { Write-WorkerReply -Id $id -Operation 'validateCore' -Status 'ok' -ResultJson $reply -Code $null }
        }
        finally { $document.Dispose() }
    }
    exit 0
}
catch {
    [Console]::Error.WriteLine("${scriptName}: startup-core-reply-unavailable")
    exit 1
}
