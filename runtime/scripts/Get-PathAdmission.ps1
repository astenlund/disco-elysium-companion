#Requires -Version 7.5
[CmdletBinding(DefaultParameterSetName = 'One')]
param(
    [Parameter(Mandatory)] [string] $Root,
    [Parameter(Mandatory, ParameterSetName = 'One')] [string] $Path,
    [Parameter(Mandatory, ParameterSetName = 'Many')] [string] $TargetsJson,
    [switch] $AllowMissing
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$scriptName = [IO.Path]::GetFileNameWithoutExtension($PSCommandPath)

try {
    if (-not $IsWindows) { throw [PlatformNotSupportedException]::new('Windows metadata is required.') }
    Add-Type -Path (Join-Path $PSScriptRoot 'NativeFiles.cs')
    function Read-Admission {
        param([string] $Target)
        $admission = [Companion.Runtime.NativeFiles]::AdmitWithin($Root, $Target, $AllowMissing.IsPresent)
        $kind = if (-not $admission.Exists) { $null } elseif ($admission.IsDirectory) { 'directory' } else { 'file' }

        return [ordered]@{
            path = $admission.Path
            exists = $admission.Exists
            kind = $kind
            links = if ($admission.Exists) { $admission.Links } else { $null }
            volume = if ($admission.Exists) { $admission.Volume } else { $null }
            identity = if ($admission.Exists) { $admission.Identity } else { $null }
            missing = @($admission.Missing)
        }
    }
    if ($PSCmdlet.ParameterSetName -ceq 'Many') {
        if ([Text.UTF8Encoding]::new($false, $true).GetByteCount($TargetsJson) -gt 65536) { throw [ArgumentException]::new('Admission control exceeds its budget.') }
        $document = [Text.Json.JsonDocument]::Parse($TargetsJson)
        try {
            if ($document.RootElement.ValueKind -ne [Text.Json.JsonValueKind]::Array -or $document.RootElement.GetArrayLength() -lt 1 -or $document.RootElement.GetArrayLength() -gt 64) { throw [ArgumentException]::new('Invalid admission batch.') }
            $results = [Collections.Generic.List[object]]::new()
            foreach ($element in $document.RootElement.EnumerateArray()) {
                if ($element.ValueKind -ne [Text.Json.JsonValueKind]::String) { throw [ArgumentException]::new('Invalid admission target.') }
                $results.Add((Read-Admission -Target $element.GetString()))
            }
            $result = [ordered]@{ paths = @($results.ToArray()) }
        }
        finally { $document.Dispose() }
    }
    else {
        $result = Read-Admission -Target $Path
    }
    [Console]::Out.Write((ConvertTo-Json -InputObject $result -Depth 8 -Compress))
    exit 0
}
catch {
    [Console]::Error.WriteLine("${scriptName}: path-admission-unavailable")
    exit 1
}
