[CmdletBinding()]
param(
    [string] $Adapter,
    [string] $CompanionRoot = (Split-Path $PSScriptRoot -Parent),
    [int] $MaxSaves = 8,
    [int] $MaxAgeHours = 72
)

$ErrorActionPreference = 'Stop'
$CompanionRoot = [IO.Path]::GetFullPath($CompanionRoot)
$warnings = $null
$config = $null

function Write-WalkFailure {
    param([Parameter(Mandatory)] [string] $Class)

    [Console]::Error.WriteLine("find-span: [$Class]")
}

function Write-WalkWarnings {
    if ($null -eq $warnings) { return }
    $frozen = $warnings.Freeze()
    if ($frozen.Count -eq 0) { return }
    $items = foreach ($warning in $frozen) { [ordered]@{ code = $warning.code; detail = $warning.detail } }
    [Console]::Error.WriteLine('find-span-warning: ' + (ConvertTo-CompanionJson -InputObject @($items) -Budget diff))
}

try {
    Import-Module (Join-Path $PSScriptRoot 'EntryFence.psm1') -Force
    $entryFenceLease = Enter-CompanionEntryFence -CompanionRoot $CompanionRoot
}
catch {
    [Console]::Error.WriteLine('[maintenance] state extraction maintenance is active')
    exit 1
}

try {
    try { Import-Module (Join-Path $PSScriptRoot 'DigestDiff.psm1') -Force -DisableNameChecking }
    catch { Write-WalkFailure -Class 'compare'; exit 1 }
    $warnings = New-CompanionWarningSink -Profile Walk
    if ($MaxSaves -lt 2) { $MaxSaves = 2; Add-CompanionWarning -Sink $warnings -Code 'walk-max-saves-clamped' -Detail $null }
    if ($MaxAgeHours -lt 1) { $MaxAgeHours = 1; Add-CompanionWarning -Sink $warnings -Code 'walk-max-age-hours-clamped' -Detail $null }
    try {
        $config = Get-AdapterConfig -CompanionRoot $CompanionRoot -Adapter $Adapter -Profile Acquisition
        [void] [IO.Directory]::CreateDirectory((Join-Path $CompanionRoot '.tmp'))
        Invoke-WorkFileReaper -CompanionRoot $CompanionRoot -WarningSink $warnings -TmpOnly
        try { $candidates = @(Get-SaveCandidates -SaveDirectory $config.SaveDirectory -SaveGlob $config.SaveGlob) }
        catch { Write-WalkFailure -Class 'config'; exit 1 }
    }
    catch {
        $class = if ($_.Exception.GetType().Name -eq 'AdapterConfigurationException') { 'config' } else { 'copy' }
        Write-WalkFailure -Class $class
        exit 1
    }

    $frozenCandidates = @($candidates | ForEach-Object { ConvertTo-WalkIdentity -Source (New-SourceIdentity -DomainId $config.SourceDomainId -SaveFile $_.Name -SavedAt $_.LastWriteTimeUtc) })
    $receipts = [System.Collections.Generic.List[object]]::new()
    $result = [ordered]@{ provenance = [ordered]@{ game = $config.Game; adapterVersion = $config.AdapterVersion; sourceDomainId = $config.SourceDomainId; walkPolicyId = $config.WalkPolicyId }; found = $false; walkedSaves = 0; boundHit = $null; span = $null; diff = $null }
    $held = @{}
    try {
        if ($candidates.Count -lt 2) { $result.boundHit = 'exhausted' }
        elseif (Test-WalkOverAge -Newest $candidates[0].LastWriteTimeUtc -Candidate $candidates[1].LastWriteTimeUtc -MaxAgeHours $MaxAgeHours) { $result.boundHit = 'age' }
        else {
            try { if (-not (Test-FileWriteStable -Path $candidates[0].FullName)) { Write-WalkFailure -Class 'unstable'; exit 1 } }
            catch { Write-WalkFailure -Class 'copy'; exit 1 }
            function Get-WalkDigestResult([int] $Index) {
                if (-not $held.ContainsKey($Index)) {
                    $held[$Index] = Invoke-SaveDigest -AdapterDirectory $config.AdapterDirectory -AdapterConfig $config -SourceSave $candidates[$Index] -WorkFileStem ('work-walk-' + $Index.ToString([Globalization.CultureInfo]::InvariantCulture)) -WarningSink $warnings
                    $result.walkedSaves++
                }
                return $held[$Index]
            }
            $index = 1
            while ($true) {
                $baseline = Get-WalkDigestResult $index
                $target = Get-WalkDigestResult ($index - 1)
                $diff = Compare-Digests -Baseline $baseline.Digest -Target $target.Digest -AdapterConfig $config -WarningSink $warnings
                $receipt = New-WalkPairReceipt -BaselineIndex $index -TargetIndex ($index - 1) -BaselineSource ([pscustomobject]@{ digest = $baseline.Digest; sourceIdentity = $baseline.SourceIdentity }) -TargetSource ([pscustomobject]@{ digest = $target.Digest; sourceIdentity = $target.SourceIdentity }) -Diff $diff -AdapterConfig $config
                $receipts.Add($receipt)
                if ($receipt.Eventful) {
                    $result.found = $true
                    $result.span = [ordered]@{ from = ConvertTo-WalkIdentity -Source $baseline.SourceIdentity; to = ConvertTo-WalkIdentity -Source $target.SourceIdentity }
                    $result.diff = $diff.RootElement
                    break
                }
                # The older side becomes the next pair's target. Keep it and release the
                # newest side so traversal owns exactly two full digests between pairs.
                $target.Dispose(); $held.Remove($index - 1)
                $next = $index + 1
                if ($next -ge $candidates.Count) { $result.boundHit = 'exhausted'; break }
                if ($next -ge $MaxSaves) { $result.boundHit = 'saves'; break }
                if (Test-WalkOverAge -Newest $candidates[0].LastWriteTimeUtc -Candidate $candidates[$next].LastWriteTimeUtc -MaxAgeHours $MaxAgeHours) { $result.boundHit = 'age'; break }
                $index = $next
            }
        }
        $json = ConvertTo-CompanionJson -InputObject $result -Budget walk-result
        $document = Read-WalkResultDocument -Json $json -EffectiveMaxSaves $MaxSaves -AdapterConfig $config
        Assert-WalkResultSemantics -Result $document -TraversalEvidence (New-WalkTraversalEvidence -Candidates $frozenCandidates -EffectiveMaxSaves $MaxSaves -EffectiveMaxAgeHours $MaxAgeHours -Receipts $receipts.ToArray()) -AdapterConfig $config
        [Console]::Out.Write($json)
    }
    catch {
        $class = switch ($_.Exception.GetType().Name) {
            'SaveDigestStageException' { $_.Exception.Stage; break }
            'CompanionDocumentValidationException' { 'protocol'; break }
            default { 'compare'; break }
        }
        Write-WalkFailure -Class $class
        exit 1
    }
    finally {
        foreach ($item in @($held.Values)) { $item.Dispose() }
    }
}
finally {
    try { Write-WalkWarnings } catch { }
    if ($null -ne $config) { $config.Dispose() }
    $entryFenceLease.Dispose()
}
