#Requires -Version 7.5

[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidateSet('retry-success', 'retry-terminal', 'stdout-fail', 'degraded-select')]
    [string] $Scenario,

    [Parameter(Mandatory)]
    [string] $ScratchRoot,

    [Parameter(Mandatory)]
    [string] $StagedWrapperPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$harnessCore = Join-Path $ScratchRoot 'core'
[void] [IO.Directory]::CreateDirectory($harnessCore)

$wrapperPath = Join-Path $harnessCore 'Get-TurnContext.ps1'
[IO.File]::Copy($StagedWrapperPath, $wrapperPath, $true)
# The wrapper's entry-fence prologue resolves EntryFence.psm1 beside itself; stage
# the real module so the fence admits normally in the sentinel-free scratch root.
[IO.File]::Copy((Join-Path (Split-Path $StagedWrapperPath -Parent) 'EntryFence.psm1'), (Join-Path $harnessCore 'EntryFence.psm1'), $true)

$tracePath = Join-Path $ScratchRoot 'attempt-trace.txt'
$modulePath = Join-Path $harnessCore 'DigestDiff.psm1'
$module = @'
function New-TestResult {
    param([Parameter(Mandatory)] [string] $OutcomeClass, [Parameter(Mandatory)] [string] $ConsumptionState, [Parameter(Mandatory)] [string] $EnvelopeJson, [bool] $CacheDegraded = $false, $SourceIdentity = $null, $GenerationTimestamp = $null)

    return [pscustomobject]@{
        outcomeClass = $OutcomeClass
        consumptionState = $ConsumptionState
        envelopeJson = $EnvelopeJson
        cacheDegraded = $CacheDegraded
        diagnostic = [ordered]@{
            outcomeClass = $OutcomeClass
            consumptionState = $ConsumptionState
            lockStage = $null
            sourceIdentity = $SourceIdentity
            generationTimestamp = $GenerationTimestamp
            detail = 'test-terminal'
            warnings = @()
        }
    }
}

function Get-AdapterConfig {
    $config = [pscustomobject]@{}
    $config | Add-Member -MemberType ScriptMethod -Name Dispose -Value {}

    return $config
}

function New-CompanionWarningSink {
    $sink = [pscustomobject]@{}
    $sink | Add-Member -MemberType ScriptMethod -Name Freeze -Value { @() }

    return $sink
}

function Invoke-TurnContextAttempt {
    param([string] $CompanionRoot, $AdapterConfig, $OperationalWarnings)

    $tracePath = Join-Path $CompanionRoot 'attempt-trace.txt'
    $attempt = if (Test-Path -LiteralPath $tracePath) { 2 } else { 1 }
    [IO.File]::AppendAllText($tracePath, "$attempt`n", [Text.UTF8Encoding]::new($false, $true))
    if ($env:TURN_CONTEXT_WRAPPER_SCENARIO -ceq 'stdout-fail') {
        # A parent-side broken stdout pipe is NOT observable here: .NET's Windows
        # console stream silently swallows ERROR_NO_DATA/ERROR_BROKEN_PIPE. Swap in
        # a writer over a disposed stream instead, so the wrapper's single envelope
        # write genuinely throws at delivery time.
        $brokenStream = [IO.MemoryStream]::new()
        $brokenWriter = [IO.StreamWriter]::new($brokenStream)
        $brokenWriter.AutoFlush = $true
        $brokenStream.Dispose()
        [Console]::SetOut($brokenWriter)

        # Model the real success attempt, whose diagnostic latches the frozen target's
        # source identity (state.source) and generation (state.generatedAt). The wrapper
        # must carry this authoritative consumed-target provenance into the delivery
        # diagnostic on a failed stdout write.
        $consumedIdentity = [ordered]@{ domainId = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'; saveFile = 'B.ntwtf.zip'; savedAt = '2026-08-10T11:00:00.0000000Z' }

        return New-TestResult -OutcomeClass 'success' -ConsumptionState 'consumed' -EnvelopeJson '{"attempt":"A"}' -SourceIdentity $consumedIdentity -GenerationTimestamp '2026-08-10T12:00:00.0000000Z'
    }
    if ($env:TURN_CONTEXT_WRAPPER_SCENARIO -ceq 'degraded-select') {
        return New-TestResult -OutcomeClass 'reset-write:consumed' -ConsumptionState 'consumed' -EnvelopeJson '{"attempt":"A"}' -CacheDegraded $true
    }
    if ($attempt -eq 1) {
        return New-TestResult -OutcomeClass 'reset-write:not-consumed' -ConsumptionState 'notConsumed' -EnvelopeJson '{"attempt":"A"}'
    }

    if ($env:TURN_CONTEXT_WRAPPER_SCENARIO -ceq 'retry-success') {
        return New-TestResult -OutcomeClass 'success' -ConsumptionState 'consumed' -EnvelopeJson '{"attempt":"B"}'
    }

    return New-TestResult -OutcomeClass 'freshness' -ConsumptionState 'none' -EnvelopeJson '{"attempt":"B"}'
}

function Assert-TurnContextAttemptResult {
    param($Value)
}

function Read-TurnContextEnvelope {
    param([string] $Json, $AdapterConfig, [bool] $ExpectedCacheDegraded)
}

function Read-TurnContextDiagnostic {
    param([string] $Json, [string] $ExpectedClass)
}

function New-TurnContextDetail {
    param([string] $Class, [string] $Reason, $Atoms)

    return $Reason
}

function New-TurnContextDiagnosticObject {
    param([string] $Class, [string] $ConsumptionState, $Detail, $SourceIdentity, $GenerationTimestamp, $LockStage, $OperationalWarnings)

    return [ordered]@{ outcomeClass = $Class; consumptionState = $ConsumptionState; lockStage = $null; sourceIdentity = $SourceIdentity; generationTimestamp = $GenerationTimestamp; detail = $Detail; warnings = @() }
}

function ConvertTo-CompanionJson {
    param($InputObject, [string] $Budget)

    return $InputObject | ConvertTo-Json -Depth 8 -Compress
}

Export-ModuleMember -Function *
'@
[IO.File]::WriteAllText($modulePath, $module, [Text.UTF8Encoding]::new($false, $true))

$priorScenario = $env:TURN_CONTEXT_WRAPPER_SCENARIO
try {
    $env:TURN_CONTEXT_WRAPPER_SCENARIO = $Scenario
    & $wrapperPath -CompanionRoot $ScratchRoot
    $exitCode = $LASTEXITCODE
}
finally {
    $env:TURN_CONTEXT_WRAPPER_SCENARIO = $priorScenario
}

exit $exitCode
