#Requires -Version 7.5
param(
    [Parameter(Mandatory)][string] $RequestJson,
    [Parameter(Mandatory)][string] $Sid,
    [Parameter(Mandatory)][object[]] $Paths,
    [Parameter(Mandatory)][string] $Game
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Read-RequestString {
    param([Text.Json.JsonElement] $Object, [string] $Name)
    $entry = $Object.GetProperty($Name)
    if ($entry.ValueKind -ne [Text.Json.JsonValueKind]::String) { throw [IO.InvalidDataException]::new('Image pin request field kind is invalid.') }
    $value = $entry.GetString()
    if ([string]::IsNullOrEmpty($value)) { throw [IO.InvalidDataException]::new('Image pin request field is empty.') }
    return $value
}

function Get-PathHash {
    param([string] $Value)
    $bytes = [Text.UTF8Encoding]::new($false, $true).GetBytes($Value)
    return [Convert]::ToHexStringLower([Security.Cryptography.SHA256]::HashData($bytes))
}

function Assert-HeldAdmission {
    param([string] $Location, [bool] $Directory, [string] $Root = '')
    $admitted = if ($Root.Length -eq 0) { [Companion.Runtime.NativeFiles]::Admit($Location, $false) }
        else { [Companion.Runtime.NativeFiles]::AdmitWithin($Root, $Location, $false) }
    $handle = [Companion.Runtime.NativeImagePins]::OpenHeld($Location, $Directory)
    try {
        $held = [Companion.Runtime.NativeFiles]::DescribeHeld($handle, $Location)
        if ($held.Path -cne $admitted.Path -or $held.Volume -cne $admitted.Volume -or
            $held.Identity -cne $admitted.Identity -or $held.IsDirectory -ne $Directory -or
            (-not $Directory -and $held.Links -ne 1)) {
            throw [IO.IOException]::new('Image pin held path differs from admission.')
        }
        return [pscustomobject]@{ Kind = if ($Directory) { 'directory' } else { 'file' };
            Path = $held.Path; Volume = $held.Volume; Identity = $held.Identity;
            Handle = $handle; ExpectedHash = $null }
    } catch { $handle.Dispose(); throw }
}

$document = [Text.Json.JsonDocument]::Parse($RequestJson)
$records = [Collections.Generic.List[object]]::new()
$remoteHandles = [Collections.Generic.List[uint64]]::new()
$manifestHandle = $null
$target = $null
try {
    $request = $document.RootElement
    if ($request.ValueKind -ne [Text.Json.JsonValueKind]::Object -or $Paths.Count -ne 2) {
        throw [IO.InvalidDataException]::new('Image pin request or scope shape is invalid.')
    }
    $names = @('version', 'nonce', 'targetProcessId', 'targetCreated', 'companionRoot', 'installationRoot',
        'game', 'artifactGeneration', 'brokerPath', 'observerPath', 'brokerSha256', 'observerSha256')
    $expected = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($name in $names) { [void] $expected.Add($name) }
    $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($property in $request.EnumerateObject()) {
        if (-not $expected.Contains($property.Name) -or -not $seen.Add($property.Name)) {
            throw [IO.InvalidDataException]::new('Image pin request has an unknown or duplicate field.')
        }
    }
    if ($seen.Count -ne $names.Count -or $request.GetProperty('version').GetRawText() -cne '1') {
        throw [IO.InvalidDataException]::new('Image pin request version or field count is invalid.')
    }
    $nonce = Read-RequestString $request 'nonce'
    $created = Read-RequestString $request 'targetCreated'
    $companionRoot = Read-RequestString $request 'companionRoot'
    $installationRoot = Read-RequestString $request 'installationRoot'
    $requestedGame = Read-RequestString $request 'game'
    $generation = Read-RequestString $request 'artifactGeneration'
    $broker = Read-RequestString $request 'brokerPath'
    $observer = Read-RequestString $request 'observerPath'
    $brokerHash = Read-RequestString $request 'brokerSha256'
    $observerHash = Read-RequestString $request 'observerSha256'
    $pidText = $request.GetProperty('targetProcessId').GetRawText()
    $targetPid = [int]0
    if ($nonce -cnotmatch '^[a-f0-9]{32}$' -or $created -cnotmatch '^[1-9][0-9]{0,18}$' -or
        $generation -cnotmatch '^[a-f0-9]{64}$' -or $brokerHash -cnotmatch '^[a-f0-9]{64}$' -or
        $observerHash -cnotmatch '^[a-f0-9]{64}$' -or $pidText -cnotmatch '^[1-9][0-9]{0,9}$' -or
        -not [int]::TryParse($pidText, [ref] $targetPid) -or $targetPid -lt 1) {
        throw [IO.InvalidDataException]::new('Image pin request token grammar is invalid.')
    }
    $canonicalRoot = [Companion.Runtime.NativeFiles]::NormalizePath($companionRoot)
    $canonicalInstallation = [Companion.Runtime.NativeFiles]::NormalizePath($installationRoot)
    if ($canonicalRoot -cne $companionRoot -or $canonicalInstallation -cne $installationRoot -or
        $requestedGame -cne $Game -or $companionRoot -cne [string]$Paths[0]['path']) {
        throw [IO.InvalidDataException]::new('Image pin request scope binding is invalid.')
    }
    $installation = [Companion.Runtime.NativeFiles]::Admit($installationRoot, $false)
    if (-not $installation.IsDirectory -or $installation.Path -cne $installationRoot) {
        throw [IO.InvalidDataException]::new('Image pin installation root is not canonical.')
    }
    $expectedBroker = [Companion.Runtime.NativeFiles]::NormalizePath((Join-Path $installationRoot 'runtime/native/go-broker.exe'))
    $expectedObserver = [Companion.Runtime.NativeFiles]::NormalizePath((Join-Path $installationRoot 'runtime/native/job-observer.exe'))
    $manifestPath = [Companion.Runtime.NativeFiles]::NormalizePath((Join-Path $installationRoot 'runtime/native/compiled-images.json'))
    if ($broker -cne $expectedBroker -or $observer -cne $expectedObserver) {
        throw [IO.InvalidDataException]::new('Image pin executable paths differ from fixed slots.')
    }
    $slots = @($broker, $observer, $manifestPath)
    $admissions = @($slots | ForEach-Object { [Companion.Runtime.NativeFiles]::AdmitWithin($installationRoot, $_, $true) })
    $present = @($admissions | Where-Object { $_.Exists }).Count
    if ($present -eq 0) { return [ordered]@{ status = 'absent' } }
    if ($present -ne 3 -or @($admissions | Where-Object { $_.IsDirectory -or $_.Links -ne 1 }).Count -ne 0) {
        throw [IO.InvalidDataException]::new('Image pin release is incomplete or invalid.')
    }
    $manifestHandle = [Companion.Runtime.NativeImagePins]::OpenHeld($manifestPath, $false)
    if ([Companion.Runtime.NativeImagePins]::HashHeld($manifestHandle, 1048576) -cne $generation) {
        throw [IO.InvalidDataException]::new('Image pin release generation changed.')
    }
    $seenObjects = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($binary in @($broker, $observer)) {
        $chain = [Collections.Generic.List[string]]::new()
        $parent = [IO.Directory]::GetParent($binary)
        while ($null -ne $parent) { $chain.Insert(0, $parent.FullName); $parent = $parent.Parent }
        foreach ($directory in $chain) {
            $entry = Assert-HeldAdmission -Location $directory -Directory $true
            $objectKey = $entry.Volume + ':' + $entry.Identity
            if ($seenObjects.Add($objectKey)) { $records.Add($entry) }
            else { $entry.Handle.Dispose() }
            if ($records.Count -gt 62) { throw [IO.InvalidDataException]::new('Image pin ancestor count exceeds its bound.') }
        }
    }
    foreach ($image in @(@{ path = $broker; kind = 'broker'; hash = $brokerHash },
        @{ path = $observer; kind = 'observer'; hash = $observerHash })) {
        $entry = Assert-HeldAdmission -Location $image.path -Directory $false -Root $installationRoot
        if ([Companion.Runtime.NativeImagePins]::HashHeld($entry.Handle, 33554432) -cne $image.hash) {
            $entry.Handle.Dispose()
            throw [IO.InvalidDataException]::new('Image pin executable bytes differ from release.')
        }
        $entry.Kind = $image.kind
        $entry.ExpectedHash = $image.hash
        if (-not $seenObjects.Add($entry.Volume + ':' + $entry.Identity)) {
            $entry.Handle.Dispose()
            throw [IO.InvalidDataException]::new('Image pin executable identities alias.')
        }
        $records.Add($entry)
    }
    foreach ($entry in $records) {
        $current = [Companion.Runtime.NativeFiles]::Admit($entry.Path, $false)
        if ($current.Volume -cne $entry.Volume -or $current.Identity -cne $entry.Identity) {
            throw [IO.IOException]::new('Image pin ancestry changed before transfer.')
        }
    }
    $target = [Companion.Runtime.NativeImagePins]::OpenTargetProcess($targetPid, $created)
    $receiptHandles = [Collections.Generic.List[object]]::new()
    foreach ($entry in $records) {
        $remote = [Companion.Runtime.NativeImagePins]::DuplicateInto($entry.Handle, $target)
        $remoteHandles.Add($remote)
        $receiptHandles.Add([ordered]@{ kind = $entry.Kind; path = $entry.Path; volume = $entry.Volume;
            identity = $entry.Identity; handle = $remote.ToString('x16', [Globalization.CultureInfo]::InvariantCulture) })
    }
    foreach ($entry in $records) { $entry.Handle.Dispose(); $entry.Handle = $null }
    $manifestHandle.Dispose()
    $manifestHandle = $null
    for ($index = 0; $index -lt $records.Count; $index++) {
        $entry = $records[$index]
        $returned = [Companion.Runtime.NativeImagePins]::DuplicateBack($target, $remoteHandles[$index])
        try {
            $observed = [Companion.Runtime.NativeFiles]::DescribeHeld($returned, $entry.Path)
            if ($observed.Volume -cne $entry.Volume -or $observed.Identity -cne $entry.Identity -or
                $observed.IsDirectory -ne ($entry.Kind -ceq 'directory') -or
                ($entry.Kind -cne 'directory' -and $observed.Links -ne 1) -or
                ($entry.Kind -cne 'directory' -and
                    [Companion.Runtime.NativeImagePins]::HashHeld($returned, 33554432) -cne $entry.ExpectedHash)) {
                throw [IO.IOException]::new('Returned image pin handle differs from admission.')
            }
        } finally { $returned.Dispose() }
    }
    return [ordered]@{ status = 'ready'; version = 1; nonce = $nonce; targetProcessId = $targetPid;
        targetCreated = $created; artifactGeneration = $generation;
        installationRootSha256 = Get-PathHash $installationRoot;
        candidateScopePathSha256 = Get-PathHash ([string]$Paths[1]['path']);
        brokerSha256 = $brokerHash; observerSha256 = $observerHash;
        handles = @($receiptHandles.ToArray()) }
} catch {
    $original = $_
    $rollbackUncertain = $false
    if ($null -ne $target) {
        for ($index = $remoteHandles.Count - 1; $index -ge 0; $index--) {
            $closing = $remoteHandles[$index]
            $remoteHandles[$index] = [uint64]0
            if ($closing -ne 0) {
                try { [Companion.Runtime.NativeImagePins]::CloseRemote($target, $closing) }
                catch { $rollbackUncertain = $true }
            }
        }
    }
    if ($rollbackUncertain) { throw [IO.IOException]::new('Image pin rollback is unverified.') }
    throw $original
} finally {
    if ($null -ne $target) { $target.Dispose() }
    if ($null -ne $manifestHandle) { $manifestHandle.Dispose() }
    foreach ($entry in $records) { if ($null -ne $entry.Handle) { $entry.Handle.Dispose() } }
    $document.Dispose()
}
