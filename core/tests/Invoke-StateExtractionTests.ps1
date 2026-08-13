#Requires -Version 7.5
[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidateSet('Json', 'Documents', 'Diff', 'Config', 'Process', 'State', 'Adapter', 'Acquisition', 'Consumption', 'TurnContext', 'Watcher', 'Walk', 'All')]
    [string] $Group
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$coreRoot = Split-Path $PSScriptRoot -Parent
$companionRoot = Split-Path $coreRoot -Parent
$adapterRoot = Join-Path $companionRoot 'adapters/disco_elysium'

$groupScripts = [ordered]@{
    Json = @((Join-Path $PSScriptRoot 'Test-CompanionJson.ps1'))
    Documents = @((Join-Path $PSScriptRoot 'Test-DocumentValidation.ps1'))
    Diff = @(
        (Join-Path $PSScriptRoot 'Test-DiffEngine.ps1'),
        (Join-Path $PSScriptRoot 'Test-StatePredicates.ps1')
    )
    Config = @((Join-Path $PSScriptRoot 'Test-AdapterConfig.ps1'))
    Process = @((Join-Path $PSScriptRoot 'Test-ProcessRunner.ps1'))
    State = @(
        (Join-Path $PSScriptRoot 'Test-EntryFence.ps1'),
        (Join-Path $PSScriptRoot 'Test-StateFiles.ps1')
    )
    Adapter = @(
        (Join-Path $adapterRoot 'Test-Build-Digest.ps1'),
        (Join-Path $adapterRoot 'Test-Validate-Digest.ps1')
    )
    Acquisition = @((Join-Path $PSScriptRoot 'Test-Acquisition.ps1'))
    Consumption = @((Join-Path $PSScriptRoot 'Test-Consumption.ps1'))
    TurnContext = @((Join-Path $PSScriptRoot 'Test-TurnContext.ps1'))
    Watcher = @((Join-Path $PSScriptRoot 'Test-Watcher.ps1'))
    Walk = @((Join-Path $PSScriptRoot 'Test-Walk.ps1'))
}
$mandatoryTaskOneScripts = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
foreach ($mandatoryPath in @($groupScripts.State[0])) {
    [void] $mandatoryTaskOneScripts.Add([System.IO.Path]::GetFullPath($mandatoryPath))
}

function Invoke-TestScript {
    param([Parameter(Mandatory)] [string] $Path)

    $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = 'pwsh'
    $startInfo.WorkingDirectory = $companionRoot
    $startInfo.UseShellExecute = $false
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    foreach ($argument in @('-NoProfile', '-File', $Path)) {
        $startInfo.ArgumentList.Add($argument)
    }

    $process = [System.Diagnostics.Process]::Start($startInfo)
    try {
        $standardOutputTask = $process.StandardOutput.ReadToEndAsync()
        $standardErrorTask = $process.StandardError.ReadToEndAsync()
        $process.WaitForExit()
        $standardOutput = $standardOutputTask.GetAwaiter().GetResult()
        $standardError = $standardErrorTask.GetAwaiter().GetResult()
        if ($standardOutput.Length -gt 0) {
            [Console]::Out.Write($standardOutput)
        }
        if ($standardError.Length -gt 0) {
            [Console]::Error.Write($standardError)
        }

        return $process.ExitCode
    }
    finally {
        $process.Dispose()
    }
}

if ($Group -eq 'All') {
    $selectedScripts = @($groupScripts.Keys | ForEach-Object { $groupScripts[$_] })
}
else {
    $selectedScripts = @($groupScripts[$Group])
}

foreach ($scriptPath in $selectedScripts) {
    if (-not (Test-Path -LiteralPath $scriptPath -PathType Leaf)) {
        $isMandatoryForSelection = ($Group -eq 'State' -and $scriptPath.EndsWith('Test-EntryFence.ps1', [System.StringComparison]::Ordinal)) -or
            ($Group -eq 'All' -and $mandatoryTaskOneScripts.Contains([System.IO.Path]::GetFullPath($scriptPath)))
        if ($isMandatoryForSelection) {
            [Console]::Error.WriteLine("Missing required test script: $scriptPath")
            exit 1
        }

        continue
    }

    $exitCode = Invoke-TestScript -Path $scriptPath
    if ($exitCode -ne 0) {
        exit $exitCode
    }
}

Write-Output "PASS: group $Group"
