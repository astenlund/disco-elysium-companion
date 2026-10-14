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

function Read-Frame {
    $header = [byte[]]::new(4)
    $count = $inputStream.Read($header, 0, 4)
    if ($count -eq 0) { return $null }
    while ($count -lt 4) {
        $read = $inputStream.Read($header, $count, 4 - $count)
        if ($read -eq 0) { throw [IO.EndOfStreamException]::new('Incomplete frame header.') }
        $count += $read
    }
    $length = ([int]$header[0] -shl 24) -bor ([int]$header[1] -shl 16) -bor ([int]$header[2] -shl 8) -bor [int]$header[3]
    if ($length -lt 1 -or $length -gt $maximumInputFrame) { throw [IO.InvalidDataException]::new('Invalid frame length.') }
    $body = [byte[]]::new($length)
    $count = 0
    while ($count -lt $length) {
        $read = $inputStream.Read($body, $count, $length - $count)
        if ($read -eq 0) { throw [IO.EndOfStreamException]::new('Incomplete frame body.') }
        $count += $read
    }

    return $utf8.GetString($body)
}

function Write-Frame {
    param([Parameter(Mandatory)] [string] $Text)
    $body = $utf8.GetBytes($Text)
    $length = $body.Length
    if ($length -lt 1 -or $length -gt $maximumOutputFrame) { throw [IO.InvalidDataException]::new('Output frame exceeds its bound.') }
    $header = [byte[]]::new(4)
    $header[0] = [byte](($length -shr 24) -band 255)
    $header[1] = [byte](($length -shr 16) -band 255)
    $header[2] = [byte](($length -shr 8) -band 255)
    $header[3] = [byte]($length -band 255)
    $outputStream.Write($header, 0, 4)
    $outputStream.Write($body, 0, $length)
    $outputStream.Flush()
}

function Assert-ExactFields {
    param([Text.Json.JsonElement] $Element, [string[]] $Names)
    if ($Element.ValueKind -ne [Text.Json.JsonValueKind]::Object) { throw [IO.InvalidDataException]::new('Expected an object.') }
    $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($property in $Element.EnumerateObject()) {
        if (-not $seen.Add($property.Name)) { throw [IO.InvalidDataException]::new('Duplicate field.') }
    }
    if ($seen.Count -ne $Names.Length) { throw [IO.InvalidDataException]::new('Incorrect field count.') }
    foreach ($name in $Names) {
        if (-not $seen.Contains($name)) { throw [IO.InvalidDataException]::new('Missing field.') }
    }
}

function Read-String {
    param([Text.Json.JsonElement] $Element)
    if ($Element.ValueKind -ne [Text.Json.JsonValueKind]::String) { throw [IO.InvalidDataException]::new('Expected a string.') }
    $value = $Element.GetString()
    if ($null -eq $value) { throw [IO.InvalidDataException]::new('Expected a non-null string.') }

    return $value
}

function Read-Integer {
    param([Text.Json.JsonElement] $Element)
    $value = 0
    if ($Element.ValueKind -ne [Text.Json.JsonValueKind]::Number -or -not $Element.TryGetInt32([ref] $value)) {
        throw [IO.InvalidDataException]::new('Expected an integral number.')
    }

    return $value
}

function Read-BoundFile {
    param([string] $Root, [string] $Target, [int] $MaximumBytes)
    $before = [Companion.Runtime.NativeFiles]::AdmitWithin($Root, $Target, $false)
    if (-not $before.Exists -or $before.IsDirectory -or $before.Links -ne 1) { throw [IO.IOException]::new('Source admission failed.') }
    $bytes = [Companion.Runtime.JsonDocuments]::ReadBounded($before.Path, $MaximumBytes)
    $after = [Companion.Runtime.NativeFiles]::AdmitWithin($Root, $Target, $false)
    if ([string]::CompareOrdinal($before.Volume, $after.Volume) -ne 0 -or [string]::CompareOrdinal($before.Identity, $after.Identity) -ne 0 -or $after.Links -ne 1) {
        throw [IO.IOException]::new('Source changed during admission.')
    }
    $again = [Companion.Runtime.JsonDocuments]::ReadBounded($after.Path, $MaximumBytes)
    if ($again.Length -ne $bytes.Length -or -not [Collections.StructuralComparisons]::StructuralEqualityComparer.Equals($bytes, $again)) {
        throw [IO.IOException]::new('Source changed during observation.')
    }

    return ,$bytes
}

try {
    if (-not $IsWindows -or $Nonce -cnotmatch '^[a-f0-9]{32}$') { throw [IO.InvalidDataException]::new('Invalid worker startup.') }
    $sources = @('NativeFiles.cs', 'JsonDocuments.cs', 'FileHashes.cs', 'EventDocuments.cs', 'PayloadCodec.cs',
        'RuntimeFilePublication.cs', 'RuntimeCodec.cs', 'resource-lifecycle/ResourceInventory.cs')
    Add-Type -Path @($sources | ForEach-Object { Join-Path $PSScriptRoot $_ })
    $admittedData = [Companion.Runtime.NativeFiles]::AdmitWithin($CompanionRoot, $DataRoot, $false)
    if (-not $admittedData.IsDirectory) { throw [IO.IOException]::new('Runtime scope is unavailable.') }
    $admittedSources = [Companion.Runtime.NativeFiles]::AdmitWithin($SourceRoot, $PSScriptRoot, $false)
    if (-not $admittedSources.IsDirectory) { throw [IO.IOException]::new('Worker source root is unavailable.') }
    $scopeBytes = Read-BoundFile -Root $CompanionRoot -Target (Join-Path $DataRoot 'scope.json') -MaximumBytes 1048576
    $scopeSha256 = [Convert]::ToHexStringLower([Security.Cryptography.SHA256]::HashData($scopeBytes))
    $bundle = [IO.MemoryStream]::new()
    try {
        foreach ($name in @('StartupMetadataWorker.ps1', 'NativeFiles.cs', 'JsonDocuments.cs', 'FileHashes.cs',
            'EventDocuments.cs', 'PayloadCodec.cs', 'RuntimeFilePublication.cs', 'RuntimeCodec.cs', 'resource-lifecycle/ResourceInventory.cs')) {
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
        $sourceSha256 = [Convert]::ToHexStringLower([Security.Cryptography.SHA256]::HashData($bundle.ToArray()))
    }
    finally { $bundle.Dispose() }
    Write-Frame -Text (ConvertTo-Json -InputObject ([ordered]@{ version = 1; nonce = $Nonce; scopeSha256 = $scopeSha256; sourceSha256 = $sourceSha256 }) -Compress)

    $seenIds = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    while ($null -ne ($text = Read-Frame)) {
        $document = [Text.Json.JsonDocument]::Parse($text)
        try {
            $request = $document.RootElement
            if ($request.ValueKind -ne [Text.Json.JsonValueKind]::Object) { throw [IO.InvalidDataException]::new('Invalid request object.') }
            $operation = Read-String -Element ($request.GetProperty('op'))
            if ($operation -ceq 'admit') { Assert-ExactFields -Element $request -Names @('version', 'id', 'op', 'root', 'remainingMs', 'targets', 'allowMissing') }
            elseif ($operation -ceq 'hash') { Assert-ExactFields -Element $request -Names @('version', 'id', 'op', 'root', 'remainingMs', 'inputBase64', 'inputSha256', 'scopeSha256') }
            elseif ($operation -ceq 'inventory') { Assert-ExactFields -Element $request -Names @('version', 'id', 'op', 'root', 'remainingMs', 'mode', 'scopeSha256', 'companionRoot') }
            else { throw [IO.InvalidDataException]::new('Unknown worker operation.') }
            if ((Read-Integer -Element ($request.GetProperty('version'))) -ne 1) { throw [IO.InvalidDataException]::new('Invalid request version.') }
            $id = Read-String -Element ($request.GetProperty('id'))
            if ($id -cnotmatch '^[a-f0-9]{32}$' -or -not $seenIds.Add($id) -or $seenIds.Count -gt 8192) { throw [IO.InvalidDataException]::new('Invalid request identity.') }
            $root = Read-String -Element ($request.GetProperty('root'))
            if ([string]::IsNullOrEmpty($root)) { throw [IO.InvalidDataException]::new('Missing request root.') }
            $remainingMs = Read-Integer -Element ($request.GetProperty('remainingMs'))
            if ($remainingMs -lt 1 -or $remainingMs -gt 30000) { throw [IO.InvalidDataException]::new('Invalid request deadline.') }
            $admittedRoot = [Companion.Runtime.NativeFiles]::AdmitWithin($CompanionRoot, $root, $false)
            if (-not $admittedRoot.IsDirectory) { throw [IO.InvalidDataException]::new('Invalid request root.') }
            $watch = [Diagnostics.Stopwatch]::StartNew()
            if ($operation -ceq 'admit') {
                $targets = $request.GetProperty('targets')
                if ($targets.ValueKind -ne [Text.Json.JsonValueKind]::Array -or $targets.GetArrayLength() -lt 1 -or $targets.GetArrayLength() -gt 64 -or $utf8.GetByteCount($targets.GetRawText()) -gt 65536) {
                    throw [IO.InvalidDataException]::new('Invalid admission batch.')
                }
                $policy = $request.GetProperty('allowMissing')
                if ($policy.ValueKind -ne [Text.Json.JsonValueKind]::True -and $policy.ValueKind -ne [Text.Json.JsonValueKind]::False) {
                    throw [IO.InvalidDataException]::new('Invalid missing-path policy.')
                }
                $allowMissing = $policy.GetBoolean()
                $names = [Collections.Generic.List[string]]::new()
                foreach ($item in $targets.EnumerateArray()) { $names.Add((Read-String -Element $item)) }
                $paths = [Collections.Generic.List[object]]::new()
                $failed = $false
                try {
                    foreach ($target in $names) {
                        if ($watch.ElapsedMilliseconds -ge $remainingMs) { throw [TimeoutException]::new('Admission timed out.') }
                        $admission = [Companion.Runtime.NativeFiles]::AdmitWithin($root, $target, $allowMissing)
                        $kind = if (-not $admission.Exists) { $null } elseif ($admission.IsDirectory) { 'directory' } else { 'file' }
                        $paths.Add(([ordered]@{ path = $admission.Path; exists = $admission.Exists; kind = $kind; links = if ($admission.Exists) { $admission.Links } else { $null }; volume = if ($admission.Exists) { $admission.Volume } else { $null }; identity = if ($admission.Exists) { $admission.Identity } else { $null }; missing = @($admission.Missing) }))
                    }
                    if ($watch.ElapsedMilliseconds -ge $remainingMs) { throw [TimeoutException]::new('Admission timed out.') }
                    $result = ConvertTo-Json -InputObject ([ordered]@{ paths = @($paths.ToArray()) }) -Depth 8 -Compress
                }
                catch {
                    if ($_.Exception -is [TimeoutException]) { throw }
                    $failed = $true
                }
                if ($failed) { Write-Frame -Text ('{"version":1,"id":"' + $id + '","op":"admit","status":"error","code":"admissionUnavailable"}') }
                else { Write-Frame -Text ('{"version":1,"id":"' + $id + '","op":"admit","status":"ok","result":' + $result + '}') }
            }
            elseif ($operation -ceq 'hash') {
                $inputBase64 = Read-String -Element ($request.GetProperty('inputBase64'))
                $inputSha256 = Read-String -Element ($request.GetProperty('inputSha256'))
                if ($inputSha256 -cnotmatch '^[a-f0-9]{64}$') { throw [IO.InvalidDataException]::new('Invalid hash request digest.') }
                $inputBytes = [Convert]::FromBase64String($inputBase64)
                if ($inputBytes.Length -lt 1 -or $inputBytes.Length -gt 1048576 -or [string]::CompareOrdinal([Convert]::ToBase64String($inputBytes), $inputBase64) -ne 0 -or [string]::CompareOrdinal([Convert]::ToHexStringLower([Security.Cryptography.SHA256]::HashData($inputBytes)), $inputSha256) -ne 0) {
                    throw [IO.InvalidDataException]::new('Invalid hash request input.')
                }
                $scope = $request.GetProperty('scopeSha256')
                $boundScope = if ($scope.ValueKind -eq [Text.Json.JsonValueKind]::Null) { $null } else { Read-String -Element $scope }
                if ($null -ne $boundScope -and $boundScope -cnotmatch '^[a-f0-9]{64}$') { throw [IO.InvalidDataException]::new('Invalid hash scope.') }
                $source = [IO.MemoryStream]::new($inputBytes, $false)
                $failed = $false
                try {
                    if ($watch.ElapsedMilliseconds -ge $remainingMs) { throw [TimeoutException]::new('Hash timed out.') }
                    $reply = if ($null -eq $boundScope) { [Companion.Runtime.FileHashes]::Read($root, $source) } else { [Companion.Runtime.FileHashes]::Read($root, $source, $boundScope) }
                    if ($watch.ElapsedMilliseconds -ge $remainingMs) { throw [TimeoutException]::new('Hash timed out.') }
                    $result = $utf8.GetString($reply)
                    $parsed = [Text.Json.JsonDocument]::Parse($result)
                    try { $result = $parsed.RootElement.GetRawText() }
                    finally { $parsed.Dispose() }
                }
                catch {
                    if ($_.Exception -is [TimeoutException]) { throw }
                    $failed = $true
                }
                finally { $source.Dispose() }
                if ($failed) { Write-Frame -Text ('{"version":1,"id":"' + $id + '","op":"hash","status":"error","code":"hashUnavailable"}') }
                else { Write-Frame -Text ('{"version":1,"id":"' + $id + '","op":"hash","status":"ok","result":' + $result + '}') }
            }
            else {
                $mode = Read-String -Element ($request.GetProperty('mode'))
                $requestScopeSha256 = Read-String -Element ($request.GetProperty('scopeSha256'))
                $requestCompanionRoot = Read-String -Element ($request.GetProperty('companionRoot'))
                if (($mode -cne 'Inventory' -and $mode -cne 'Marker') -or
                    [string]::CompareOrdinal($root, $DataRoot) -ne 0 -or
                    [string]::CompareOrdinal($requestScopeSha256, $scopeSha256) -ne 0 -or
                    [string]::CompareOrdinal($requestCompanionRoot, $CompanionRoot) -ne 0) {
                    throw [IO.InvalidDataException]::new('Inventory scope or mode is invalid.')
                }
                $failed = $false
                try {
                    if ($watch.ElapsedMilliseconds -ge $remainingMs) { throw [TimeoutException]::new('Inventory timed out.') }
                    $reply = [Companion.Runtime.ResourceInventory]::Read($root, $scopeSha256, ($mode -ceq 'Marker'), $CompanionRoot)
                }
                catch {
                    if ($_.Exception -is [TimeoutException]) { throw }
                    $failed = $true
                }
                if ($watch.ElapsedMilliseconds -ge $remainingMs) { throw [TimeoutException]::new('Inventory timed out.') }
                if ($failed) { Write-Frame -Text ('{"version":1,"id":"' + $id + '","op":"inventory","status":"error","code":"inventoryUnavailable"}') }
                else {
                    $result = $utf8.GetString($reply)
                    $parsed = [Text.Json.JsonDocument]::Parse($result)
                    try {
                        if ($parsed.RootElement.ValueKind -ne [Text.Json.JsonValueKind]::Object) { throw [IO.InvalidDataException]::new('Inventory result is invalid.') }
                        $result = $parsed.RootElement.GetRawText()
                    }
                    finally { $parsed.Dispose() }
                    Write-Frame -Text ('{"version":1,"id":"' + $id + '","op":"inventory","status":"ok","result":' + $result + '}')
                }
            }
        }
        finally { $document.Dispose() }
    }
    exit 0
}
catch {
    [Console]::Error.WriteLine("${scriptName}: startup-metadata-unavailable")
    exit 1
}
