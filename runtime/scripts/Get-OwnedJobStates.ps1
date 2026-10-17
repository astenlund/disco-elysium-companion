#Requires -Version 7.5
[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string] $JobNamesJson,
    [string] $OwnedJobName,
    [ValidateRange(0, 2147483647)] [int] $OwnedProcessId = 0,
    [ValidateRange(0, 2147483647)] [int] $OwnedBrokerProcessId = 0,
    [string] $OwnedProcessCreated
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$scriptName = [IO.Path]::GetFileNameWithoutExtension($PSCommandPath)

try {
    $document = [Text.Json.JsonDocument]::Parse($JobNamesJson)
    try {
        $root = $document.RootElement
        if ($root.ValueKind -ne [Text.Json.JsonValueKind]::Array) { throw [FormatException]::new('Job names must be an array.') }
        $names = @($root.EnumerateArray() | ForEach-Object {
            if ($_.ValueKind -ne [Text.Json.JsonValueKind]::String) { throw [FormatException]::new('A job name is invalid.') }
            $_.GetString()
        })
        if ($names.Count -lt 1 -or $names.Count -gt 8) { throw [FormatException]::new('Job count is invalid.') }
        $unique = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
        foreach ($name in $names) {
            if ([string]::IsNullOrEmpty($name) -or -not $unique.Add($name)) { throw [FormatException]::new('A job name is repeated or empty.') }
        }
    }
    finally { $document.Dispose() }
    Add-Type -Path (Join-Path $PSScriptRoot 'NativeJobs.cs')
    $jobs = foreach ($name in $names) {
        $count = [Companion.Runtime.NativeJobs]::Observe($name)
        [ordered]@{ name = $name; state = if ($null -eq $count) { 'absent' } else { 'present' }; processes = $count }
    }
    $result = [ordered]@{ jobs = @($jobs) }
    if ($PSBoundParameters.ContainsKey('OwnedJobName') -or $PSBoundParameters.ContainsKey('OwnedProcessId') -or
        $PSBoundParameters.ContainsKey('OwnedBrokerProcessId') -or
        $PSBoundParameters.ContainsKey('OwnedProcessCreated')) {
        if ([string]::IsNullOrEmpty($OwnedJobName) -or $OwnedProcessId -lt 1 -or
            $OwnedBrokerProcessId -lt 1 -or $OwnedBrokerProcessId -eq $OwnedProcessId -or
            $OwnedProcessCreated -cnotmatch '^[1-9][0-9]{0,18}$' -or $names -cnotcontains $OwnedJobName) {
            throw [FormatException]::new('Owned startup process identity is invalid.')
        }
        Add-Type -Path (Join-Path $PSScriptRoot 'NativeProcessIdentity.cs')
        $members = [Companion.Runtime.NativeJobs]::Members($OwnedJobName)
        $identity = [Companion.Runtime.NativeProcessIdentity]::Read($OwnedProcessId)
        $brokerIdentity = [Companion.Runtime.NativeProcessIdentity]::Read($OwnedBrokerProcessId)
        $expectedMembers = $null -ne $identity -and $null -ne $brokerIdentity -and
            $members.Count -ge 2 -and $members.Count -le 3 -and
            $members -contains $OwnedProcessId -and $members -contains $OwnedBrokerProcessId
        if ($expectedMembers -and $members.Count -eq 3) {
            $consolePid = @($members | Where-Object { $_ -ne $OwnedProcessId -and $_ -ne $OwnedBrokerProcessId })
            $console = @(Get-CimInstance Win32_Process -Filter "ProcessId = $($consolePid[0])")
            $expectedMembers = $consolePid.Count -eq 1 -and $console.Count -eq 1 -and
                $console[0].ParentProcessId -eq $OwnedProcessId -and
                [StringComparer]::OrdinalIgnoreCase.Equals([string] $console[0].ExecutablePath,
                    (Join-Path ([Environment]::SystemDirectory) 'conhost.exe'))
        }
        $finalMembers = [Companion.Runtime.NativeJobs]::Members($OwnedJobName)
        $after = [Companion.Runtime.NativeJobs]::Observe($OwnedJobName)
        $result.owned = $expectedMembers -and $after -eq $members.Count -and
            $finalMembers.Count -eq $members.Count -and
            @($finalMembers | Where-Object { $members -notcontains $_ }).Count -eq 0 -and
            [string]::CompareOrdinal($identity.Created, $OwnedProcessCreated) -eq 0
    }
    [Console]::Out.Write((ConvertTo-Json -InputObject $result -Depth 4 -Compress))
    exit 0
}
catch {
    [Console]::Error.WriteLine("${scriptName}: job-state-unavailable")
    exit 1
}
