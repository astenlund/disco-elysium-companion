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
$sourceNames = @('StartupMutationWorker.ps1', 'StartupWorkerProtocol.ps1', 'Write-RuntimeFile.ps1',
    'Invoke-PayloadCodec.ps1', 'NativeFiles.cs', 'JsonDocuments.cs', 'EventDocuments.cs',
    'PayloadCodec.cs', 'RuntimeFilePublication.cs', 'RuntimeCodec.cs')

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

function Get-BundleHash {
    $bundle = [IO.MemoryStream]::new()
    try {
        foreach ($name in $sourceNames) {
            $bytes = Read-BoundFile -Root $SourceRoot -Target (Join-Path $PSScriptRoot $name) -MaximumBytes 1048576
            $length = $bytes.Length
            $header = [byte[]]::new(4)
            $header[0] = [byte](($length -shr 24) -band 255)
            $header[1] = [byte](($length -shr 16) -band 255)
            $header[2] = [byte](($length -shr 8) -band 255)
            $header[3] = [byte]($length -band 255)
            $bundle.Write($header, 0, 4)
            $bundle.Write($bytes, 0, $length)
        }

        return [Convert]::ToHexStringLower([Security.Cryptography.SHA256]::HashData($bundle.ToArray()))
    }
    finally { $bundle.Dispose() }
}

function Read-Boolean {
    param([Text.Json.JsonElement] $Element)
    if ($Element.ValueKind -ne [Text.Json.JsonValueKind]::True -and $Element.ValueKind -ne [Text.Json.JsonValueKind]::False) {
        throw [IO.InvalidDataException]::new('Expected a Boolean.')
    }

    return $Element.GetBoolean()
}

try {
    if (-not $IsWindows -or $Nonce -cnotmatch '^[a-f0-9]{32}$') { throw [IO.InvalidDataException]::new('Invalid worker startup.') }
    $nativeNames = @('NativeFiles.cs', 'JsonDocuments.cs', 'EventDocuments.cs', 'PayloadCodec.cs', 'RuntimeFilePublication.cs', 'RuntimeCodec.cs')
    Add-Type -Path @($nativeNames | ForEach-Object { Join-Path $PSScriptRoot $_ })
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
    $sourceSha256 = Get-BundleHash
    Write-Frame -Text (ConvertTo-Json -InputObject ([ordered]@{ version = 1; nonce = $Nonce; scopeSha256 = $scopeSha256; sourceSha256 = $sourceSha256 }) -Compress)

    $seenIds = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    while ($null -ne ($text = Read-Frame)) {
        $document = [Text.Json.JsonDocument]::Parse($text)
        try {
            $request = $document.RootElement
            if ($request.ValueKind -ne [Text.Json.JsonValueKind]::Object) { throw [IO.InvalidDataException]::new('Invalid mutation request.') }
            $operation = Read-String -Element ($request.GetProperty('op'))
            if ($operation -ceq 'publish') {
                Assert-ExactFields -Element $request -Names @('version', 'id', 'op', 'root', 'remainingMs', 'target', 'inputFile', 'inputSha256', 'profile', 'createOnly')
            }
            elseif ($operation -ceq 'codec') {
                Assert-ExactFields -Element $request -Names @('version', 'id', 'op', 'root', 'remainingMs', 'target', 'inputFile', 'inputSha256', 'controlFile', 'controlSha256', 'verifyOnly', 'preview')
            }
            else { throw [IO.InvalidDataException]::new('Invalid mutation operation.') }
            if ((Read-Integer -Element ($request.GetProperty('version'))) -ne 1) { throw [IO.InvalidDataException]::new('Invalid request version.') }
            $id = Read-String -Element ($request.GetProperty('id'))
            if ($id -cnotmatch '^[a-f0-9]{32}$' -or -not $seenIds.Add($id) -or $seenIds.Count -gt 8192) {
                throw [IO.InvalidDataException]::new('Invalid request identity.')
            }
            $root = Read-String -Element ($request.GetProperty('root'))
            $admittedRoot = [Companion.Runtime.NativeFiles]::AdmitWithin($CompanionRoot, $root, $false)
            if ([string]::CompareOrdinal($root, $DataRoot) -ne 0 -or -not $admittedRoot.IsDirectory) {
                throw [IO.InvalidDataException]::new('Invalid request root.')
            }
            $remainingMs = Read-Integer -Element ($request.GetProperty('remainingMs'))
            if ($remainingMs -lt 1 -or $remainingMs -gt 30000) { throw [IO.InvalidDataException]::new('Invalid request deadline.') }
            $target = Read-String -Element ($request.GetProperty('target'))
            $inputFile = Read-String -Element ($request.GetProperty('inputFile'))
            $inputSha256 = Read-String -Element ($request.GetProperty('inputSha256'))
            if ($inputSha256 -cnotmatch '^[a-f0-9]{64}$') { throw [IO.InvalidDataException]::new('Invalid staged-input hash.') }
            $watch = [Diagnostics.Stopwatch]::StartNew()
            if ((Get-BundleHash) -cne $sourceSha256) { throw [IO.IOException]::new('Worker source changed.') }
            if ($watch.ElapsedMilliseconds -ge $remainingMs) { throw [TimeoutException]::new('Mutation deadline expired.') }
            if ($operation -ceq 'publish') {
                $profile = Read-String -Element ($request.GetProperty('profile'))
                if ($profile -cnotin @('config', 'state-event')) { throw [IO.InvalidDataException]::new('Invalid publication profile.') }
                $createOnly = Read-Boolean -Element ($request.GetProperty('createOnly'))
                try {
                    $publication = [Companion.Runtime.RuntimeFilePublication]::Publish($root, $target, $inputFile, $inputSha256, $profile, $createOnly)
                    $result = [ordered]@{ published = $true; sha256 = $publication.Sha256;
                        cleanupComplete = $publication.RetainedSiblings.Length -eq 0; retainedSiblings = @($publication.RetainedSiblings) }
                    $reply = ConvertTo-Json -InputObject $result -Depth 8 -Compress
                    $code = $null
                }
                catch { $reply = $null; $code = 'publicationFailed' }
            }
            else {
                $controlFile = Read-String -Element ($request.GetProperty('controlFile'))
                $controlSha256 = Read-String -Element ($request.GetProperty('controlSha256'))
                if ($controlSha256 -cnotmatch '^[a-f0-9]{64}$') { throw [IO.InvalidDataException]::new('Invalid staged-control hash.') }
                $verifyOnly = Read-Boolean -Element ($request.GetProperty('verifyOnly'))
                $preview = Read-Boolean -Element ($request.GetProperty('preview'))
                try {
                    $resultBytes = [Companion.Runtime.RuntimeCodec]::Execute($root, $target, $inputFile, $inputSha256,
                        $controlFile, $controlSha256, $verifyOnly, $preview)
                    $reply = $utf8.GetString($resultBytes)
                    $code = $null
                }
                catch {
                    $exception = $_.Exception
                    while ($null -ne $exception.InnerException) { $exception = $exception.InnerException }
                    $code = if ($exception.GetType().Name -ceq 'DocumentInvalidException') { 'documentInvalid' } else { 'codecUnavailable' }
                    $reply = $null
                }
            }
            if ($watch.ElapsedMilliseconds -ge $remainingMs) { throw [TimeoutException]::new('Mutation deadline expired.') }
            if ($null -eq $code) { Write-WorkerReply -Id $id -Operation $operation -Status 'ok' -ResultJson $reply -Code $null }
            else { Write-WorkerReply -Id $id -Operation $operation -Status 'error' -ResultJson $null -Code $code }
        }
        finally { $document.Dispose() }
    }
    exit 0
}
catch {
    [Console]::Error.WriteLine("${scriptName}: startup-mutation-unavailable")
    exit 1
}
