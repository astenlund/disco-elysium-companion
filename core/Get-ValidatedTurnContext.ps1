#Requires -Version 7.5
[CmdletBinding()]
param(
    [string] $Adapter,
    [string] $CompanionRoot = (Split-Path $PSScriptRoot -Parent),
    [Parameter(DontShow)] [string] $PowerShellExecutable = [System.Environment]::ProcessPath,
    [Parameter(DontShow)] [int] $TimeoutSeconds = 3600,
    [Parameter(DontShow)] [int] $StandardOutputMaximumBytes = 33554432,
    [Parameter(DontShow)] [int] $StandardErrorMaximumBytes = 65536,
    [Parameter(DontShow)] [switch] $FailCaptureSetup,
    [Parameter(DontShow)] [switch] $FailProcessWait,
    [Parameter(DontShow)] [int] $OutputFailureAfterBytes = -1,
    [Parameter(DontShow)] [ValidateSet('', 'Kill', 'BlockKill', 'CloseStandardOutput', 'CloseStandardError')] [string] $TeardownFailureOperation = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Import-Module (Join-Path $PSScriptRoot 'DigestDiff.psm1') -Force -DisableNameChecking
function Write-ValidatedTurnContextTerminal {
    param(
        [Parameter(Mandatory)] [ValidateSet('protocol', 'delivery')] [string] $Class,
        [Parameter(Mandatory)] [string] $ConsumptionState,
        [Parameter(Mandatory)] [string] $Reason,
        [AllowNull()] $SourceIdentity,
        [AllowNull()] $GenerationTimestamp
    )

    $warnings = New-CompanionWarningSink -Profile TurnOperational
    $detail = New-TurnContextDetail -Class $Class -Reason $Reason
    $diagnosticArguments = @{
        Class = $Class
        ConsumptionState = $ConsumptionState
        Detail = $detail
        SourceIdentity = $SourceIdentity
        GenerationTimestamp = $GenerationTimestamp
        LockStage = $null
        OperationalWarnings = $warnings
    }
    $diagnostic = New-TurnContextDiagnosticObject @diagnosticArguments
    $json = ConvertTo-CompanionJson -InputObject $diagnostic -Budget config
    [Console]::Error.Write("[turn-context:$Class] $json`n")
    exit 1
}

function Stop-ValidatedTurnContextChild {
    param(
        [Parameter(Mandatory)] [System.Diagnostics.Process] $Process,
        [System.Threading.CancellationTokenSource] $PumpCancellation,
        [System.Threading.Tasks.Task[]] $TransportTasks,
        [string] $FailureOperation = ''
    )

    $teardownTask = [CompanionProcessTeardown]::RunAsync($Process, $Process.StandardOutput.BaseStream, $Process.StandardError.BaseStream, $PumpCancellation, @($TransportTasks), $FailureOperation)
    $graceTask = [System.Threading.Tasks.Task]::Delay([System.TimeSpan]::FromSeconds(5))
    [void] [System.Threading.Tasks.Task]::WhenAny(@($teardownTask, $graceTask)).GetAwaiter().GetResult()
}

$maximumTimeoutSeconds = 3600
$maximumStandardOutputBytes = 33554432
$maximumStandardErrorBytes = 65536
$legalChildTerminalClasses = @('config', 'busy', 'lock', 'stale-target', 'no-saves', 'stability', 'source', 'dump', 'digest', 'refresh', 'freshness', 'compute', 'reset-write:not-consumed', 'protocol', 'delivery')
try {
    if (-not [System.IO.Path]::IsPathFullyQualified($CompanionRoot) -or $TimeoutSeconds -lt 1 -or $TimeoutSeconds -gt $maximumTimeoutSeconds -or $StandardOutputMaximumBytes -lt 1 -or $StandardOutputMaximumBytes -gt $maximumStandardOutputBytes -or $StandardErrorMaximumBytes -lt 1 -or $StandardErrorMaximumBytes -gt $maximumStandardErrorBytes -or $OutputFailureAfterBytes -lt -1) {
        Write-ValidatedTurnContextTerminal -Class protocol -ConsumptionState none -Reason attempt-result-invalid
    }
    $root = [System.IO.Path]::GetFullPath($CompanionRoot)
    if (-not [System.IO.Directory]::Exists($root)) {
        Write-ValidatedTurnContextTerminal -Class protocol -ConsumptionState none -Reason attempt-result-invalid
    }
}
catch {
    Write-ValidatedTurnContextTerminal -Class protocol -ConsumptionState none -Reason attempt-result-invalid
}

$startInfo = [System.Diagnostics.ProcessStartInfo]::new()
$startInfo.FileName = $PowerShellExecutable
$startInfo.WorkingDirectory = $root
$startInfo.UseShellExecute = $false
$startInfo.RedirectStandardOutput = $true
$startInfo.RedirectStandardError = $true
$strictUtf8 = [System.Text.UTF8Encoding]::new($false, $true)
foreach ($argument in @('-NoProfile', '-File', (Join-Path $PSScriptRoot 'Get-TurnContext.ps1'), '-CompanionRoot', $root)) {
    $startInfo.ArgumentList.Add($argument)
}
if (-not [string]::IsNullOrEmpty($Adapter)) {
    $startInfo.ArgumentList.Add('-Adapter')
    $startInfo.ArgumentList.Add($Adapter)
}

$process = $null
try {
    $process = [System.Diagnostics.Process]::Start($startInfo)
}
catch {
    Write-ValidatedTurnContextTerminal -Class protocol -ConsumptionState none -Reason attempt-result-invalid
}
if ($null -eq $process) {
    Write-ValidatedTurnContextTerminal -Class protocol -ConsumptionState none -Reason attempt-result-invalid
}
$pumpCancellation = $null
$deadlineCancellation = $null
$transportTasks = [System.Collections.Generic.List[System.Threading.Tasks.Task]]::new()
$transportFailed = $true
try {
    $pumpCancellation = [System.Threading.CancellationTokenSource]::new()
    $deadlineCancellation = [System.Threading.CancellationTokenSource]::new()
    if ($FailCaptureSetup) {
        throw [System.InvalidOperationException]::new('Injected capture setup failure.')
    }
    $captureFailure = [System.Threading.Tasks.TaskCompletionSource[bool]]::new([System.Threading.Tasks.TaskCreationOptions]::RunContinuationsAsynchronously)
    $standardOutputTask = [CompanionBoundedBytePump]::ReadAsync($process.StandardOutput.BaseStream, $StandardOutputMaximumBytes, $captureFailure, $pumpCancellation.Token)
    $transportTasks.Add($standardOutputTask)
    $standardErrorTask = [CompanionBoundedBytePump]::ReadAsync($process.StandardError.BaseStream, $StandardErrorMaximumBytes, $captureFailure, $pumpCancellation.Token)
    $transportTasks.Add($standardErrorTask)
    if ($FailProcessWait) {
        $exitTask = [System.Threading.Tasks.Task]::FromException([System.InvalidOperationException]::new('Injected process-wait failure.'))
    }
    else {
        $exitTask = $process.WaitForExitAsync()
    }
    $transportTasks.Add($exitTask)
    $completionTask = [System.Threading.Tasks.Task]::WhenAll(@($exitTask, $standardOutputTask, $standardErrorTask))
    $timeoutTask = [System.Threading.Tasks.Task]::Delay([System.TimeSpan]::FromSeconds($TimeoutSeconds), $deadlineCancellation.Token)
    $completedTask = [System.Threading.Tasks.Task]::WhenAny(@($completionTask, $timeoutTask, $captureFailure.Task)).GetAwaiter().GetResult()
    if ([object]::ReferenceEquals($completedTask, $completionTask) -and $completionTask.IsCompletedSuccessfully) {
        $standardOutputCapture = $standardOutputTask.GetAwaiter().GetResult()
        $standardErrorCapture = $standardErrorTask.GetAwaiter().GetResult()
        if (-not $standardOutputCapture.Overflow -and -not $standardErrorCapture.Overflow) {
            $standardOutputBytes = $standardOutputCapture.Bytes
            $standardErrorBytes = $standardErrorCapture.Bytes
            $standardOutput = $strictUtf8.GetString($standardOutputBytes)
            $standardError = $strictUtf8.GetString($standardErrorBytes)
            $exitCode = $process.ExitCode
            $transportFailed = $false
        }
    }
}
catch {
    $transportFailed = $true
}
finally {
    if ($transportFailed) {
        try {
            Stop-ValidatedTurnContextChild -Process $process -PumpCancellation $pumpCancellation -TransportTasks $transportTasks.ToArray() -FailureOperation $TeardownFailureOperation
        }
        catch {
            # The outer transport failure remains authoritative if teardown setup fails.
        }
    }
    if ($null -ne $deadlineCancellation) {
        try {
            $deadlineCancellation.Cancel()
        }
        catch {
            # Timer cleanup is best-effort after the transport result is latched.
        }
        try {
            $deadlineCancellation.Dispose()
        }
        catch {
            $transportFailed = $true
        }
    }
    if ($null -ne $pumpCancellation -and -not $transportFailed) {
        try {
            $pumpCancellation.Dispose()
        }
        catch {
            $transportFailed = $true
        }
    }
    if (-not $transportFailed) {
        try {
            $process.Dispose()
        }
        catch {
            $transportFailed = $true
        }
    }
}
if ($transportFailed) {
    Write-ValidatedTurnContextTerminal -Class protocol -ConsumptionState unknown -Reason attempt-result-invalid
}

if ($exitCode -ne 0) {
    if ($exitCode -ne 1 -or -not $standardError.EndsWith("`n", [System.StringComparison]::Ordinal)) {
        Write-ValidatedTurnContextTerminal -Class protocol -ConsumptionState unknown -Reason attempt-result-invalid
    }
    $terminalLine = $standardError.Substring(0, $standardError.Length - 1)
    if ($terminalLine.EndsWith("`r", [System.StringComparison]::Ordinal)) {
        $terminalLine = $terminalLine.Substring(0, $terminalLine.Length - 1)
    }
    if ($terminalLine.IndexOfAny([char[]] "`r`n") -ge 0 -or -not $terminalLine.StartsWith('[turn-context:', [System.StringComparison]::Ordinal)) {
        Write-ValidatedTurnContextTerminal -Class protocol -ConsumptionState unknown -Reason attempt-result-invalid
    }
    $prefixEnd = $terminalLine.IndexOf('] ', [System.StringComparison]::Ordinal)
    if ($prefixEnd -le '[turn-context:'.Length) {
        Write-ValidatedTurnContextTerminal -Class protocol -ConsumptionState unknown -Reason attempt-result-invalid
    }
    $class = $terminalLine.Substring('[turn-context:'.Length, $prefixEnd - '[turn-context:'.Length)
    if ($class -cnotin $legalChildTerminalClasses) {
        Write-ValidatedTurnContextTerminal -Class protocol -ConsumptionState unknown -Reason attempt-result-invalid
    }
    $diagnosticJson = $terminalLine.Substring($prefixEnd + 2)
    try {
        [void] (Read-TurnContextDiagnostic -Json $diagnosticJson -ExpectedClass $class)
    }
    catch {
        Write-ValidatedTurnContextTerminal -Class protocol -ConsumptionState unknown -Reason attempt-result-invalid
    }
    if ($standardOutput.Length -ne 0 -and -not [string]::Equals($class, 'delivery', [System.StringComparison]::Ordinal)) {
        Write-ValidatedTurnContextTerminal -Class protocol -ConsumptionState unknown -Reason attempt-result-invalid
    }
    [Console]::OpenStandardError().Write($standardErrorBytes, 0, $standardErrorBytes.Length)
    exit 1
}

if ($standardError.Length -ne 0) {
    Write-ValidatedTurnContextTerminal -Class protocol -ConsumptionState consumed -Reason envelope-invalid
}

$config = $null
try {
    $envelope = Read-TurnContextEnvelope -Json $standardOutput -TransportOnly
    $config = Get-AdapterConfig -CompanionRoot $root -Adapter $Adapter -Profile Acquisition
    [void] (Read-TurnContextEnvelope -Json $standardOutput -AdapterConfig $config -ExpectedCacheDegraded $envelope.RootElement.GetProperty('cacheDegraded').GetBoolean())
}
catch {
    Write-ValidatedTurnContextTerminal -Class protocol -ConsumptionState consumed -Reason envelope-invalid
}
finally {
    if ($null -ne $config) {
        $config.Dispose()
    }
}

try {
    $output = [Console]::OpenStandardOutput()
    if ($OutputFailureAfterBytes -ge 0) {
        $partialLength = [System.Math]::Min($OutputFailureAfterBytes, $standardOutputBytes.Length)
        $output.Write($standardOutputBytes, 0, $partialLength)
        $output.Flush()
        throw [System.IO.IOException]::new('Injected final stdout failure.')
    }
    $output.Write($standardOutputBytes, 0, $standardOutputBytes.Length)
    $output.Flush()
}
catch {
    $validatedState = $envelope.Materialized['state']
    Write-ValidatedTurnContextTerminal -Class delivery -ConsumptionState consumed -Reason stdout-write-failed -SourceIdentity $validatedState['source'] -GenerationTimestamp $validatedState['generatedAt']
}
