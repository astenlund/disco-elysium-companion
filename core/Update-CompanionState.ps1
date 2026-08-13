#Requires -Version 7.5
[CmdletBinding()]
param(
    [Parameter()] [string] $Adapter,
    [Parameter()] [string] $CompanionRoot = (Split-Path $PSScriptRoot -Parent)
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Write-OneShotFailure {
    param([Parameter(Mandatory)] [string] $Class, [Parameter(Mandatory)] [string] $Reason)

    [Console]::Error.WriteLine("[$Class] $Reason")
    exit 1
}

try {
    if (-not [IO.Path]::IsPathFullyQualified($CompanionRoot)) {
        Write-OneShotFailure -Class 'config' -Reason 'invalid-companion-root'
    }
    $root = [IO.Path]::GetFullPath($CompanionRoot)
    if (-not [IO.Directory]::Exists($root)) {
        Write-OneShotFailure -Class 'config' -Reason 'invalid-companion-root'
    }

    Import-Module (Join-Path $PSScriptRoot 'EntryFence.psm1') -Force
    $entryLease = Enter-CompanionEntryFence -CompanionRoot $root
    try {
        Import-Module (Join-Path $PSScriptRoot 'DigestDiff.psm1') -Force -DisableNameChecking
        $config = Get-AdapterConfig -CompanionRoot $root -Adapter $Adapter -Profile Acquisition
        try {
            Initialize-CompanionStateDirectories -CompanionRoot $root
            $warnings = New-CompanionWarningSink -Profile Cycle
            Invoke-WorkFileReaper -CompanionRoot $root -WarningSink $warnings
            $cycleLock = Enter-CompanionCycleLock -CompanionRoot $root
            try {
                $confirmed = Get-AdapterConfig -CompanionRoot $root -Adapter $config.AdapterName -Profile Acquisition
                try {
                    if (-not [string]::Equals($config.ConfigReceipt, $confirmed.ConfigReceipt, [StringComparison]::Ordinal)) {
                        Write-OneShotFailure -Class 'config' -Reason 'adapter-config-changed'
                    }
                }
                finally {
                    $confirmed.Dispose()
                }
                $newest = Get-NewestSave -SaveDirectory $config.SaveDirectory -SaveGlob $config.SaveGlob
                if ($null -eq $newest) {
                    Write-OneShotFailure -Class 'no-saves' -Reason 'no-matching-saves'
                }
                if (-not (Test-FileWriteStable -Path $newest.FullName)) {
                    Write-OneShotFailure -Class 'stability' -Reason 'stability-exhausted'
                }
                Initialize-CompanionStateDirectories -CompanionRoot $root
                Invoke-WorkFileReaper -CompanionRoot $root -WarningSink $warnings
                $outcome = Invoke-CompanionCycle -CompanionRoot $root -AdapterDirectory $config.AdapterDirectory -AdapterConfig $config -SourceSave $newest -WarningSink $warnings
                if (-not $outcome.Completed) {
                    Write-OneShotFailure -Class $outcome.FailurePhase -Reason ([string] $outcome.Detail)
                }
                foreach ($warning in $outcome.Warnings) {
                    [Console]::Error.WriteLine("[warning] $($warning.code)")
                }
            }
            finally {
                $cycleLock.Dispose()
            }
        }
        finally {
            $config.Dispose()
        }
    }
    finally {
        $entryLease.Dispose()
    }
}
catch [TimeoutException] {
    Write-OneShotFailure -Class 'busy' -Reason 'cycle-lock-timeout'
}
catch {
    if ($_.Exception.GetType().Name -ceq 'SaveCandidateLimitException') {
        Write-OneShotFailure -Class 'source' -Reason 'candidate-limit-exceeded'
    }
    if ($_.Exception.GetType().Name -ceq 'SaveSourceException') {
        Write-OneShotFailure -Class 'source' -Reason "source-$($_.Exception.SourceDisposition)"
    }
    if ($_.Exception.GetType().Name -ceq 'AdapterConfigurationException') {
        Write-OneShotFailure -Class 'config' -Reason 'adapter-config-invalid'
    }
    Write-OneShotFailure -Class 'source' -Reason 'save-enumeration-failed'
}
