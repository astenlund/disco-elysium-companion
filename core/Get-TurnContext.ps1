#Requires -Version 7.5
[CmdletBinding()]
param([string] $Adapter, [string] $CompanionRoot = (Split-Path $PSScriptRoot -Parent))

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$entryLease = $null

# The migration entry fence gates every live entry script before configuration or
# state work; its fixed maintenance line sits outside the turn-context protocol.
try {
    Import-Module (Join-Path $PSScriptRoot 'EntryFence.psm1') -Force
    $entryLease = Enter-CompanionEntryFence -CompanionRoot ([IO.Path]::GetFullPath($CompanionRoot))
}
catch {
    [Console]::Error.WriteLine('[maintenance] state extraction maintenance is active')
    exit 1
}

# Resolve the module beside the deployed entry script (core/DigestDiff.psm1).
$modulePath = Join-Path $PSScriptRoot 'DigestDiff.psm1'
if (-not (Test-Path -LiteralPath $modulePath)) { $modulePath = Join-Path $PSScriptRoot '../DigestDiff.psm1' }
Import-Module $modulePath -Force -DisableNameChecking

function Write-TurnContextTerminal {
    param([Parameter(Mandatory)] $Diagnostic)

    $json = ConvertTo-CompanionJson -InputObject $Diagnostic -Budget config
    [Console]::Error.Write("[turn-context:$($Diagnostic.outcomeClass)] $json`n")
    exit 1
}

try {
    $config = Get-AdapterConfig -CompanionRoot ([IO.Path]::GetFullPath($CompanionRoot)) -Adapter $Adapter -Profile Acquisition
}
catch {
    $sink = New-CompanionWarningSink -Profile TurnOperational
    Write-TurnContextTerminal (New-TurnContextDiagnosticObject -Class 'config' -ConsumptionState 'none' -Detail (New-TurnContextDetail -Class config -Reason adapter-resolution-failed) -SourceIdentity $null -GenerationTimestamp $null -LockStage $null -OperationalWarnings $sink)
}

try {
    $operational = New-CompanionWarningSink -Profile TurnOperational
    $first = Invoke-TurnContextAttempt -CompanionRoot ([IO.Path]::GetFullPath($CompanionRoot)) -AdapterConfig $config -OperationalWarnings $operational
    [void] (Assert-TurnContextAttemptResult -Value $first)
    $selected = $first
    if ($first.outcomeClass -ceq 'reset-write:not-consumed') {
        [void] (Read-TurnContextEnvelope -Json $first.envelopeJson -AdapterConfig $config -ExpectedCacheDegraded $false)
        $selected = Invoke-TurnContextAttempt -CompanionRoot ([IO.Path]::GetFullPath($CompanionRoot)) -AdapterConfig $config -OperationalWarnings $operational
        [void] (Assert-TurnContextAttemptResult -Value $selected)
    }
    if ($selected.outcomeClass -in @('success', 'reset-write:consumed')) {
        [void] (Read-TurnContextEnvelope -Json $selected.envelopeJson -AdapterConfig $config -ExpectedCacheDegraded $selected.cacheDegraded)
        # A failed stdout write is a delivery failure, not a protocol defect: the
        # baseline has already advanced, so the terminal diagnostic preserves the
        # consumed state and the host discards any partial envelope bytes.
        try { [Console]::Out.Write($selected.envelopeJson) }
        catch { Write-TurnContextTerminal (New-TurnContextDiagnosticObject -Class 'delivery' -ConsumptionState $selected.consumptionState -Detail (New-TurnContextDetail -Class delivery -Reason stdout-write-failed) -SourceIdentity $null -GenerationTimestamp $null -LockStage $null -OperationalWarnings $operational) }
        exit 0
    }
    $diagnosticJson = ConvertTo-CompanionJson -InputObject $selected.diagnostic -Budget config
    [void] (Read-TurnContextDiagnostic -Json $diagnosticJson -ExpectedClass $selected.outcomeClass)
    Write-TurnContextTerminal $selected.diagnostic
}
catch {
    $sink = New-CompanionWarningSink -Profile TurnOperational
    Write-TurnContextTerminal (New-TurnContextDiagnosticObject -Class 'protocol' -ConsumptionState 'unknown' -Detail (New-TurnContextDetail -Class protocol -Reason attempt-result-invalid) -SourceIdentity $null -GenerationTimestamp $null -LockStage $null -OperationalWarnings $sink)
}
finally {
    if ($null -ne $config) { $config.Dispose() }
    if ($null -ne $entryLease) { $entryLease.Dispose() }
}
