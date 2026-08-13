#Requires -Version 7.5

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:MaintenanceFailure = '[maintenance] state extraction maintenance is active'
$script:LockName = 'state-extraction-v2-entry-fence.lock'
$script:SentinelName = 'state-extraction-v2-maintenance.json'
$script:CheckpointName = 'state-extraction-v2-cutover.json'

function Stop-MaintenanceEntry {
    throw [System.InvalidOperationException]::new($script:MaintenanceFailure)
}

function Read-GateObject {
    param([Parameter(Mandatory)] [string] $Path)

    if (-not (Test-Path -LiteralPath $Path)) {
        return $null
    }

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        Stop-MaintenanceEntry
    }

    try {
        $text = [System.IO.File]::ReadAllText($Path, [System.Text.UTF8Encoding]::new($false, $true))
        $value = $text | ConvertFrom-Json -AsHashtable -DateKind String -ErrorAction Stop
        if ($value -isnot [hashtable]) {
            Stop-MaintenanceEntry
        }

        return $value
    }
    catch {
        Stop-MaintenanceEntry
    }
}

function Test-GateAdmission {
    param([Parameter(Mandatory)] [string] $TemporaryRoot)

    $sentinel = Read-GateObject -Path (Join-Path $TemporaryRoot $script:SentinelName)
    $checkpoint = Read-GateObject -Path (Join-Path $TemporaryRoot $script:CheckpointName)

    if ($null -eq $sentinel) {
        return $null -eq $checkpoint
    }

    if (-not $sentinel.ContainsKey('result') -or $sentinel.result -isnot [string] -or
        -not [string]::Equals($sentinel.result, 'maintenance', [System.StringComparison]::Ordinal) -or
        -not $sentinel.ContainsKey('bypassToken') -or $sentinel.bypassToken -isnot [string] -or
        $sentinel.bypassToken -cnotmatch '^[0-9a-f]{64}$') {
        Stop-MaintenanceEntry
    }

    $environmentToken = [Environment]::GetEnvironmentVariable('COMPANION_STATE_EXTRACTION_MAINTENANCE_TOKEN')
    return [string]::Equals($environmentToken, $sentinel.bypassToken, [System.StringComparison]::Ordinal)
}

function Initialize-LockFile {
    param([Parameter(Mandatory)] [string] $LockPath)

    if (Test-Path -LiteralPath $LockPath) {
        if (-not (Test-Path -LiteralPath $LockPath -PathType Leaf)) {
            Stop-MaintenanceEntry
        }

        return
    }

    try {
        $creator = [System.IO.File]::Open($LockPath, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::Read)
        $creator.Dispose()
    }
    catch [System.IO.IOException] {
        if (-not (Test-Path -LiteralPath $LockPath -PathType Leaf)) {
            Stop-MaintenanceEntry
        }
    }
    catch {
        Stop-MaintenanceEntry
    }
}

function Open-SharedLock {
    param([Parameter(Mandatory)] [string] $LockPath)

    $deadline = [DateTime]::UtcNow.AddSeconds(5)
    while ($true) {
        try {
            return [System.IO.File]::Open($LockPath, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
        }
        catch [System.IO.IOException] {
            if ([DateTime]::UtcNow -ge $deadline) {
                Stop-MaintenanceEntry
            }

            Start-Sleep -Milliseconds 25
        }
        catch {
            Stop-MaintenanceEntry
        }
    }
}

function Enter-CompanionEntryFence {
    [CmdletBinding()]
    param([Parameter(Mandatory)] [string] $CompanionRoot)

    try {
        $resolvedRoot = [System.IO.Path]::GetFullPath($CompanionRoot)
        if (-not (Test-Path -LiteralPath $resolvedRoot -PathType Container)) {
            Stop-MaintenanceEntry
        }

        $temporaryRoot = Join-Path $resolvedRoot '.tmp'
        [void] [System.IO.Directory]::CreateDirectory($temporaryRoot)
        if (-not (Test-GateAdmission -TemporaryRoot $temporaryRoot)) {
            Stop-MaintenanceEntry
        }

        $lockPath = Join-Path $temporaryRoot $script:LockName
        Initialize-LockFile -LockPath $lockPath
        $lease = Open-SharedLock -LockPath $lockPath
        try {
            if (-not (Test-GateAdmission -TemporaryRoot $temporaryRoot)) {
                Stop-MaintenanceEntry
            }

            return $lease
        }
        catch {
            $lease.Dispose()
            throw
        }
    }
    catch {
        if ([string]::Equals($_.Exception.Message, $script:MaintenanceFailure, [System.StringComparison]::Ordinal)) {
            throw
        }

        Stop-MaintenanceEntry
    }
}

Export-ModuleMember -Function Enter-CompanionEntryFence
