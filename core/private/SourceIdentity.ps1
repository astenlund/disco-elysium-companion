if ($null -eq ('CompanionWarningSink' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Collections;
using System.Collections.Generic;
using System.Collections.ObjectModel;

public sealed class CompanionWarning
{
    public string code { get; }
    public string detail { get; }
    public CompanionWarning(string code, string detail) { this.code = code; this.detail = detail; }
}

public sealed class CompanionWarningSink
{
    private readonly HashSet<string> allowed;
    private readonly List<CompanionWarning> warnings = new List<CompanionWarning>();
    private ReadOnlyCollection<CompanionWarning> frozen;
    public CompanionWarningSink(string[] allowed) { this.allowed = new HashSet<string>(allowed, StringComparer.Ordinal); }
    public void Add(string code, string detail)
    {
        if (frozen != null || !allowed.Contains(code)) throw new InvalidOperationException();
        // PowerShell coerces a null detail to the empty string at the method call; treat
        // an empty detail as no detail so null-detail warnings round-trip as JSON null.
        if (string.IsNullOrEmpty(detail)) detail = null;
        foreach (var warning in warnings) if (StringComparer.Ordinal.Equals(warning.code, code) && StringComparer.Ordinal.Equals(warning.detail, detail)) return;
        warnings.Add(new CompanionWarning(code, detail));
    }
    public ReadOnlyCollection<CompanionWarning> Freeze()
    {
        if (frozen == null) { warnings.Sort(Order); frozen = new ReadOnlyCollection<CompanionWarning>(warnings); }
        return frozen;
    }
    // A sorted copy of the warnings so far that leaves the sink open for later records.
    public ReadOnlyCollection<CompanionWarning> Peek()
    {
        var copy = new List<CompanionWarning>(warnings);
        copy.Sort(Order);
        return new ReadOnlyCollection<CompanionWarning>(copy);
    }
    private static int Order(CompanionWarning left, CompanionWarning right) { int value = StringComparer.Ordinal.Compare(left.code, right.code); return value != 0 ? value : StringComparer.Ordinal.Compare(left.detail, right.detail); }
}
'@ -ErrorAction Stop
}

$script:CompanionWarningProfiles = @{
    Cycle = @('pipeline-baseline-absent', 'pipeline-baseline-content-invalid', 'pipeline-baseline-unreadable', 'pipeline-cleanup-degraded', 'pipeline-reaper-discovery-limit-exceeded', 'pipeline-guard-discarded', 'pipeline-current-self-healed', 'diff-exclude-path-unused')
    GetDiff = @('pipeline-baseline-absent', 'pipeline-baseline-content-invalid', 'consume-cache-fallback', 'diff-exclude-path-unused')
    TurnAttempt = @('pipeline-cache-degraded', 'pipeline-bookkeeping-degraded', 'pipeline-baseline-unreadable', 'pipeline-guard-discarded', 'pipeline-current-self-healed', 'consume-cache-fallback', 'diff-exclude-path-unused')
    TurnOperational = @('pipeline-cleanup-degraded', 'pipeline-reaper-discovery-limit-exceeded')
    StateEventReceipt = @('consume-cache-fallback', 'outbox-apply-deferred', 'outbox-ledger-rebuilt', 'outbox-quarantine-deferred')
    Walk = @('pipeline-cleanup-degraded', 'pipeline-reaper-discovery-limit-exceeded', 'diff-exclude-path-unused', 'walk-max-saves-clamped', 'walk-max-age-hours-clamped')
}

class CompanionWarningProfileNames : System.Management.Automation.IValidateSetValuesGenerator {
    [string[]] GetValidValues() { return [string[]] $script:CompanionWarningProfiles.Keys }
}

function Compare-SourceIdentity {
    param([Parameter(Mandatory)] $Left, [Parameter(Mandatory)] $Right)

    if (-not [string]::Equals([string] $Left.domainId, [string] $Right.domainId, [StringComparison]::Ordinal)) {
        return [pscustomobject]@{ comparable = $false; order = $null }
    }
    $timeOrder = [datetime]::Compare(([datetime] $Left.savedAt).ToUniversalTime(), ([datetime] $Right.savedAt).ToUniversalTime())
    if ($timeOrder -ne 0) {
        return [pscustomobject]@{ comparable = $true; order = [Math]::Sign($timeOrder) }
    }
    return [pscustomobject]@{ comparable = $true; order = [Math]::Sign([string]::CompareOrdinal([string] $Left.saveFile, [string] $Right.saveFile)) }
}

function New-SourceIdentity {
    param(
        [Parameter(Mandatory)] [string] $DomainId,
        [Parameter(Mandatory)] [string] $SaveFile,
        [Parameter(Mandatory)] $SavedAt
    )

    # The canonical in-memory source identity: {domainId, saveFile, savedAt} with savedAt
    # as a UTC [datetime]. Accepts a UTC 'o' string (JSON boundary) or a [datetime] and
    # normalizes, so construction no longer depends on the source shape at each call site.
    $savedAt = if ($SavedAt -is [datetime]) { ([datetime] $SavedAt).ToUniversalTime() } else { [datetime]::Parse([string] $SavedAt, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind).ToUniversalTime() }

    return [pscustomobject]@{ domainId = $DomainId; saveFile = $SaveFile; savedAt = $savedAt }
}

function ConvertFrom-SourceIdentity {
    param(
        [Parameter(Mandatory, ParameterSetName = 'Element')] [Text.Json.JsonElement] $Element,
        [Parameter(Mandatory, ParameterSetName = 'Value')] $Value
    )

    if ($PSCmdlet.ParameterSetName -ceq 'Element') {
        return New-SourceIdentity -DomainId $Element.GetProperty('domainId').GetString() -SaveFile $Element.GetProperty('saveFile').GetString() -SavedAt $Element.GetProperty('savedAt').GetString()
    }

    return New-SourceIdentity -DomainId ([string] $Value['domainId']) -SaveFile ([string] $Value['saveFile']) -SavedAt ([string] $Value['savedAt'])
}

function New-CompanionWarningSink {
    param([Parameter(Mandatory)] [ValidateSet([CompanionWarningProfileNames])] [string] $Profile)

    $sink = [CompanionWarningSink]::new([string[]] $script:CompanionWarningProfiles[$Profile])
    return $sink
}

function Add-CompanionWarning {
    param([Parameter(Mandatory)] [CompanionWarningSink] $Sink, [Parameter(Mandatory)] [string] $Code, [AllowNull()] [object] $Detail)

    $detailIsValid = switch ($Code) {
        'diff-exclude-path-unused' { $null -ne $Detail -and $Detail.StartsWith('/', [StringComparison]::Ordinal) }
        'pipeline-reaper-discovery-limit-exceeded' { $Detail -in @('tmp', 'state') }
        default { $null -eq $Detail }
    }
    # A reaper 'state' detail on a pipeline-reaper-discovery-limit-exceeded warning is
    # intentionally NOT restricted here: the full reaper (which scans both .tmp and state)
    # legitimately emits that detail, so rejecting it would break its own warnings.
    # Only reaper callers narrow the accepted root; a future walk-specific state restriction
    # belongs in that caller, not here. Do not add a dead enforcement clause as a placeholder.
    if (-not $detailIsValid) {
        throw [CompanionDocumentValidationException]::new('Invalid Companion warning.')
    }

    # The CompanionWarningSink boundary normalizes an empty-string detail back to null so
    # a null-detail warning stores null and round-trips through the turn-context envelope
    # as null instead of the empty string, which the envelope's warning validation rejects.
    try { $Sink.Add($Code, [string] $Detail) } catch { throw [CompanionDocumentValidationException]::new('Invalid Companion warning.') }
}
