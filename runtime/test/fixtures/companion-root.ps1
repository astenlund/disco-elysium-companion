#Requires -Version 7.5
[CmdletBinding()]
# -StagingFault fails staging after the root exists, for the regression test of that removal.
param([switch] $Core, [switch] $StateEvent, [switch] $Context, [switch] $ContextEvent, [switch] $Runtime, [switch] $RuntimeOwned, [switch] $RuntimeOwnedEmpty, [switch] $StagingFault)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
Import-Module (Join-Path $repoRoot 'core/tests/TestSupport.psm1') -Force
# A staging failure after the root exists removes it before the error ends the host; a root that
# survives is reported on stderr by the removal itself.
try {
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
    if ($StagingFault) {
        throw [InvalidOperationException]::new('Injected fixture staging fault.')
    }
}
catch {
    Remove-OwnedScratchRoots
    throw
}
[Console]::Out.WriteLine((ConvertTo-Json -InputObject ([ordered]@{ root = $root }) -Compress))
[Console]::Out.Flush()
$null = [Console]::In.ReadLine()
# Exit 0 means the root is gone. A root that survives removal exits 3 with its path-free
# residue as the last stderr line, so the caller can tell residue apart from a host failure.
try {
    Remove-ScratchCompanionRoot -Path $root
}
catch [System.IO.IOException] {
    $residue = $_.Exception.Data['ScratchResidue']
    if ($null -eq $residue) {
        throw
    }
    [Console]::Error.WriteLine((ConvertTo-Json -InputObject ([ordered]@{ fixtureResidue = $residue }) -Depth 4 -Compress))
    exit 3
}
