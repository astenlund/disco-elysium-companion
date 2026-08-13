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

function Invoke-BoundedPwsh {
    param(
        [Parameter(Mandatory)] [string[]] $Arguments,
        [Parameter()] [int] $TimeoutMilliseconds = 30000,
        [Parameter()] [string] $WorkingDirectory = $script:ProjectRoot,
        [Parameter()] [hashtable] $Environment = @{}
    )

    if ($TimeoutMilliseconds -le 0) {
        throw [System.ArgumentOutOfRangeException]::new('TimeoutMilliseconds')
    }

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

    $process = [System.Diagnostics.Process]::Start($startInfo)
    try {
        $standardOutputTask = $process.StandardOutput.ReadToEndAsync()
        $standardErrorTask = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit($TimeoutMilliseconds)) {
            $process.Kill($true)
            $process.WaitForExit()
            $null = $standardOutputTask.GetAwaiter().GetResult()
            $standardError = $standardErrorTask.GetAwaiter().GetResult()
            throw [System.TimeoutException]::new("Child pwsh exceeded $TimeoutMilliseconds ms: $standardError")
        }

        $process.WaitForExit()
        $standardOutput = $standardOutputTask.GetAwaiter().GetResult()
        $standardError = $standardErrorTask.GetAwaiter().GetResult()

        return [pscustomobject]@{
            ExitCode = $process.ExitCode
            StdOut = $standardOutput
            StdErr = $standardError
        }
    }
    finally {
        $process.Dispose()
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

Export-ModuleMember -Function Assert-True, Assert-False, Assert-Equal, Assert-OrdinalEqual, Assert-ThrowsType, Invoke-BoundedPwsh, New-ScratchCompanionRoot, Get-TreeFingerprint, Assert-TreeFingerprintEqual, Invoke-InCompanionModule, New-AdapterFixtureTree
