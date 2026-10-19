#Requires -Version 7.5
[CmdletBinding()]
param([Parameter(Mandatory)] [string] $StopFile)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Holds whatever handles other processes duplicate into it until the stop file appears or it is killed.
while (-not [IO.File]::Exists($StopFile)) { [Threading.Thread]::Sleep(25) }
exit 0
