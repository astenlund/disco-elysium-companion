#Requires -Version 7.5
[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string] $CompanionRoot,
    [Parameter(Mandatory)] [string] $DataRoot,
    [Parameter(Mandatory)] [string] $SourceRoot,
    [Parameter(Mandatory)] [string] $JobScopeToken,
    [Parameter(Mandatory)] [string] $Nonce
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$scriptName = [IO.Path]::GetFileNameWithoutExtension($PSCommandPath)
$utf8 = [Text.UTF8Encoding]::new($false, $true)
$inputStream = [Console]::OpenStandardInput()
$outputStream = [Console]::OpenStandardOutput()
$maximumInputFrame = 2097152
$maximumOutputFrame = 131072
$sourceNames = @('StartupMetadataWorker.ps1', 'StartupWorkerProtocol.ps1', 'NativeFiles.cs', 'NativeJobs.cs', 'JsonDocuments.cs', 'FileHashes.cs',
    'EventDocuments.cs', 'EventInspection.cs', 'PayloadCodec.cs', 'RuntimeFilePublication.cs', 'RuntimeCodec.cs', 'resource-lifecycle/ResourceInventory.cs')
$coreReplyNames = @('StartupCoreReplyWorker.ps1', 'StartupWorkerProtocol.ps1', 'Read-CoreReply.ps1',
    'CoreReplyValidation.ps1', 'NativeFiles.cs', 'JsonDocuments.cs', 'EventDocuments.cs',
    'PayloadCodec.cs', 'RuntimeFilePublication.cs', 'RuntimeCodec.cs')
$mutationNames = @('StartupMutationWorker.ps1', 'StartupWorkerProtocol.ps1', 'Write-RuntimeFile.ps1',
    'Invoke-PayloadCodec.ps1', 'NativeFiles.cs', 'JsonDocuments.cs', 'EventDocuments.cs',
    'PayloadCodec.cs', 'RuntimeFilePublication.cs', 'RuntimeCodec.cs', 'resource-lifecycle/ResourceInventory.cs')
$coreNames = @('DigestDiff.psm1', 'private/CompanionJson.ps1', 'private/SourceIdentity.ps1',
    'private/DocumentValidation.ps1', 'private/AdapterConfig.ps1', 'private/DiffEngine.ps1',
    'private/ProcessRunner.ps1', 'private/Acquisition.ps1', 'private/StateFiles.ps1',
    'private/Consumption.ps1', 'private/TurnContext.ps1', 'private/StateEvents.ps1',
    'private/StateEventStorage.ps1', 'private/Watcher.ps1', 'private/WalkProtocol.ps1')

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

function Get-BundleHash {
    param([string[]] $RuntimeNames = $sourceNames, [string[]] $CoreNames = @())
    $bundle = [IO.MemoryStream]::new()
    try {
        $entries = @($RuntimeNames | ForEach-Object { [pscustomobject]@{ root = $SourceRoot; target = Join-Path $PSScriptRoot $_ } }) +
            @($CoreNames | ForEach-Object { [pscustomobject]@{ root = $CompanionRoot; target = Join-Path (Join-Path $CompanionRoot 'core') $_ } })
        foreach ($item in $entries) {
            $bytes = Read-BoundFile -Root $item.root -Target $item.target -MaximumBytes 1048576
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

function Read-ControlBytes {
    param([Text.Json.JsonElement] $Request)
    $inputBase64 = Read-String -Element ($Request.GetProperty('inputBase64'))
    $inputSha256 = Read-String -Element ($Request.GetProperty('inputSha256'))
    if ($inputSha256 -cnotmatch '^[a-f0-9]{64}$') { throw [IO.InvalidDataException]::new('Invalid worker input digest.') }
    $inputBytes = [Convert]::FromBase64String($inputBase64)
    if ($inputBytes.Length -lt 1 -or $inputBytes.Length -gt 1048576 -or
        [string]::CompareOrdinal([Convert]::ToBase64String($inputBytes), $inputBase64) -ne 0 -or
        [string]::CompareOrdinal([Convert]::ToHexStringLower([Security.Cryptography.SHA256]::HashData($inputBytes)), $inputSha256) -ne 0) {
        throw [IO.InvalidDataException]::new('Invalid worker input.')
    }

    return ,$inputBytes
}

try {
    if (-not $IsWindows -or $Nonce -cnotmatch '^[a-f0-9]{32}$') { throw [IO.InvalidDataException]::new('Invalid worker startup.') }
    $sourceLocks = [Collections.Generic.List[IO.FileStream]]::new()
    try {
        foreach ($name in $sourceNames) {
            $sourceLocks.Add([IO.FileStream]::new((Join-Path $PSScriptRoot $name), [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read))
        }
        $sources = @('NativeFiles.cs', 'NativeJobs.cs', 'JsonDocuments.cs', 'FileHashes.cs', 'EventDocuments.cs', 'EventInspection.cs', 'PayloadCodec.cs',
            'RuntimeFilePublication.cs', 'RuntimeCodec.cs', 'resource-lifecycle/ResourceInventory.cs')
        Add-Type -Path @($sources | ForEach-Object { Join-Path $PSScriptRoot $_ })
        $admittedData = [Companion.Runtime.NativeFiles]::AdmitWithin($CompanionRoot, $DataRoot, $false)
        if (-not $admittedData.IsDirectory) { throw [IO.IOException]::new('Runtime scope is unavailable.') }
        $admittedSources = [Companion.Runtime.NativeFiles]::AdmitWithin($SourceRoot, $PSScriptRoot, $false)
        if (-not $admittedSources.IsDirectory) { throw [IO.IOException]::new('Worker source root is unavailable.') }
        $protocolPath = Join-Path $PSScriptRoot 'StartupWorkerProtocol.ps1'
        $protocolBefore = Read-BoundFile -Root $SourceRoot -Target $protocolPath -MaximumBytes 1048576
        . $protocolPath
        $protocolAfter = Read-BoundFile -Root $SourceRoot -Target $protocolPath -MaximumBytes 1048576
        if (-not [Collections.StructuralComparisons]::StructuralEqualityComparer.Equals($protocolBefore, $protocolAfter)) {
            throw [IO.IOException]::new('Worker protocol changed during import.')
        }
        $scopeBytes = Read-BoundFile -Root $CompanionRoot -Target (Join-Path $DataRoot 'scope.json') -MaximumBytes 1048576
        $scopeSha256 = [Convert]::ToHexStringLower([Security.Cryptography.SHA256]::HashData($scopeBytes))
        # Node names the jobs, so it supplies the token rather than this worker recomputing it under .NET casing rules.
        if ($JobScopeToken -cnotmatch '\A[a-f0-9]{32}\z') { throw [IO.InvalidDataException]::new('Job scope token is invalid.') }
        $jobPrefix = 'Global' + [char]92 + 'game-companion-process-' + $JobScopeToken + '-'
        $sourceSha256 = Get-BundleHash
    }
    finally { foreach ($held in $sourceLocks) { $held.Dispose() } }
    Write-Frame -Text (ConvertTo-Json -InputObject ([ordered]@{ version = 1; nonce = $Nonce; scopeSha256 = $scopeSha256; sourceSha256 = $sourceSha256 }) -Compress)

    $seenIds = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    while ($null -ne ($text = Read-Frame)) {
        $watch = [Diagnostics.Stopwatch]::StartNew()
        $currentSourceSha256 = Get-BundleHash
        if ($currentSourceSha256 -cne $sourceSha256) { throw [IO.IOException]::new('Worker source changed.') }
        $document = [Text.Json.JsonDocument]::Parse($text)
        try {
            $request = $document.RootElement
            if ($request.ValueKind -ne [Text.Json.JsonValueKind]::Object) { throw [IO.InvalidDataException]::new('Invalid request object.') }
            $operation = Read-String -Element ($request.GetProperty('op'))
            if ($operation -ceq 'admit') { Assert-ExactFields -Element $request -Names @('version', 'id', 'op', 'root', 'remainingMs', 'targets', 'allowMissing') }
            elseif ($operation -ceq 'hash') { Assert-ExactFields -Element $request -Names @('version', 'id', 'op', 'root', 'remainingMs', 'inputBase64', 'inputSha256', 'scopeSha256') }
            elseif ($operation -ceq 'inventory') { Assert-ExactFields -Element $request -Names @('version', 'id', 'op', 'root', 'remainingMs', 'mode', 'scopeSha256', 'companionRoot') }
            elseif ($operation -ceq 'eventBatch') { Assert-ExactFields -Element $request -Names @('version', 'id', 'op', 'root', 'remainingMs', 'scopeSha256', 'inputBase64', 'inputSha256') }
            elseif ($operation -ceq 'sourceEvidence') { Assert-ExactFields -Element $request -Names @('version', 'id', 'op', 'root', 'remainingMs', 'scopeSha256') }
            elseif ($operation -ceq 'jobBatch') { Assert-ExactFields -Element $request -Names @('version', 'id', 'op', 'root', 'remainingMs', 'scopeSha256', 'names') }
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
            if ($watch.ElapsedMilliseconds -ge $remainingMs) { throw [TimeoutException]::new('Metadata deadline expired.') }
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
                $inputBytes = Read-ControlBytes -Request $request
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
            elseif ($operation -ceq 'sourceEvidence') {
                $requestScopeSha256 = Read-String -Element ($request.GetProperty('scopeSha256'))
                if ([string]::CompareOrdinal($root, $DataRoot) -ne 0 -or [string]::CompareOrdinal($requestScopeSha256, $scopeSha256) -ne 0) {
                    throw [IO.InvalidDataException]::new('Source proof scope is invalid.')
                }
                $failed = $false
                try {
                    if ($watch.ElapsedMilliseconds -ge $remainingMs) { throw [TimeoutException]::new('Source proof timed out.') }
                    $scopeBytes = Read-BoundFile -Root $CompanionRoot -Target (Join-Path $DataRoot 'scope.json') -MaximumBytes 1048576
                    $freshScope = [Convert]::ToHexStringLower([Security.Cryptography.SHA256]::HashData($scopeBytes))
                    if ($freshScope -cne $scopeSha256) { throw [IO.IOException]::new('Source proof binding changed.') }
                    $coreReplySha256 = Get-BundleHash -RuntimeNames $coreReplyNames -CoreNames $coreNames
                    $mutationSha256 = Get-BundleHash -RuntimeNames $mutationNames
                    $result = ConvertTo-Json -InputObject ([ordered]@{ scopeSha256 = $freshScope; metadataSha256 = $currentSourceSha256;
                        coreReplySha256 = $coreReplySha256; mutationSha256 = $mutationSha256 }) -Compress
                    if ($watch.ElapsedMilliseconds -ge $remainingMs) { throw [TimeoutException]::new('Source proof timed out.') }
                }
                catch {
                    if ($_.Exception -is [TimeoutException]) { throw }
                    $failed = $true
                }
                if ($failed) { Write-WorkerReply -Id $id -Operation $operation -Status 'error' -ResultJson $null -Code 'sourceUnavailable' }
                else { Write-WorkerReply -Id $id -Operation $operation -Status 'ok' -ResultJson $result -Code $null }
            }
            elseif ($operation -ceq 'jobBatch') {
                $requestScopeSha256 = Read-String -Element ($request.GetProperty('scopeSha256'))
                if ([string]::CompareOrdinal($root, $DataRoot) -ne 0 -or [string]::CompareOrdinal($requestScopeSha256, $scopeSha256) -ne 0) {
                    throw [IO.InvalidDataException]::new('Job proof scope is invalid.')
                }
                $names = $request.GetProperty('names')
                if ($names.ValueKind -ne [Text.Json.JsonValueKind]::Array -or $names.GetArrayLength() -lt 1 -or $names.GetArrayLength() -gt 8) {
                    throw [IO.InvalidDataException]::new('Invalid job proof batch.')
                }
                $seenNames = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
                $jobs = [Collections.Generic.List[object]]::new()
                $failed = $false
                try {
                    foreach ($item in $names.EnumerateArray()) {
                        if ($watch.ElapsedMilliseconds -ge $remainingMs) { throw [TimeoutException]::new('Job proof timed out.') }
                        $name = Read-String -Element $item
                        if (-not $name.StartsWith($jobPrefix, [StringComparison]::Ordinal) -or -not $seenNames.Add($name)) {
                            throw [IO.InvalidDataException]::new('Invalid job proof name.')
                        }
                        $count = [Companion.Runtime.NativeJobs]::Observe($name)
                        $jobs.Add(([ordered]@{ name = $name; state = if ($null -eq $count) { 'absent' } else { 'present' }; processes = $count }))
                    }
                    if ($watch.ElapsedMilliseconds -ge $remainingMs) { throw [TimeoutException]::new('Job proof timed out.') }
                    $result = ConvertTo-Json -InputObject ([ordered]@{ jobs = @($jobs.ToArray()) }) -Depth 4 -Compress
                }
                catch {
                    if ($_.Exception -is [TimeoutException]) { throw }
                    $failed = $true
                }
                if ($failed) { Write-WorkerReply -Id $id -Operation $operation -Status 'error' -ResultJson $null -Code 'jobUnavailable' }
                else { Write-WorkerReply -Id $id -Operation $operation -Status 'ok' -ResultJson $result -Code $null }
            }
            elseif ($operation -ceq 'eventBatch') {
                $requestScopeSha256 = Read-String -Element ($request.GetProperty('scopeSha256'))
                if ([string]::CompareOrdinal($root, $DataRoot) -ne 0 -or [string]::CompareOrdinal($requestScopeSha256, $scopeSha256) -ne 0) {
                    throw [IO.InvalidDataException]::new('Event batch scope is invalid.')
                }
                $inputBytes = Read-ControlBytes -Request $request
                $source = [IO.MemoryStream]::new($inputBytes, $false)
                $failed = $false
                try {
                    if ($watch.ElapsedMilliseconds -ge $remainingMs) { throw [TimeoutException]::new('Event batch timed out.') }
                    $reply = [Companion.Runtime.EventInspection]::ReadBatch($root, $source)
                    if ($reply.Length -lt 1 -or $reply.Length -gt 65536) { throw [IO.InvalidDataException]::new('Event batch reply is out of bounds.') }
                    if ($watch.ElapsedMilliseconds -ge $remainingMs) { throw [TimeoutException]::new('Event batch timed out.') }
                    $result = ConvertTo-Json -InputObject ([ordered]@{ compressedBase64 = [Convert]::ToBase64String($reply);
                        sha256 = [Convert]::ToHexStringLower([Security.Cryptography.SHA256]::HashData($reply)) }) -Compress
                }
                catch {
                    if ($_.Exception -is [TimeoutException]) { throw }
                    $failed = $true
                }
                finally { $source.Dispose() }
                if ($failed) { Write-WorkerReply -Id $id -Operation $operation -Status 'error' -ResultJson $null -Code 'inspectionUnavailable' }
                else { Write-WorkerReply -Id $id -Operation $operation -Status 'ok' -ResultJson $result -Code $null }
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
