#Requires -Version 7.5

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:ProjectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$script:ProjectTmpRoot = Join-Path $script:ProjectRoot '.tmp'
$script:ScratchRoots = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
$script:CleanupRegistered = $false
$script:StaleScratchSwept = $false

function Assert-ScratchBoundarySafe {
    if (-not (Test-Path -LiteralPath $script:ProjectRoot -PathType Container)) {
        throw [System.InvalidOperationException]::new('Project root is missing or is not a directory.')
    }
    $projectRootItem = Get-Item -LiteralPath $script:ProjectRoot -Force
    if (($projectRootItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw [System.InvalidOperationException]::new('Project root reparse points are forbidden for scratch creation.')
    }

    if (Test-Path -LiteralPath $script:ProjectTmpRoot) {
        $temporaryRootItem = Get-Item -LiteralPath $script:ProjectTmpRoot -Force
        if (($temporaryRootItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw [System.InvalidOperationException]::new('Project .tmp reparse points are forbidden for scratch creation.')
        }
        if ($temporaryRootItem -isnot [System.IO.DirectoryInfo]) {
            throw [System.InvalidOperationException]::new('Project .tmp is not a directory.')
        }
    }
}

function Assert-True {
    param(
        [Parameter(Mandatory)] [bool] $Condition,
        [Parameter(Mandatory)] [string] $Message
    )

    if (-not $Condition) {
        throw [System.InvalidOperationException]::new("Assertion failed: $Message")
    }
}

function Assert-False {
    param(
        [Parameter(Mandatory)] [bool] $Condition,
        [Parameter(Mandatory)] [string] $Message
    )

    Assert-True -Condition (-not $Condition) -Message $Message
}

function Assert-Equal {
    param(
        [AllowNull()] $Actual,
        [AllowNull()] $Expected,
        [Parameter(Mandatory)] [string] $Message
    )

    if (-not [object]::Equals($Actual, $Expected)) {
        throw [System.InvalidOperationException]::new("Assertion failed: $Message. Expected '$Expected', actual '$Actual'.")
    }
}

function Assert-OrdinalEqual {
    param(
        [AllowNull()] $Actual,
        [AllowNull()] $Expected,
        [Parameter(Mandatory)] [string] $Message
    )

    if ($Actual -isnot [string] -or $Expected -isnot [string] -or -not [string]::Equals($Actual, $Expected, [System.StringComparison]::Ordinal)) {
        throw [System.InvalidOperationException]::new("Assertion failed: $Message. Expected ordinal '$Expected', actual '$Actual'.")
    }
}

function Assert-ThrowsType {
    param(
        [Parameter(Mandatory)] [string] $TypeName,
        [Parameter(Mandatory)] [scriptblock] $Action
    )

    try {
        & $Action
    }
    catch {
        $exception = $_.Exception
        while ($null -ne $exception) {
            if ([string]::Equals($exception.GetType().FullName, $TypeName, [System.StringComparison]::Ordinal) -or
                [string]::Equals($exception.GetType().Name, $TypeName, [System.StringComparison]::Ordinal)) {
                return
            }

            $exception = $exception.InnerException
        }

        throw [System.InvalidOperationException]::new("Assertion failed: expected exception type '$TypeName', actual '$($_.Exception.GetType().FullName)'.", $_.Exception)
    }

    throw [System.InvalidOperationException]::new("Assertion failed: expected exception type '$TypeName', but no exception was thrown.")
}

function New-BoundedPwshStartInfo {
    param(
        [Parameter(Mandatory)] [AllowEmptyString()] [string[]] $Arguments,
        [Parameter()] [string] $WorkingDirectory = $script:ProjectRoot,
        [Parameter()] [hashtable] $Environment = @{}
    )

    $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = 'pwsh'
    $startInfo.WorkingDirectory = [System.IO.Path]::GetFullPath($WorkingDirectory)
    $startInfo.UseShellExecute = $false
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    foreach ($argument in @('-NoProfile') + $Arguments) {
        $startInfo.ArgumentList.Add($argument)
    }
    foreach ($key in $Environment.Keys) {
        $startInfo.Environment[[string] $key] = [string] $Environment[$key]
    }

    return $startInfo
}

function Start-BoundedPwsh {
    param(
        [Parameter(Mandatory)] [AllowEmptyString()] [string[]] $Arguments,
        [Parameter()] [string] $WorkingDirectory = $script:ProjectRoot,
        [Parameter()] [hashtable] $Environment = @{}
    )

    $startInfo = New-BoundedPwshStartInfo -Arguments $Arguments -WorkingDirectory $WorkingDirectory -Environment $Environment
    $process = [System.Diagnostics.Process]::Start($startInfo)

    return [pscustomobject]@{
        Process = $process
        StandardOutputTask = $process.StandardOutput.ReadToEndAsync()
        StandardErrorTask = $process.StandardError.ReadToEndAsync()
        Disposed = $false
    }
}

function Invoke-BoundedPwshBytes {
    param(
        [Parameter(Mandatory)] [AllowEmptyString()] [string[]] $Arguments,
        [Parameter()] [int] $TimeoutMilliseconds = 30000,
        [Parameter()] [string] $WorkingDirectory = $script:ProjectRoot,
        [Parameter()] [hashtable] $Environment = @{}
    )

    if ($TimeoutMilliseconds -le 0) {
        throw [System.ArgumentOutOfRangeException]::new('TimeoutMilliseconds')
    }

    $startInfo = New-BoundedPwshStartInfo -Arguments $Arguments -WorkingDirectory $WorkingDirectory -Environment $Environment
    $process = [System.Diagnostics.Process]::Start($startInfo)
    $standardOutput = [System.IO.MemoryStream]::new()
    $standardError = [System.IO.MemoryStream]::new()
    $captureCompleted = $false
    try {
        $standardOutputTask = $process.StandardOutput.BaseStream.CopyToAsync($standardOutput)
        $standardErrorTask = $process.StandardError.BaseStream.CopyToAsync($standardError)
        $exitTask = $process.WaitForExitAsync()
        $completionTask = [System.Threading.Tasks.Task]::WhenAll(@($exitTask, $standardOutputTask, $standardErrorTask))
        $timeoutTask = [System.Threading.Tasks.Task]::Delay($TimeoutMilliseconds)
        $completedTask = [System.Threading.Tasks.Task]::WhenAny(@($completionTask, $timeoutTask)).GetAwaiter().GetResult()
        if (-not [object]::ReferenceEquals($completedTask, $completionTask)) {
            try {
                if (-not $process.HasExited) {
                    $process.Kill($true)
                }
            }
            catch {
                # Test cleanup is best-effort after the composite deadline expires.
            }
            try {
                $process.StandardOutput.BaseStream.Close()
            }
            catch {
                # Test cleanup is best-effort after the composite deadline expires.
            }
            try {
                $process.StandardError.BaseStream.Close()
            }
            catch {
                # Test cleanup is best-effort after the composite deadline expires.
            }
            $graceTask = [System.Threading.Tasks.Task]::Delay([System.TimeSpan]::FromSeconds(5))
            $graceCompletedTask = [System.Threading.Tasks.Task]::WhenAny(@($completionTask, $graceTask)).GetAwaiter().GetResult()
            $captureCompleted = [object]::ReferenceEquals($graceCompletedTask, $completionTask)
            throw [System.TimeoutException]::new("Child pwsh exceeded $TimeoutMilliseconds ms plus drain grace.")
        }
        $captureCompleted = $true
        [void] $completionTask.GetAwaiter().GetResult()
        $standardOutputBytes = $standardOutput.ToArray()
        $standardErrorBytes = $standardError.ToArray()
        $strictUtf8 = [System.Text.UTF8Encoding]::new($false, $true)

        return [pscustomobject]@{
            ExitCode = $process.ExitCode
            StdOut = $strictUtf8.GetString($standardOutputBytes)
            StdErr = $strictUtf8.GetString($standardErrorBytes)
            StdOutBytes = $standardOutputBytes
            StdErrBytes = $standardErrorBytes
        }
    }
    finally {
        if ($captureCompleted) {
            $standardOutput.Dispose()
            $standardError.Dispose()
            $process.Dispose()
        }
    }
}

function Complete-BoundedPwsh {
    param(
        [Parameter(Mandatory)] [pscustomobject] $Child,
        [Parameter()] [int] $TimeoutMilliseconds = 30000
    )

    if ($TimeoutMilliseconds -le 0) {
        Stop-BoundedPwsh -Child $Child
        throw [System.ArgumentOutOfRangeException]::new('TimeoutMilliseconds')
    }

    try {
        if (-not $Child.Process.WaitForExit($TimeoutMilliseconds)) {
            $Child.Process.Kill($true)
            $Child.Process.WaitForExit()
            $null = $Child.StandardOutputTask.GetAwaiter().GetResult()
            $standardError = $Child.StandardErrorTask.GetAwaiter().GetResult()
            throw [System.TimeoutException]::new("Child pwsh exceeded $TimeoutMilliseconds ms: $standardError")
        }

        $Child.Process.WaitForExit()

        return [pscustomobject]@{
            ExitCode = $Child.Process.ExitCode
            StdOut = $Child.StandardOutputTask.GetAwaiter().GetResult()
            StdErr = $Child.StandardErrorTask.GetAwaiter().GetResult()
        }
    }
    finally {
        $Child.Disposed = $true
        $Child.Process.Dispose()
    }
}

function Stop-BoundedPwsh {
    param([Parameter(Mandatory)] [pscustomobject] $Child)

    if ($Child.Disposed) {
        return
    }

    $Child.Disposed = $true
    try {
        if (-not $Child.Process.HasExited) {
            $Child.Process.Kill($true)
            $Child.Process.WaitForExit()
        }
    }
    finally {
        $Child.Process.Dispose()
    }
}

function Invoke-BoundedPwsh {
    param(
        [Parameter(Mandatory)] [AllowEmptyString()] [string[]] $Arguments,
        [Parameter()] [int] $TimeoutMilliseconds = 30000,
        [Parameter()] [string] $WorkingDirectory = $script:ProjectRoot,
        [Parameter()] [hashtable] $Environment = @{}
    )

    if ($TimeoutMilliseconds -le 0) {
        throw [System.ArgumentOutOfRangeException]::new('TimeoutMilliseconds')
    }

    $child = Start-BoundedPwsh -Arguments $Arguments -WorkingDirectory $WorkingDirectory -Environment $Environment

    return Complete-BoundedPwsh -Child $child -TimeoutMilliseconds $TimeoutMilliseconds
}

function Wait-TestSentinel {
    param(
        [Parameter(Mandatory)] [string] $Path,
        [Parameter()] [int] $TimeoutMilliseconds = 5000
    )

    $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
    while (-not [System.IO.File]::Exists($Path)) {
        if ($stopwatch.ElapsedMilliseconds -gt $TimeoutMilliseconds) {
            throw [System.TimeoutException]::new("Sentinel '$Path' did not appear within $TimeoutMilliseconds ms.")
        }

        [System.Threading.Thread]::Sleep(10)
    }
}

function Copy-CompanionCoreTree {
    param(
        [Parameter(Mandatory)] [string] $Destination,
        [Parameter()] [string[]] $EntryScripts = @()
    )

    [void] [System.IO.Directory]::CreateDirectory($Destination)
    $coreRoot = Split-Path $PSScriptRoot -Parent
    foreach ($name in @('DigestDiff.psm1', 'EntryFence.psm1') + $EntryScripts) {
        Copy-Item -LiteralPath (Join-Path $coreRoot $name) -Destination (Join-Path $Destination $name)
    }
    Copy-Item -LiteralPath (Join-Path $coreRoot 'private') -Destination (Join-Path $Destination 'private') -Recurse
}

function Install-StubAdapterRelease {
    param(
        [Parameter(Mandatory)] [string] $AdapterDirectory,
        [Parameter()] [string] $DigestScript
    )

    if (-not $PSBoundParameters.ContainsKey('DigestScript')) {
        $DigestScript = @'
param([string] $DumpPath, [string] $OutPath, [string] $AdapterVersion, [string] $SourceDomainId, [string] $SaveName, [string] $SavedAt, [string] $SourceLength, [string] $SourceSha256)
$digest = [ordered]@{
    schemaVersion = 2; adapterVersion = [long] $AdapterVersion; game = 'stubgame'
    generatedAt = [DateTime]::UtcNow.ToString('o')
    source = [ordered]@{ domainId = $SourceDomainId; saveFile = $SaveName; savedAt = $SavedAt; byteLength = [long] $SourceLength; contentSha256 = $SourceSha256 }
    session = [ordered]@{ day = 1; time = '08:00'; location = 'loc'; playtimeNote = $null }
    character = [ordered]@{ level = 1; xp = 0; unspentPoints = 0
        money = [ordered]@{ amount = 1.0; minorUnits = 100; minorUnitsPerUnit = 100; currency = 'x' }
        vitals = @(); skills = @() }
    objectives = @(); inventory = [ordered]@{ owned = @(); equipped = @(); highlights = @() }
    extra = [ordered]@{}
}
[System.IO.File]::WriteAllText($OutPath, ($digest | ConvertTo-Json -Depth 8 -Compress), [Text.UTF8Encoding]::new($false))
'@
    }

    $packageCore = Join-Path $AdapterDirectory 'releases/2/schema-2/core'
    $packageAdapter = Join-Path $AdapterDirectory 'releases/2/schema-2/adapters/stub'
    [void] [System.IO.Directory]::CreateDirectory($packageCore)
    [void] [System.IO.Directory]::CreateDirectory($packageAdapter)
    $dumpScript = @'
param([string] $Save, [string] $Dump)
[System.IO.File]::Copy($Save, $Dump, $true)
'@
    $encoding = [System.Text.UTF8Encoding]::new($false, $true)
    [System.IO.File]::WriteAllText((Join-Path $packageAdapter 'stub-dump.ps1'), $dumpScript.TrimStart("`r", "`n"), $encoding)
    [System.IO.File]::WriteAllText((Join-Path $packageCore 'DigestDiff.psm1'), "`n", $encoding)
    [System.IO.File]::WriteAllText((Join-Path $packageAdapter 'Validate-Digest.psm1'), "function Assert-AdapterDigestSemantics { param([Parameter(Mandatory)] [object] `$Document) }`nExport-ModuleMember -Function Assert-AdapterDigestSemantics`n", $encoding)
    [System.IO.File]::WriteAllText((Join-Path $packageAdapter 'Build-Digest.ps1'), $DigestScript.TrimStart("`r", "`n"), $encoding)
}

# Stages a scratch companion root that acquires through the stub adapter: a copied core
# with the named entry scripts, the stub release and its adapter.json, and one save.
# Callers must have DigestDiff imported, because adapter.json is written with its writer.
function New-StagedStubAcquisitionRoot {
    param(
        [Parameter(Mandatory)] [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9-]*$')] [string] $Prefix,
        [Parameter()] [string[]] $EntryScripts = @(),
        [Parameter()] [string] $SaveName = 's-a.zip',
        [Parameter()] [string] $SaveContent = 'save-a'
    )

    $root = New-ScratchCompanionRoot -Prefix $Prefix
    $core = Join-Path $root 'core'
    $saves = Join-Path $root 'saves'
    $adapter = Join-Path $root 'adapters/stub'
    foreach ($directory in @($saves, (Join-Path $root '.tmp'))) { [void] [System.IO.Directory]::CreateDirectory($directory) }
    Copy-CompanionCoreTree -Destination $core -EntryScripts $EntryScripts
    Install-StubAdapterRelease -AdapterDirectory $adapter
    $config = New-StubAdapterCommandConfig -SaveDirectory $saves
    [System.IO.File]::WriteAllText((Join-Path $adapter 'adapter.json'), (Invoke-InCompanionModule { param($Config) ConvertTo-CompanionJson -InputObject $Config -Budget config } @(, $config)), [System.Text.UTF8Encoding]::new($false, $true))
    $save = Join-Path $saves $SaveName
    [System.IO.File]::WriteAllText($save, $SaveContent, [System.Text.UTF8Encoding]::new($false, $true))
    [System.IO.File]::SetLastWriteTimeUtc($save, [System.DateTime]::UtcNow.AddMinutes(-5))

    return [pscustomobject]@{ Root = $root; Core = $core; Saves = $saves; Adapter = $adapter; State = (Join-Path $root 'state'); Save = $save }
}

function New-StubAdapterCommandConfig {
    param(
        [Parameter(Mandatory)] [string] $SaveDirectory,
        [Parameter()] [string[]] $DiffExcludePaths = @(),
        [Parameter()] [string[]] $AmbientExtraPaths = @()
    )

    return [ordered]@{
        game = 'stubgame'
        adapterVersion = 2L
        saveDirectory = $SaveDirectory
        saveGlob = 's-*.zip'
        maxSourceBytes = 1048576
        dumpCommand = @('pwsh', '-NoProfile', '-File', '{artifactRoot}/adapters/stub/stub-dump.ps1', '{save}', '{dump}')
        dumpEntrypointIndex = 3
        digestCommand = @('pwsh', '-NoProfile', '-File', '{artifactRoot}/adapters/stub/Build-Digest.ps1', '-DumpPath', '{dump}', '-OutPath', '{digest}', '-AdapterVersion', '{adapterVersion}', '-SourceDomainId', '{sourceDomainId}', '-SaveName', '{saveName}', '-SavedAt', '{savedAt}', '-SourceLength', '{sourceLength}', '-SourceSha256', '{sourceSha256}')
        digestEntrypointIndex = 3
        diffExcludePaths = $DiffExcludePaths
        ambientExtraPaths = $AmbientExtraPaths
    }
}

function Register-ScratchCleanup {
    if ($script:CleanupRegistered) {
        return
    }

    Assert-ScratchBoundarySafe
    $cleanupContext = [pscustomobject]@{
        ProjectRoot = $script:ProjectRoot
        TemporaryRoot = $script:ProjectTmpRoot
        ScratchRoots = $script:ScratchRoots
    }
    $null = Register-EngineEvent -SourceIdentifier PowerShell.Exiting -SupportEvent -MessageData $cleanupContext -Action {
        $projectRootItem = Get-Item -LiteralPath $event.MessageData.ProjectRoot -Force -ErrorAction SilentlyContinue
        $temporaryRootItem = Get-Item -LiteralPath $event.MessageData.TemporaryRoot -Force -ErrorAction SilentlyContinue
        if ($null -eq $projectRootItem -or $null -eq $temporaryRootItem -or
            ($projectRootItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or
            ($temporaryRootItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            return
        }
        foreach ($root in $event.MessageData.ScratchRoots) {
            $rootItem = Get-Item -LiteralPath $root -Force -ErrorAction SilentlyContinue
            if ($null -ne $rootItem -and ($rootItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -eq 0 -and
                [string]::Equals([System.IO.Directory]::GetParent($rootItem.FullName).FullName, $event.MessageData.TemporaryRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
                Remove-Item -LiteralPath $root -Recurse -Force -Confirm:$false -ErrorAction SilentlyContinue
            }
        }
    }
    $script:CleanupRegistered = $true
}

function Clear-StaleScratchRoots {
    # Crash-killed harnesses never reach Register-EngineEvent cleanup; their scratch
    # roots accumulate under .tmp forever. A harness that creates new scratch reaps
    # its predecessors here: only directories matching the exact scratch shape
    # <prefix>-<pid>-<32hex> whose embedded process id is no longer alive, directly
    # beneath the project .tmp, non-reparse. A live PID is never touched (the creator
    # may still be running); migration artifacts, evidence roots, and hand-placed
    # fixtures do not match the shape and are never considered.
    if ($script:StaleScratchSwept) {
        return
    }
    $script:StaleScratchSwept = $true

    Assert-ScratchBoundarySafe
    if (-not (Test-Path -LiteralPath $script:ProjectTmpRoot -PathType Container)) {
        return
    }
    $tmpRootItem = Get-Item -LiteralPath $script:ProjectTmpRoot -Force
    if (($tmpRootItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        return
    }
    $temporaryRoot = $tmpRootItem.FullName.TrimEnd([System.IO.Path]::DirectorySeparatorChar)
    $liveProcessIds = [System.Collections.Generic.HashSet[int]]::new()
    foreach ($process in Get-Process -ErrorAction SilentlyContinue) {
        [void] $liveProcessIds.Add($process.Id)
    }

    foreach ($entry in [System.IO.Directory]::EnumerateFileSystemEntries($temporaryRoot)) {
        $entryItem = Get-Item -LiteralPath $entry -Force -ErrorAction SilentlyContinue
        if ($null -eq $entryItem -or $entryItem -isnot [System.IO.DirectoryInfo] -or
            ($entryItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            continue
        }
        if (-not ([System.IO.Directory]::GetParent($entryItem.FullName).FullName.TrimEnd([System.IO.Path]::DirectorySeparatorChar) -ceq $temporaryRoot)) {
            continue
        }
        $match = [regex]::Match($entryItem.Name, '^[A-Za-z0-9][A-Za-z0-9-]*-([0-9]+)-[0-9a-f]{32}$')
        if (-not $match.Success) {
            continue
        }
        $creatorId = [int] $match.Groups[1].Value
        if ($liveProcessIds.Contains($creatorId)) {
            continue
        }
        Remove-Item -LiteralPath $entryItem.FullName -Recurse -Force -Confirm:$false -ErrorAction SilentlyContinue
    }
}

function New-ScratchCompanionRoot {
    param([Parameter()] [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9-]*$')] [string] $Prefix = 'state-extraction')

    Clear-StaleScratchRoots
    Assert-ScratchBoundarySafe
    [void] [System.IO.Directory]::CreateDirectory($script:ProjectTmpRoot)
    Assert-ScratchBoundarySafe
    $resolvedTmpRoot = [System.IO.Path]::GetFullPath($script:ProjectTmpRoot).TrimEnd([System.IO.Path]::DirectorySeparatorChar)
    $scratchName = "$Prefix-$PID-$([guid]::NewGuid().ToString('N'))"
    $scratchRoot = [System.IO.Path]::GetFullPath((Join-Path $resolvedTmpRoot $scratchName))
    $expectedPrefix = $resolvedTmpRoot + [System.IO.Path]::DirectorySeparatorChar
    if (-not $scratchRoot.StartsWith($expectedPrefix, [System.StringComparison]::OrdinalIgnoreCase) -or
        -not [string]::Equals([System.IO.Directory]::GetParent($scratchRoot).FullName, $resolvedTmpRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw [System.InvalidOperationException]::new('Scratch companion root escaped project .tmp.')
    }

    Register-ScratchCleanup
    Assert-ScratchBoundarySafe
    [void] [System.IO.Directory]::CreateDirectory($scratchRoot)
    [void] $script:ScratchRoots.Add($scratchRoot)

    return $scratchRoot
}

function Get-TreeFingerprint {
    param([Parameter(Mandatory)] [string] $Path)

    $fullPath = [System.IO.Path]::GetFullPath($Path)
    if (-not (Test-Path -LiteralPath $fullPath)) {
        return [pscustomobject]@{ exists = $false; entries = @() }
    }

    $root = Get-Item -LiteralPath $fullPath -Force
    if (($root.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw [System.InvalidOperationException]::new("Fingerprint root is a reparse point: $fullPath")
    }

    $rows = [System.Collections.Generic.List[object]]::new()
    if ($root -is [System.IO.FileInfo]) {
        $rows.Add([pscustomobject]@{ path = '.'; kind = 'file'; length = $root.Length; sha256 = (Get-FileHash -LiteralPath $root.FullName -Algorithm SHA256).Hash.ToLowerInvariant() })
    }
    else {
        $pending = [System.Collections.Generic.Stack[System.IO.DirectoryInfo]]::new()
        $pending.Push($root)
        while ($pending.Count -gt 0) {
            $directory = $pending.Pop()
            foreach ($child in $directory.EnumerateFileSystemInfos()) {
                if (($child.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                    throw [System.InvalidOperationException]::new("Fingerprint member is a reparse point: $($child.FullName)")
                }

                $relativePath = [System.IO.Path]::GetRelativePath($fullPath, $child.FullName).Replace([System.IO.Path]::DirectorySeparatorChar, '/')
                if ($child -is [System.IO.DirectoryInfo]) {
                    $rows.Add([pscustomobject]@{ path = $relativePath; kind = 'directory'; length = 0L; sha256 = $null })
                    $pending.Push($child)
                }
                else {
                    $rows.Add([pscustomobject]@{ path = $relativePath; kind = 'file'; length = $child.Length; sha256 = (Get-FileHash -LiteralPath $child.FullName -Algorithm SHA256).Hash.ToLowerInvariant() })
                }
            }
        }
    }

    $orderedRows = @($rows | Sort-Object -Property path -CaseSensitive)
    return [pscustomobject]@{ exists = $true; entries = $orderedRows }
}

function Assert-TreeFingerprintEqual {
    param(
        [Parameter(Mandatory)] $Actual,
        [Parameter(Mandatory)] $Expected,
        [Parameter(Mandatory)] [string] $Message
    )

    $actualJson = $Actual | ConvertTo-Json -Depth 5 -Compress
    $expectedJson = $Expected | ConvertTo-Json -Depth 5 -Compress
    Assert-OrdinalEqual -Actual $actualJson -Expected $expectedJson -Message $Message
}

# Shared adapter-fixture release-tree builder: writes adapter.json verbatim and stages
# the immutable release layout (validator, Build-Digest stub, optional dump tool,
# release-local core placeholder) under the fixed Int64.MinValue version root that the
# per-suite fixture wrappers assume.
function New-AdapterFixtureTree {
    param(
        [Parameter(Mandatory)] [string] $Root,
        [Parameter(Mandatory)] [string] $AdapterJson,
        [Parameter()] [string] $Name = 'example',
        [Parameter()] [string] $ValidatorModule = "function Assert-AdapterDigestSemantics { param([Parameter(Mandatory)] [System.Text.Json.JsonElement] `$RootElement) }`nExport-ModuleMember -Function Assert-AdapterDigestSemantics`n",
        [Parameter()] [switch] $OmitDumpTool
    )

    $adapterRoot = Join-Path $Root "adapters/$Name"
    [void] [IO.Directory]::CreateDirectory($adapterRoot)
    [IO.File]::WriteAllText((Join-Path $adapterRoot 'adapter.json'), $AdapterJson, [Text.UTF8Encoding]::new($false))
    $releaseRoot = Join-Path $adapterRoot 'releases/-9223372036854775808/schema-2'
    [void] [IO.Directory]::CreateDirectory((Join-Path $releaseRoot "adapters/$Name"))
    [void] [IO.Directory]::CreateDirectory((Join-Path $releaseRoot 'core'))
    [IO.File]::WriteAllText((Join-Path $releaseRoot "adapters/$Name/Validate-Digest.psm1"), $ValidatorModule, [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText((Join-Path $releaseRoot "adapters/$Name/Build-Digest.ps1"), "`n", [Text.UTF8Encoding]::new($false))
    if (-not $OmitDumpTool) {
        [IO.File]::WriteAllText((Join-Path $releaseRoot "adapters/$Name/tool.exe"), "fixture`n", [Text.UTF8Encoding]::new($false))
    }
    [IO.File]::WriteAllText((Join-Path $releaseRoot 'core/DigestDiff.psm1'), "`n", [Text.UTF8Encoding]::new($false))
}

function New-ConsumePrivateSuccess {
    # Builds a successful private-result consumption for a digest target. The
    # payload, empty-diff, and result constructors live in DigestDiff module scope,
    # so the construction runs inside one. Turn-context attempt scenarios share
    # this shape; call sites wrap it with their own per-scenario recording and pin
    # their own target, context, and sink.
    param(
        [Parameter(Mandatory)] $Target,
        [Parameter(Mandatory)] $Context,
        [Parameter(Mandatory)] $Sink,
        [Parameter()] $State = $Target
    )

    return Invoke-InCompanionModule {
        param($Target, $Context, $Sink, $State)
        $payload = New-ConsumePayload -DeliveryMode privateResult -Diff (New-EmptyDiff -Target $Target) -State $State -Context $Context
        $payload.Complete($false, $Sink.Freeze())

        return New-ConsumptionResult -OutcomeClass success -ConsumptionState consumed -Payload $payload -CacheDegraded $false -Detail $null
    } @($Target, $Context, $Sink, $State)
}

function Invoke-InCompanionModule {
    param(
        [Parameter(Mandatory)] [scriptblock] $ScriptBlock,
        [Parameter()] [object[]] $ArgumentList = @()
    )

    $module = Get-Module -Name 'DigestDiff' | Select-Object -First 1
    if ($null -eq $module) {
        throw [System.InvalidOperationException]::new('DigestDiff must be imported before entering companion module scope.')
    }

    return & $module $ScriptBlock @ArgumentList
}

Export-ModuleMember -Function Assert-True, Assert-False, Assert-Equal, Assert-OrdinalEqual, Assert-ThrowsType, Invoke-BoundedPwsh, Invoke-BoundedPwshBytes, Start-BoundedPwsh, Complete-BoundedPwsh, Stop-BoundedPwsh, Wait-TestSentinel, Copy-CompanionCoreTree, Install-StubAdapterRelease, New-StubAdapterCommandConfig, New-StagedStubAcquisitionRoot, New-ScratchCompanionRoot, Get-TreeFingerprint, Assert-TreeFingerprintEqual, Invoke-InCompanionModule, New-AdapterFixtureTree, New-ConsumePrivateSuccess
