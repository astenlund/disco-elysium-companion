#Requires -Version 7.5
[CmdletBinding()]
param([switch] $Core, [switch] $StateEvent, [switch] $Context, [switch] $ContextEvent, [switch] $Runtime, [switch] $RuntimeOwned, [switch] $RuntimeOwnedEmpty)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
Import-Module (Join-Path $repoRoot 'core/tests/TestSupport.psm1') -Force
if ($Core -or $StateEvent -or $Runtime -or $RuntimeOwned -or $RuntimeOwnedEmpty) {
    Import-Module (Join-Path $repoRoot 'core/DigestDiff.psm1') -Force -DisableNameChecking
    $entries = @(Get-ChildItem -LiteralPath (Join-Path $repoRoot 'core') -Filter '*.ps1' -File | ForEach-Object Name)
    $staged = if ($Runtime -or $RuntimeOwned -or $RuntimeOwnedEmpty) { New-StagedRuntimeCoordinatorRoot -Prefix 'runtime-fixture' -EntryScripts $entries -Owned:($RuntimeOwned -or $RuntimeOwnedEmpty) -EmptyOutbox:$RuntimeOwnedEmpty } elseif ($StateEvent) { New-StagedStateEventRoot -Prefix 'runtime-fixture' -EntryScripts $entries } else { New-StagedStubAcquisitionRoot -Prefix 'runtime-fixture' -EntryScripts $entries }
    $root = $staged.Root
}
elseif ($Context -or $ContextEvent) {
    $eventBytes = [byte[]]@()
    if ($ContextEvent) {
        Add-Type -Path @('JsonDocuments.cs', 'EventDocuments.cs', 'PayloadCodec.cs' | ForEach-Object { Join-Path $repoRoot ('runtime/scripts/' + $_) })
        $eventBytes = (New-RuntimeAcceptedPayloadSample).Accepted
    }
    $root = (New-StagedRuntimeContextRoot -Prefix 'runtime-fixture' -EventBytes $eventBytes).Root
}
else {
    $root = New-ScratchCompanionRoot -Prefix 'runtime-fixture'
}
[Console]::Out.WriteLine((ConvertTo-Json -InputObject ([ordered]@{ root = $root }) -Compress))
[Console]::Out.Flush()
$null = [Console]::In.ReadLine()
