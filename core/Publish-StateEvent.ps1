#Requires -Version 7.5
[CmdletBinding()]
param(
    [string] $Adapter,
    [string] $CompanionRoot = (Split-Path $PSScriptRoot -Parent),
    [string] $Principal,
    [switch] $RequireRecord,
    [switch] $Resync,
    [string] $RepairOperationId
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$entryLease = $null
$config = $null

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

$modulePath = Join-Path $PSScriptRoot 'DigestDiff.psm1'
if (-not (Test-Path -LiteralPath $modulePath)) { $modulePath = Join-Path $PSScriptRoot '../DigestDiff.psm1' }
Import-Module $modulePath -Force -DisableNameChecking

function Write-StateEventTerminal {
    param([Parameter(Mandatory)] $Diagnostic)

    try { $line = Format-StateEventDiagnosticLine -Script Publish -Diagnostic $Diagnostic }
    catch { $line = Format-StateEventDiagnosticLine -Script Publish -Diagnostic (New-TurnContextDiagnosticObject -Class protocol -ConsumptionState unknown -Detail (New-StateEventDetail -Script Publish -Class protocol -Reason attempt-result-invalid) -SourceIdentity $null -GenerationTimestamp $null -LockStage $null -OperationalWarnings (New-CompanionWarningSink -Profile TurnOperational)) }
    [Console]::Error.Write("$line`n")
    exit 1
}

function Write-StateEventConfigTerminal {
    param([Parameter(Mandatory)] [string] $Reason)

    Write-StateEventTerminal (New-TurnContextDiagnosticObject -Class config -ConsumptionState none -Detail (New-StateEventDetail -Script Publish -Class config -Reason $Reason) -SourceIdentity $null -GenerationTimestamp $null -LockStage $null -OperationalWarnings (New-CompanionWarningSink -Profile TurnOperational))
}

try {
    if (($PSBoundParameters.ContainsKey('CompanionRoot') -and -not [IO.Path]::IsPathFullyQualified($CompanionRoot)) -or -not [IO.Directory]::Exists([IO.Path]::GetFullPath($CompanionRoot))) { Write-StateEventConfigTerminal -Reason companion-root-invalid }
    $root = [IO.Path]::GetFullPath($CompanionRoot)
    if (-not (Test-CompanionOpaqueToken -Value $Principal)) { Write-StateEventConfigTerminal -Reason principal-invalid }
    $repairSupplied = $PSBoundParameters.ContainsKey('RepairOperationId')
    if (($Resync -and (-not $repairSupplied -or -not (Test-CompanionOpaqueToken -Value $RepairOperationId))) -or (-not $Resync -and $repairSupplied) -or ($Resync -and $RequireRecord)) { Write-StateEventConfigTerminal -Reason repair-operation-invalid }

    try { $config = Get-AdapterConfig -CompanionRoot $root -Adapter $Adapter -Profile Acquisition }
    catch { Write-StateEventConfigTerminal -Reason (Get-StateEventAdapterResolutionReason -Exception $_.Exception) }

    $operational = New-CompanionWarningSink -Profile TurnOperational
    # 7.6 advisory ownership preflight, without the lock: a non-owner ends as terminal config
    # before any refresh work, so an acquisition failure never masks the consumer reason. The
    # locked check inside consumption is authoritative.
    $ownership = Get-CompanionOwnershipFailure -CompanionRoot $root -Role runtime
    if ($null -ne $ownership) { Write-StateEventConfigTerminal -Reason $ownership }
    $attemptArguments = @{ CompanionRoot = $root; AdapterConfig = $config; OperationalWarnings = $operational; Principal = $Principal; RequireRecord = $RequireRecord; Resync = $Resync; RepairOperationId = $(if ($Resync) { $RepairOperationId } else { $null }) }
    $receiptWarnings = New-CompanionWarningSink -Profile StateEventReceipt
    $selected = Invoke-StateEventAttempt @attemptArguments -ReceiptWarnings $receiptWarnings
    if ((Test-StateEventOperationResult -Value $selected) -and $selected.stateEventOutcome -ceq 'failure' -and $selected.outcomeClass -ceq 'outbox-write:not-consumed') {
        # Only the first attempt's operational warnings survive into the retry.
        $receiptWarnings = New-CompanionWarningSink -Profile StateEventReceipt
        $selected = Invoke-StateEventAttempt @attemptArguments -ReceiptWarnings $receiptWarnings
    }

    if (-not (Test-StateEventOperationResult -Value $selected)) {
        [void] (Assert-TurnContextAttemptResult -Value $selected)
        Write-StateEventTerminal $selected.diagnostic
    }
    if ($selected.stateEventOutcome -ceq 'failure') {
        Write-StateEventTerminal (New-StateEventPublishDiagnostic -Result $selected -Class $selected.outcomeClass -Reason $selected.reason -ConsumptionState $selected.consumptionState -OperationalWarnings $operational)
    }
    $receiptJson = ConvertTo-StateEventReceiptJson -Result $selected -AdapterConfig $config -OperationalWarnings $operational -ReceiptWarnings $receiptWarnings
    # The record file, not this receipt, carries the transition: a failed stdout write is
    # a delivery failure whose consumption state says whether a record was committed.
    try { [Console]::Out.Write($receiptJson) }
    catch {
        $deliveryState = if ($selected.stateEventOutcome -ceq 'committed') { 'consumed' } else { 'none' }
        Write-StateEventTerminal (New-StateEventPublishDiagnostic -Result $selected -Class delivery -Reason stdout-write-failed -ConsumptionState $deliveryState -OperationalWarnings $operational)
    }
    exit 0
}
catch {
    Write-StateEventTerminal (New-TurnContextDiagnosticObject -Class protocol -ConsumptionState unknown -Detail (New-StateEventDetail -Script Publish -Class protocol -Reason attempt-result-invalid) -SourceIdentity $null -GenerationTimestamp $null -LockStage $null -OperationalWarnings (New-CompanionWarningSink -Profile TurnOperational))
}
finally {
    if ($null -ne $config) { $config.Dispose() }
    if ($null -ne $entryLease) { $entryLease.Dispose() }
}
