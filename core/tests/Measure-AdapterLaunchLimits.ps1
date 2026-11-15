#Requires -Version 7.5
# Measures the longest executable path, working directory and pwsh -File script path that the core's
# Invoke-AdapterCommand starts on this host, by building each at every length in a range around the
# Windows boundary, and writes the results as JSON. A measurement, not a test: it asserts nothing and
# runs outside the suite. Its figures ground the adapter launch-length admission in AdapterConfig.ps1.

[CmdletBinding()]
param(
    [Parameter()] [ValidateRange(20, 32000)] [int] $From = 250,
    [Parameter()] [ValidateRange(20, 32000)] [int] $To = 300
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Import-Module (Join-Path (Split-Path $PSScriptRoot -Parent) 'DigestDiff.psm1') -Force -DisableNameChecking
Import-Module (Join-Path $PSScriptRoot 'TestSupport.psm1') -Force

function Invoke-MeasuredLaunch {
    param([Parameter(Mandatory)] [string[]] $Command, [Parameter(Mandatory)] [string] $WorkingDirectory, [Parameter(Mandatory)] [int] $ExpectedExitCode)

    $result = Invoke-AdapterCommand -Command $Command -WorkingDirectory $WorkingDirectory -TimeoutSeconds 30
    $failure = if ($null -ne $result.TransportException) { $result.TransportException.GetBaseException().Message } else { $null }

    return [ordered]@{ started = ($result.Started -and $result.ExitCode -eq $ExpectedExitCode); exitCode = $result.ExitCode; error = $failure }
}

try {
    if ($To -lt $From) {
        throw [ArgumentException]::new('To must not be below From.')
    }
    $scratch = New-ScratchCompanionRoot -Prefix 'adapter-launch-limits'
    if ($scratch.Length + 40 -gt $From) {
        throw [ArgumentOutOfRangeException]::new('From', "From must leave room below it for the $($scratch.Length)-character scratch root.")
    }
    $tool = Join-Path $env:SystemRoot 'System32\hostname.exe'
    $shortDirectory = Join-Path $scratch 'w'
    [void] [IO.Directory]::CreateDirectory($shortDirectory)
    $rows = [Collections.Generic.List[object]]::new()
    for ($length = $From; $length -le $To; $length++) {
        $executable = Get-ExactLengthPath -Base (Join-Path $scratch "e$length") -Length $length -Leaf 'dedump.exe'
        [void] [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($executable))
        Copy-Item -LiteralPath $tool -Destination $executable -Force
        $rows.Add([ordered]@{ kind = 'executable'; length = $length } + (Invoke-MeasuredLaunch -Command @($executable) -WorkingDirectory $shortDirectory -ExpectedExitCode 0))

        $directory = Get-ExactLengthPath -Base (Join-Path $scratch "d$length") -Length $length -Leaf 'cwd'
        [void] [IO.Directory]::CreateDirectory($directory)
        $rows.Add([ordered]@{ kind = 'workingDirectory'; length = $length } + (Invoke-MeasuredLaunch -Command @($tool) -WorkingDirectory $directory -ExpectedExitCode 0))

        $script = Get-ExactLengthPath -Base (Join-Path $scratch "s$length") -Length $length -Leaf 'Build-Digest.ps1'
        [void] [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($script))
        [IO.File]::WriteAllText($script, "exit 5`n")
        $rows.Add([ordered]@{ kind = 'pwshFileScript'; length = $length } + (Invoke-MeasuredLaunch -Command @('pwsh', '-NoProfile', '-File', $script) -WorkingDirectory $shortDirectory -ExpectedExitCode 5))
    }

    $summary = foreach ($kind in 'executable', 'workingDirectory', 'pwshFileScript') {
        $started = @($rows | Where-Object { $_.kind -ceq $kind -and $_.started } | ForEach-Object { $_.length })
        $failed = @($rows | Where-Object { $_.kind -ceq $kind -and -not $_.started } | ForEach-Object { $_.length })
        [ordered]@{
            kind = $kind
            longestStarted = if ($started.Count -gt 0) { ($started | Measure-Object -Maximum).Maximum } else { $null }
            shortestFailed = if ($failed.Count -gt 0) { ($failed | Measure-Object -Minimum).Minimum } else { $null }
            # A boundary is clean when every length up to the last start started and every later one failed.
            monotonic = ($failed.Count -eq 0) -or ($started.Count -eq 0) -or (($started | Measure-Object -Maximum).Maximum -lt ($failed | Measure-Object -Minimum).Minimum)
        }
    }
    $hostFacts = [ordered]@{
        os = [Environment]::OSVersion.VersionString
        pwsh = $PSVersionTable.PSVersion.ToString()
        dotnet = [Runtime.InteropServices.RuntimeInformation]::FrameworkDescription
        longPathsEnabled = (Get-ItemProperty -LiteralPath 'HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem' -Name LongPathsEnabled -ErrorAction SilentlyContinue).LongPathsEnabled
    }
    ConvertTo-Json -InputObject ([ordered]@{ host = $hostFacts; range = @($From, $To); summary = @($summary); rows = @($rows) }) -Depth 6
}
catch {
    Exit-HarnessFailure -ErrorRecord $_
}
finally {
    Complete-ScratchHarness
}
