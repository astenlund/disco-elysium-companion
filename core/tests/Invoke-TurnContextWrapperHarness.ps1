#Requires -Version 7.5

[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidateSet('retry-success', 'retry-terminal')]
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
    param([Parameter(Mandatory)] [string] $OutcomeClass, [Parameter(Mandatory)] [string] $ConsumptionState, [Parameter(Mandatory)] [string] $EnvelopeJson)

    return [pscustomobject]@{
        outcomeClass = $OutcomeClass
        consumptionState = $ConsumptionState
        envelopeJson = $EnvelopeJson
        cacheDegraded = $false
        diagnostic = [ordered]@{
            outcomeClass = $OutcomeClass
            consumptionState = $ConsumptionState
            lockStage = $null
            sourceIdentity = $null
            generationTimestamp = $null
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
