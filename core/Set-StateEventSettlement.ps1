#Requires -Version 7.5
[CmdletBinding()]
param(
    [string] $CompanionRoot = (Split-Path $PSScriptRoot -Parent),
    [string] $LogicalOutboxId,
    [string] $RecordSha256,
    [string] $JournalId,
    [string] $EventId
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$entryLease = $null

# The migration entry fence gates every live entry script before configuration or
# state work; its fixed maintenance line sits outside the state-event protocol.
try {
    Import-Module (Join-Path $PSScriptRoot 'EntryFence.psm1') -Force
    $entryLease = Enter-CompanionEntryFence -CompanionRoot ([IO.Path]::GetFullPath($CompanionRoot))
}
catch {
    [Console]::Error.WriteLine('[maintenance] state extraction maintenance is active')
    exit 1
}

Import-Module (Join-Path $PSScriptRoot 'DigestDiff.psm1') -Force -DisableNameChecking

function Write-SettlementTerminal {
    param([Parameter(Mandatory)] [string] $Class, [Parameter(Mandatory)] [string] $Reason, [Parameter(Mandatory)] [string] $ConsumptionState, [Parameter(Mandatory)] [CompanionWarningSink] $OperationalWarnings)

    $lockStage = if ($Class -cin @('busy', 'lock')) { 'consume' } else { $null }
    try {
        $line = Format-StateEventDiagnosticLine -Script Settlement -Diagnostic (New-TurnContextDiagnosticObject -Class $Class -ConsumptionState $ConsumptionState -Detail (New-StateEventDetail -Script Settlement -Class $Class -Reason $Reason) -SourceIdentity $null -GenerationTimestamp $null -LockStage $lockStage -OperationalWarnings $OperationalWarnings)
    }
    catch {
        $line = Format-StateEventDiagnosticLine -Script Settlement -Diagnostic (New-TurnContextDiagnosticObject -Class protocol -ConsumptionState unknown -Detail attempt-result-invalid -SourceIdentity $null -GenerationTimestamp $null -LockStage $null -OperationalWarnings (New-CompanionWarningSink -Profile TurnOperational))
    }
    [Console]::Error.Write("$line`n")
    exit 1
}

$operational = New-CompanionWarningSink -Profile TurnOperational
try {
    if (($PSBoundParameters.ContainsKey('CompanionRoot') -and -not [IO.Path]::IsPathFullyQualified($CompanionRoot)) -or -not [IO.Directory]::Exists([IO.Path]::GetFullPath($CompanionRoot))) { Write-SettlementTerminal -Class config -Reason companion-root-invalid -ConsumptionState none -OperationalWarnings $operational }
    $root = [IO.Path]::GetFullPath($CompanionRoot)
    if (-not (Test-StateEventLogicalOutboxIdText -Value $LogicalOutboxId) -or -not (Test-StateEventSha256Text -Value $RecordSha256) -or -not (Test-CompanionOpaqueToken -Value $JournalId) -or -not (Test-CompanionOpaqueToken -Value $EventId)) { Write-SettlementTerminal -Class config -Reason settlement-argument-invalid -ConsumptionState none -OperationalWarnings $operational }
    try { [void] [IO.Directory]::CreateDirectory((Join-Path $root 'state')) }
    catch { Write-SettlementTerminal -Class lock -Reason lock-open-failed -ConsumptionState none -OperationalWarnings $operational }

    $result = Invoke-StateEventSettlement -CompanionRoot $root -LogicalOutboxId $LogicalOutboxId -RecordSha256 $RecordSha256 -JournalId $JournalId -EventId $EventId -OperationalWarnings $operational
    if ($null -eq $result.outcome) { Write-SettlementTerminal -Class $result.outcomeClass -Reason $result.reason -ConsumptionState none -OperationalWarnings $operational }
    $json = ConvertTo-CompanionJson -InputObject ([ordered]@{ outcome = $result.outcome; logicalOutboxId = $LogicalOutboxId }) -Budget config
    [void] (Read-StateEventSettlementResult -Json $json)
    try { [Console]::Out.Write($json) }
    catch { Write-SettlementTerminal -Class delivery -Reason stdout-write-failed -ConsumptionState none -OperationalWarnings $operational }
    exit 0
}
catch {
    Write-SettlementTerminal -Class protocol -Reason attempt-result-invalid -ConsumptionState unknown -OperationalWarnings (New-CompanionWarningSink -Profile TurnOperational)
}
finally {
    if ($null -ne $entryLease) { $entryLease.Dispose() }
}
