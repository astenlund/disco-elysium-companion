function New-WalkPairReceipt {
    param(
        [Parameter(Mandatory)] [int] $BaselineIndex,
        [Parameter(Mandatory)] [int] $TargetIndex,
        [Parameter(Mandatory)] [object] $BaselineSource,
        [Parameter(Mandatory)] [object] $TargetSource,
        [Parameter(Mandatory)] [CompanionJsonValue] $Diff,
        [Parameter(Mandatory)] [AdapterConfig] $AdapterConfig
    )

    Assert-DiffSemantics -Diff $Diff -Baseline $BaselineSource.digest -Target $TargetSource.digest -AdapterConfig $AdapterConfig
    $eventful = -not (Test-UneventfulDiff -Diff $Diff -AdapterConfig $AdapterConfig)

    return [WalkPairReceipt]::new($BaselineIndex, $TargetIndex, (ConvertTo-WalkIdentity -Source $BaselineSource.sourceIdentity), (ConvertTo-WalkIdentity -Source $TargetSource.sourceIdentity), $eventful)
}

function Test-WalkOverAge {
    param([Parameter(Mandatory)] [datetime] $Newest, [Parameter(Mandatory)] [datetime] $Candidate, [Parameter(Mandatory)] [int] $MaxAgeHours)

    $ticks = $Newest.ToUniversalTime().Ticks - $Candidate.ToUniversalTime().Ticks
    if ($ticks -lt 0) { throw [CompanionDocumentValidationException]::new('Invalid save candidate order.') }
    $remainder = 0L
    $quotient = [Math]::DivRem($ticks, [TimeSpan]::TicksPerHour, [ref] $remainder)

    return $quotient -gt $MaxAgeHours -or ($quotient -eq $MaxAgeHours -and $remainder -ne 0)
}

function ConvertTo-WalkIdentity {
    param([Parameter(Mandatory)] [object] $Source)

    if ($Source -is [Text.Json.JsonElement]) {
        return [ordered]@{ domainId = (Get-Property $Source domainId).GetString(); saveFile = (Get-Property $Source saveFile).GetString(); savedAt = (Get-Property $Source savedAt).GetString() }
    }
    return [ordered]@{ domainId = [string] $Source.domainId; saveFile = [string] $Source.saveFile; savedAt = ([datetime] $Source.savedAt).ToUniversalTime().ToString('o', [Globalization.CultureInfo]::InvariantCulture) }
}

function Test-WalkIdentityEqual {
    param([Parameter(Mandatory)] [object] $Left, [Parameter(Mandatory)] [object] $Right)

    # Callers pass identities as ordered hashtables, pscustomobjects, or re-parsed
    # JsonElements; normalize both sides so property access never depends on the shape.
    $leftIdentity = ConvertTo-WalkIdentity -Source $Left
    $rightIdentity = ConvertTo-WalkIdentity -Source $Right

    return [string]::Equals([string] $leftIdentity.domainId, [string] $rightIdentity.domainId, [StringComparison]::Ordinal) -and [string]::Equals([string] $leftIdentity.saveFile, [string] $rightIdentity.saveFile, [StringComparison]::Ordinal) -and [string]::Equals([string] $leftIdentity.savedAt, [string] $rightIdentity.savedAt, [StringComparison]::Ordinal)
}

function Read-WalkResultDocument {
    param([Parameter(Mandatory)] [string] $Json, [Parameter(Mandatory)] [int] $EffectiveMaxSaves, [Parameter(Mandatory)] [AdapterConfig] $AdapterConfig)

    try {
        if ($EffectiveMaxSaves -lt 2) { Fail-Document }
        $document = Read-CompanionJson -Json $Json -Budget walk-result
        $root = $document.RootElement
        Test-ExactFields $root @('provenance', 'found', 'walkedSaves', 'boundHit', 'span', 'diff')
        $provenance = Get-Property $root provenance
        Test-ExactFields $provenance @('game', 'adapterVersion', 'sourceDomainId', 'walkPolicyId')
        if (-not [string]::Equals((Test-String (Get-Property $provenance game)), $AdapterConfig.Game, [StringComparison]::Ordinal) -or (Test-Integer (Get-Property $provenance adapterVersion)) -ne $AdapterConfig.AdapterVersion -or -not [string]::Equals((Test-String (Get-Property $provenance sourceDomainId)), $AdapterConfig.SourceDomainId, [StringComparison]::Ordinal) -or -not [string]::Equals((Test-String (Get-Property $provenance walkPolicyId)), $AdapterConfig.WalkPolicyId, [StringComparison]::Ordinal)) { Fail-Document }
        Test-Boolean (Get-Property $root found)
        $walked = Test-Integer (Get-Property $root walkedSaves) $true
        if ($walked -ne 0 -and ($walked -lt 2 -or $walked -gt $EffectiveMaxSaves)) { Fail-Document }
        $found = (Get-Property $root found).GetBoolean()
        $boundHit = Get-Property $root boundHit
        $span = Get-Property $root span
        $diff = Get-Property $root diff
        if ($found) {
            Test-ElementKind $boundHit Null
            Test-ExactFields $span @('from', 'to')
            foreach ($name in 'from', 'to') { Test-SourceIdentityFields (Get-Property $span $name) }
            $from = Get-Property $span from; $to = Get-Property $span to
            if (-not [string]::Equals((Get-Property $from domainId).GetString(), $AdapterConfig.SourceDomainId, [StringComparison]::Ordinal) -or -not [string]::Equals((Get-Property $to domainId).GetString(), $AdapterConfig.SourceDomainId, [StringComparison]::Ordinal)) { Fail-Document }
            $comparison = Compare-SourceIdentity -Left (ConvertFrom-SourceIdentity -Element $from) -Right (ConvertFrom-SourceIdentity -Element $to)
            if (-not $comparison.comparable -or $comparison.order -ge 0) { Fail-Document }
            $diffDocument = Read-DiffDocument -Json $diff.GetRawText()
            if ($diffDocument.RootElement.GetProperty('baselineGeneratedAt').ValueKind -eq [Text.Json.JsonValueKind]::Null -or (Test-UneventfulDiff -Diff $diffDocument -AdapterConfig $AdapterConfig)) { Fail-Document }
            $currentSource = $diffDocument.RootElement.GetProperty('currentSource')
            if (-not [string]::Equals((Get-Property $to saveFile).GetString(), (Get-Property $currentSource saveFile).GetString(), [StringComparison]::Ordinal) -or -not [string]::Equals((Get-Property $to savedAt).GetString(), (Get-Property $currentSource savedAt).GetString(), [StringComparison]::Ordinal)) { Fail-Document }
            if ($walked -lt 2) { Fail-Document }
        }
        else {
            Test-ElementKind $span Null; Test-ElementKind $diff Null
            $bound = Test-String $boundHit
            if ($bound -notin @('saves', 'age', 'exhausted') -or ($bound -ceq 'saves' -and $walked -ne $EffectiveMaxSaves) -or ($bound -ceq 'age' -and $walked -ne 0 -and $walked -ge $EffectiveMaxSaves)) { Fail-Document }
        }

        return $document
    }
    catch [CompanionDocumentValidationException] { throw }
    catch { throw [CompanionDocumentValidationException]::new('Walk result validation failed.') }
}

function Assert-WalkResultSemantics {
    param([Parameter(Mandatory)] [CompanionJsonValue] $Result, [Parameter(Mandatory)] [WalkTraversalEvidence] $TraversalEvidence, [Parameter(Mandatory)] [AdapterConfig] $AdapterConfig)

    $validated = Read-WalkResultDocument -Json (ConvertTo-CompanionJson -InputObject $Result.RootElement -Budget walk-result) -EffectiveMaxSaves $TraversalEvidence.EffectiveMaxSaves -AdapterConfig $AdapterConfig
    $root = $validated.RootElement
    $receipts = $TraversalEvidence.Receipts
    for ($index = 0; $index -lt $receipts.Length; $index++) {
        $receipt = $receipts[$index]
        if ($receipt.BaselineIndex -ne ($index + 1) -or $receipt.TargetIndex -ne $index -or $receipt.BaselineIndex -ge $TraversalEvidence.Candidates.Length -or -not (Test-WalkIdentityEqual $receipt.BaselineSource $TraversalEvidence.Candidates[$receipt.BaselineIndex]) -or -not (Test-WalkIdentityEqual $receipt.TargetSource $TraversalEvidence.Candidates[$receipt.TargetIndex])) { throw [CompanionDocumentValidationException]::new('Walk evidence is invalid.') }
        if ($index -lt ($receipts.Length - 1) -and $receipt.Eventful) { throw [CompanionDocumentValidationException]::new('Walk did not stop at the first eventful pair.') }
    }
    if ($root.GetProperty('found').GetBoolean()) {
        if ($receipts.Length -eq 0 -or -not $receipts[-1].Eventful) { throw [CompanionDocumentValidationException]::new('Walk found result lacks eventful evidence.') }
        if ($root.GetProperty('walkedSaves').GetInt64() -ne ($receipts.Length + 1)) { throw [CompanionDocumentValidationException]::new('Walk found count does not match evidence.') }
        $span = $root.GetProperty('span')
        if (-not (Test-WalkIdentityEqual (Get-Property $span from) $receipts[-1].BaselineSource) -or -not (Test-WalkIdentityEqual (Get-Property $span to) $receipts[-1].TargetSource)) { throw [CompanionDocumentValidationException]::new('Walk found span does not match evidence.') }
    }
    else {
        if ($receipts | Where-Object Eventful) { throw [CompanionDocumentValidationException]::new('Dry walk result has eventful evidence.') }
        $walked = $root.GetProperty('walkedSaves').GetInt64()
        $boundHit = $root.GetProperty('boundHit').GetString()
        if (($walked -eq 0 -and $receipts.Length -ne 0) -or ($walked -gt 0 -and $walked -ne ($receipts.Length + 1))) { throw [CompanionDocumentValidationException]::new('Walk dry count does not match evidence.') }
        if ($boundHit -ceq 'exhausted' -and $TraversalEvidence.Candidates.Length -ge 2 -and ($walked -ne $TraversalEvidence.Candidates.Length -or $receipts.Length -ne ($TraversalEvidence.Candidates.Length - 1))) { throw [CompanionDocumentValidationException]::new('Walk exhausted evidence is incomplete.') }
        if ($boundHit -ceq 'saves' -and ($walked -ne $TraversalEvidence.EffectiveMaxSaves -or $TraversalEvidence.Candidates.Length -le $walked)) { throw [CompanionDocumentValidationException]::new('Walk saves bound is invalid.') }
        if ($boundHit -ceq 'age') {
            $ageCandidateIndex = [Math]::Max($walked, 1L)
            if ($TraversalEvidence.Candidates.Length -lt 2 -or $ageCandidateIndex -ge $TraversalEvidence.Candidates.Length -or -not (Test-WalkOverAge -Newest ([datetime] $TraversalEvidence.Candidates[0].savedAt) -Candidate ([datetime] $TraversalEvidence.Candidates[$ageCandidateIndex].savedAt) -MaxAgeHours $TraversalEvidence.EffectiveMaxAgeHours)) { throw [CompanionDocumentValidationException]::new('Walk age bound is invalid.') }
        }
    }
}

function Read-WalkWarningArray {
    param([Parameter(Mandatory)] [string] $Json)

    $document = Read-CompanionJson -Json $Json -Budget diff
    Test-ElementKind $document.RootElement Array
    $sink = New-CompanionWarningSink -Profile Walk
    foreach ($item in $document.RootElement.EnumerateArray()) {
        Test-ExactFields $item @('code', 'detail')
        $code = Test-String (Get-Property $item code)
        $detailElement = Get-Property $item detail
        $detail = if ($detailElement.ValueKind -eq [Text.Json.JsonValueKind]::Null) { $null } else { Test-String $detailElement }
        Add-CompanionWarning -Sink $sink -Code $code -Detail $detail
    }
    $frozen = $sink.Freeze()
    if ($frozen.Count -ne $document.RootElement.GetArrayLength()) { Fail-Document }

    return $frozen
}
