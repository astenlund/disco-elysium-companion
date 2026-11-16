param(
    [Parameter(Mandatory)][string]$Root,
    [Parameter(Mandatory)][string]$Script,
    [Parameter(Mandatory)][ValidateSet('kill', 'suspend', 'find')][string]$Action,
    [int]$WaitMs = 60000,
    [int]$DelayMs = 0
)
# Waits for a pwsh process whose command line names both the copied root and the script, then acts on it. Prints one JSON
# line: the pid acted on, or found:false when the wait expired. Its own command line names both strings too, so this
# helper and any sibling instance of it are excluded from the match.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Add-Type -Namespace StartupGates -Name Native -MemberDefinition @'
[DllImport("ntdll.dll")] public static extern int NtSuspendProcess(IntPtr handle);
'@
$self = Split-Path -Leaf $PSCommandPath
$deadline = [DateTime]::UtcNow.AddMilliseconds($WaitMs)
$target = $null
while ($null -eq $target -and [DateTime]::UtcNow -lt $deadline) {
    $target = Get-CimInstance Win32_Process -Filter "Name = 'pwsh.exe'" |
        Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and -not $_.CommandLine.Contains($self) -and $_.CommandLine.Contains($Script) -and $_.CommandLine.Contains($Root) } |
        Select-Object -First 1
    if ($null -eq $target) { Start-Sleep -Milliseconds 50 }
}
if ($null -eq $target) { [pscustomobject]@{ found = $false } | ConvertTo-Json -Compress; exit 1 }
$seenAt = [DateTime]::UtcNow
if ($DelayMs -gt 0) { Start-Sleep -Milliseconds $DelayMs }
$process = [Diagnostics.Process]::GetProcessById([int]$target.ProcessId)
$status = 0
switch ($Action) {
    'kill' { $process.Kill() }
    'suspend' { $status = [StartupGates.Native]::NtSuspendProcess($process.Handle) }
}
[pscustomobject]@{ found = $true; pid = [int]$target.ProcessId; action = $Action; status = $status; seenAt = $seenAt.ToString('o'); actedAt = [DateTime]::UtcNow.ToString('o') } | ConvertTo-Json -Compress
