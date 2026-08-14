#Requires -Version 7.5
[CmdletBinding()]
param(
    [Parameter()] [string] $Adapter,
    [Parameter()] [switch] $Peek,
    [Parameter()] [string] $CompanionRoot = (Split-Path $PSScriptRoot -Parent)
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$config = $null
$entryLease = $null

function Write-GetDiffFailure {
    param([Parameter(Mandatory)] [string] $Class, [Parameter(Mandatory)] [string] $Detail)

    [Console]::Error.WriteLine("get-diff: [$Class] $Detail")
    exit 1
}

if ($PSBoundParameters.ContainsKey('CompanionRoot') -and -not [IO.Path]::IsPathFullyQualified($CompanionRoot)) {
    Write-GetDiffFailure -Class 'config' -Detail 'companion-root-not-fully-qualified'
}
$root = [IO.Path]::GetFullPath($CompanionRoot)

try {
    Import-Module (Join-Path $PSScriptRoot 'EntryFence.psm1') -Force
    $entryLease = Enter-CompanionEntryFence -CompanionRoot $root
}
catch {
    Write-GetDiffFailure -Class 'maintenance' -Detail 'state-extraction-maintenance-active'
}

try {
    Import-Module (Join-Path $PSScriptRoot 'DigestDiff.psm1') -DisableNameChecking -Force
    try {
        $config = Get-AdapterConfig -CompanionRoot $root -Adapter $Adapter -Profile StateCompatibility
    }
    catch {
        Write-GetDiffFailure -Class 'config' -Detail 'adapter-configuration-invalid'
    }

    try {
        $advisory = Read-CompanionCurrent -CompanionRoot $root -AdapterConfig $config
    }
    catch {
        Write-GetDiffFailure -Class 'missing-current' -Detail 'run-update-companion-state'
    }
    if ($advisory.outcome -eq 'absent') {
        Write-GetDiffFailure -Class 'missing-current' -Detail 'run-update-companion-state'
    }
    if ($advisory.outcome -eq 'stale') {
        Write-GetDiffFailure -Class 'stale-current' -Detail 'run-update-companion-state'
    }
    if ($advisory.outcome -ne 'valid') {
        Write-GetDiffFailure -Class 'freshness' -Detail $advisory.reason
    }

    if ($Peek) {
        $baselineRead = Read-CompanionBaseline -CompanionRoot $root
        if ($baselineRead.outcome -eq 'infrastructure-failure') {
            Write-GetDiffFailure -Class 'compute' -Detail 'baseline-read-failed'
        }
        $baseline = $baselineRead.document
        if ($null -ne $baseline) {
            $relation = Compare-SourceIdentity -Left $advisory.document.Materialized['source'] -Right $baseline.Materialized['source']
            if ($relation.comparable -and $relation.order -lt 0) {
                Write-GetDiffFailure -Class 'stale-target' -Detail 'target-precedes-baseline'
            }
        }
        try {
            $diff = Compare-Digests -Baseline $baseline -Target $advisory.document -AdapterConfig $config -WarningSink (New-CompanionWarningSink -Profile GetDiff)
            Assert-DiffSemantics -Diff $diff -Baseline $baseline -Target $advisory.document -AdapterConfig $config
            [Console]::Out.Write((ConvertTo-CompanionJson -InputObject $diff.RootElement -Budget diff))
        }
        catch {
            Write-GetDiffFailure -Class 'compute' -Detail 'diff-computation-failed'
        }

        exit 0
    }

    $sink = New-CompanionWarningSink -Profile GetDiff
    $result = Invoke-CompanionConsumption -AdapterConfig $config -CompanionRoot $root -DeliveryMode rawStdout -WarningSink $sink
    # Drain the attempt-local warnings (pipeline-baseline-absent, consume-cache-fallback,
    # diff-exclude-path-unused) to stderr so they are not silently dropped.
    foreach ($warning in @($sink.Freeze())) {
        [Console]::Error.WriteLine("get-diff: warning: $($warning.code)" + $(if ($null -ne $warning.detail) { ": $($warning.detail)" } else { '' }))
    }
    if ($result.outcomeClass -eq 'success') {
        exit 0
    }
    Write-GetDiffFailure -Class $result.outcomeClass -Detail $result.detail
}
finally {
    if ($null -ne $config) {
        $config.Dispose()
    }
    if ($null -ne $entryLease) {
        $entryLease.Dispose()
    }
}
