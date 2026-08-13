$script:SaveCandidateEntryLimit = 65536
$script:SaveCandidateNameByteLimit = 16777216
# Canonical work-file naming, owned by the writer (Invoke-SaveDigest / Get-SaveDigestNonce):
# stems are 'work-cycle' or 'work-walk-<nonnegative canonical decimal>', every group member is
# '<stem>-<32-lowercase-hex nonce>...', and the reaper in StateFiles.ps1 matches leases with
# the composed pattern below.
$script:WorkNoncePattern = '[0-9a-f]{32}'
$script:WorkWalkIndexPattern = '(?:0|[1-9][0-9]*)'
$script:WorkLeaseNamePattern = '^work-(?:cycle|walk-' + $script:WorkWalkIndexPattern + ')-' + $script:WorkNoncePattern + '\.lease$'

function Assert-CycleOutcome {
    param([Parameter(Mandatory)] [CycleOutcome] $Outcome)

    $legal =
        ($Outcome.Completed -and $Outcome.CurrentCommitted -and -not $Outcome.GuardDiscarded -and $Outcome.CacheWritten -and $Outcome.BookkeepingWritten -and $null -eq $Outcome.FailurePhase -and $Outcome.SourceDisposition -ceq 'stable' -and -not $Outcome.Retryable -and $null -eq $Outcome.Detail) -or
        ($Outcome.Completed -and -not $Outcome.CurrentCommitted -and $Outcome.GuardDiscarded -and -not $Outcome.CacheWritten -and $Outcome.BookkeepingWritten -and $null -eq $Outcome.FailurePhase -and $Outcome.SourceDisposition -ceq 'stable' -and -not $Outcome.Retryable -and $null -eq $Outcome.Detail) -or
        (-not $Outcome.Completed -and -not $Outcome.CurrentCommitted -and -not $Outcome.GuardDiscarded -and -not $Outcome.CacheWritten -and -not $Outcome.BookkeepingWritten -and $Outcome.FailurePhase -ceq 'initialize' -and $Outcome.SourceDisposition -ceq 'not-checked' -and -not $Outcome.Retryable -and -not [string]::IsNullOrEmpty($Outcome.Detail)) -or
        (-not $Outcome.Completed -and -not $Outcome.CurrentCommitted -and -not $Outcome.GuardDiscarded -and -not $Outcome.CacheWritten -and -not $Outcome.BookkeepingWritten -and $Outcome.FailurePhase -ceq 'source' -and $Outcome.SourceDisposition -in @('vanished', 'changed', 'unreadable') -and ($Outcome.Retryable -eq ($Outcome.SourceDisposition -in @('vanished', 'changed'))) -and -not [string]::IsNullOrEmpty($Outcome.Detail)) -or
        (-not $Outcome.Completed -and -not $Outcome.CurrentCommitted -and -not $Outcome.GuardDiscarded -and -not $Outcome.CacheWritten -and -not $Outcome.BookkeepingWritten -and $Outcome.FailurePhase -in @('dump', 'digest', 'commit') -and $Outcome.SourceDisposition -ceq 'stable' -and -not $Outcome.Retryable -and -not [string]::IsNullOrEmpty($Outcome.Detail)) -or
        (-not $Outcome.Completed -and $Outcome.CurrentCommitted -and -not $Outcome.GuardDiscarded -and -not $Outcome.CacheWritten -and -not $Outcome.BookkeepingWritten -and $Outcome.FailurePhase -ceq 'cache' -and $Outcome.SourceDisposition -ceq 'stable' -and -not $Outcome.Retryable -and -not [string]::IsNullOrEmpty($Outcome.Detail)) -or
        (-not $Outcome.Completed -and $Outcome.CurrentCommitted -and -not $Outcome.GuardDiscarded -and $Outcome.CacheWritten -and -not $Outcome.BookkeepingWritten -and $Outcome.FailurePhase -ceq 'bookkeeping' -and $Outcome.SourceDisposition -ceq 'stable' -and -not $Outcome.Retryable -and -not [string]::IsNullOrEmpty($Outcome.Detail)) -or
        (-not $Outcome.Completed -and -not $Outcome.CurrentCommitted -and $Outcome.GuardDiscarded -and -not $Outcome.CacheWritten -and -not $Outcome.BookkeepingWritten -and $Outcome.FailurePhase -ceq 'bookkeeping' -and $Outcome.SourceDisposition -ceq 'stable' -and -not $Outcome.Retryable -and -not [string]::IsNullOrEmpty($Outcome.Detail))
    if (-not $legal -or $null -eq $Outcome.Warnings) {
        throw [CompanionDocumentValidationException]::new('Illegal cycle outcome.')
    }
}

function New-CycleOutcome {
    param([bool] $Completed, [bool] $CurrentCommitted, [bool] $GuardDiscarded, [bool] $CacheWritten, [bool] $BookkeepingWritten, [AllowNull()] [object] $FailurePhase, [string] $SourceDisposition, [bool] $Retryable, [AllowNull()] [object] $Detail, [Parameter(Mandatory)] [CompanionWarningSink] $WarningSink)

    return [CycleOutcome]::new($Completed, $CurrentCommitted, $GuardDiscarded, $CacheWritten, $BookkeepingWritten, $FailurePhase, $SourceDisposition, $Retryable, $Detail, $WarningSink.Freeze())
}

function Complete-CycleOutcome {
    param(
        [AllowNull()] [SaveDigestResult] $Result,
        [bool] $Completed,
        [bool] $CurrentCommitted,
        [bool] $GuardDiscarded,
        [bool] $CacheWritten,
        [bool] $BookkeepingWritten,
        [AllowNull()] [object] $FailurePhase,
        [string] $SourceDisposition,
        [bool] $Retryable,
        [AllowNull()] [object] $Detail,
        [Parameter(Mandatory)] [CompanionWarningSink] $WarningSink
    )

    if ($null -ne $Result) {
        $Result.Dispose()
    }

    return New-CycleOutcome -Completed $Completed -CurrentCommitted $CurrentCommitted -GuardDiscarded $GuardDiscarded -CacheWritten $CacheWritten -BookkeepingWritten $BookkeepingWritten -FailurePhase $FailurePhase -SourceDisposition $SourceDisposition -Retryable $Retryable -Detail $Detail -WarningSink $WarningSink
}

function Invoke-CycleCheckpoint {
    param([Parameter(Mandatory)] [Threading.CancellationToken] $CancellationToken, [Parameter(Mandatory)] [hashtable] $Operations, [Parameter(Mandatory)] [string] $Name)

    $CancellationToken.ThrowIfCancellationRequested()
    if ($Operations.ContainsKey('Checkpoint')) {
        & $Operations.Checkpoint $Name
    }
}

function Get-SaveCandidates {
    param([Parameter(Mandatory)] [string] $SaveDirectory, [Parameter(Mandatory)] [string] $SaveGlob)

    $entries = 0
    $nameBytes = 0L
    $matches = [Collections.Generic.List[IO.FileInfo]]::new()
    $encoding = [Text.UTF8Encoding]::new($false, $true)
    $globPattern = [Management.Automation.WildcardPattern]::new($SaveGlob, [Management.Automation.WildcardOptions]::None)
    foreach ($entry in [IO.Directory]::EnumerateFileSystemEntries($SaveDirectory, '*', [IO.SearchOption]::TopDirectoryOnly)) {
        $entries++
        $nameBytes += $encoding.GetByteCount([IO.Path]::GetFileName($entry))
        if ($entries -gt $script:SaveCandidateEntryLimit -or $nameBytes -gt $script:SaveCandidateNameByteLimit) { throw [SaveCandidateLimitException]::new('save-candidate-limit-exceeded') }
        if ([IO.File]::Exists($entry) -and $globPattern.IsMatch([IO.Path]::GetFileName($entry))) {
            $matches.Add([IO.FileInfo]::new($entry))
        }
    }
    $ordered = $matches.ToArray()
    [Array]::Sort($ordered, [Comparison[IO.FileInfo]] {
            param([IO.FileInfo] $left, [IO.FileInfo] $right)

            $timeOrder = [datetime]::Compare($right.LastWriteTimeUtc, $left.LastWriteTimeUtc)
            if ($timeOrder -ne 0) {
                return $timeOrder
            }

            return [string]::CompareOrdinal($right.Name, $left.Name)
        })

    return @($ordered)
}

function Get-NewestSave {
    param([Parameter(Mandatory)] [string] $SaveDirectory, [Parameter(Mandatory)] [string] $SaveGlob)

    $candidates = @(Get-SaveCandidates -SaveDirectory $SaveDirectory -SaveGlob $SaveGlob)
    if ($candidates.Count -eq 0) {
        return $null
    }

    return $candidates[0]
}

function Get-FileWriteSample {
    param([Parameter(Mandatory)] [string] $Path)

    # The Exists check is explicit: PowerShell does not reliably surface a
    # property-getter FileNotFoundException from FileInfo.Length, so without the
    # guard a vanished candidate silently sampled as two null lengths and read as
    # stable instead of throwing the typed vanished classification.
    try {
        $info = [IO.FileInfo]::new($Path)
        $info.Refresh()
        if (-not $info.Exists) { throw [IO.FileNotFoundException]::new('save-source-missing', $Path) }

        return [pscustomobject]@{ Length = $info.Length; LastWriteTimeUtc = $info.LastWriteTimeUtc }
    }
    catch [IO.FileNotFoundException] { throw [SaveSourceException]::new('vanished', 'save-source-vanished', $_.Exception) }
    catch { throw [SaveSourceException]::new('unreadable', 'save-source-unreadable', $_.Exception) }
}

function Test-FileWriteStable {
    param([Parameter(Mandatory)] [string] $Path, [Parameter()] [int] $SampleDelayMilliseconds = 2000, [Parameter()] [Threading.CancellationToken] $CancellationToken = [Threading.CancellationToken]::None)

    for ($attempt = 0; $attempt -lt 5; $attempt++) {
        $first = Get-FileWriteSample -Path $Path
        if ($CancellationToken.IsCancellationRequested) { return $false }
        [Threading.Tasks.Task]::Delay($SampleDelayMilliseconds, $CancellationToken).GetAwaiter().GetResult()
        $second = Get-FileWriteSample -Path $Path
        if ($second.Length -eq $first.Length -and $second.LastWriteTimeUtc -eq $first.LastWriteTimeUtc) { return $true }
    }

    return $false
}

function Get-SaveDigestNonce {
    $bytes = [byte[]]::new(16)
    [Security.Cryptography.RandomNumberGenerator]::Fill($bytes)

    return [Convert]::ToHexString($bytes).ToLowerInvariant()
}

function Get-SaveDigestHash {
    param([Parameter(Mandatory)] [string] $Path, [Parameter(Mandatory)] [long] $MaximumBytes)

    $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete)
    try {
        $hash = [Security.Cryptography.IncrementalHash]::CreateHash([Security.Cryptography.HashAlgorithmName]::SHA256)
        $buffer = [byte[]]::new(65536)
        $total = 0L
        while (($read = $stream.Read($buffer, 0, $buffer.Length)) -gt 0) {
            $total += $read
            if ($total -gt $MaximumBytes) { throw [SaveDigestStageException]::new('copy', 'unreadable', 'source-size-limit-exceeded', [pscustomobject]@{}, $null) }
            $hash.AppendData($buffer, 0, $read)
        }

        return [pscustomobject]@{ Length = $total; Sha256 = [Convert]::ToHexString($hash.GetHashAndReset()).ToLowerInvariant() }
    }
    finally { $stream.Dispose() }
}

function Expand-AdapterCommand {
    param([Parameter(Mandatory)] [string[]] $Command, [Parameter(Mandatory)] [hashtable] $Values)

    $expanded = [Collections.Generic.List[string]]::new()
    foreach ($argument in $Command) {
        $value = $argument
        foreach ($name in $Values.Keys) { $value = $value.Replace("{$name}", [string] $Values[$name]) }
        if ($value.Contains('{', [StringComparison]::Ordinal) -or $value.Contains('}', [StringComparison]::Ordinal)) { throw [InvalidOperationException]::new('Unexpanded adapter placeholder.') }
        $expanded.Add($value)
    }

    return $expanded.ToArray()
}

function Get-AdapterCommandFailureReason {
    param([Parameter(Mandatory)] [AdapterCommandResult] $Result, [Parameter(Mandatory)] [string] $OutputPath)

    if (-not $Result.Started) {
        return 'command-start-failed'
    }

    if ($Result.TimedOut) {
        return 'command-timeout'
    }

    if ($Result.Cancelled -or $null -ne $Result.TransportException) {
        return 'command-transport-failed'
    }

    if ($Result.ExitCode -ne 0) {
        return 'command-exit-nonzero'
    }

    if (-not [IO.File]::Exists($OutputPath)) {
        return 'promised-output-missing'
    }

    return $null
}

function Invoke-CompanionCycle {
    param(
        [Parameter(Mandatory)] [string] $CompanionRoot,
        [Parameter(Mandatory)] [string] $AdapterDirectory,
        [Parameter(Mandatory)] [AdapterConfig] $AdapterConfig,
        [Parameter(Mandatory)] [IO.FileInfo] $SourceSave,
        [Parameter(Mandatory)] [CompanionWarningSink] $WarningSink,
        [Parameter()] [Threading.CancellationToken] $CancellationToken = [Threading.CancellationToken]::None,
        [Parameter()] [hashtable] $Operations = @{}
    )

    $result = $null
    $currentCommitted = $false
    $guardDiscarded = $false
    $cacheWritten = $false
    $currentDocument = $null
    $baselineDocument = $null
    try {
        Invoke-CycleCheckpoint -CancellationToken $CancellationToken -Operations $Operations -Name 'before-save-digest'
        try {
            if ($Operations.ContainsKey('SaveDigest')) {
                $result = & $Operations.SaveDigest
            }
            else {
                $result = Invoke-SaveDigest -AdapterDirectory $AdapterDirectory -AdapterConfig $AdapterConfig -SourceSave $SourceSave -WorkFileStem 'work-cycle' -WarningSink $WarningSink -CancellationToken $CancellationToken
            }
        }
        catch [SaveDigestStageException] {
            $stage = $_.Exception.Stage
            $phase = if ($stage -ceq 'copy') { 'source' } else { $stage }
            $disposition = $_.Exception.SourceDisposition
            $retryable = $disposition -in @('vanished', 'changed')
            return Complete-CycleOutcome -Result $result -Completed $false -CurrentCommitted $false -GuardDiscarded $false -CacheWritten $false -BookkeepingWritten $false -FailurePhase $phase -SourceDisposition $disposition -Retryable $retryable -Detail $_.Exception.Reason -WarningSink $WarningSink
        }

        Invoke-CycleCheckpoint -CancellationToken $CancellationToken -Operations $Operations -Name 'before-commit-guard'
        if ($Operations.ContainsKey('ReadCurrent')) {
            $current = & $Operations.ReadCurrent
        }
        else {
            $current = Read-CompanionCurrent -CompanionRoot $CompanionRoot -AdapterConfig $AdapterConfig
        }
        $currentDocument = $current.document
        if ($current.outcome -ceq 'infrastructure-failure') {
            return Complete-CycleOutcome -Result $result -Completed $false -CurrentCommitted $false -GuardDiscarded $false -CacheWritten $false -BookkeepingWritten $false -FailurePhase 'commit' -SourceDisposition 'stable' -Retryable $false -Detail 'current-read-failed' -WarningSink $WarningSink
        }
        if ($current.outcome -in @('content-invalid', 'stale')) {
            Add-CompanionWarning -Sink $WarningSink -Code 'pipeline-current-self-healed' -Detail $null
        }
        if ($current.outcome -ceq 'valid') {
            $source = $currentDocument.RootElement.GetProperty('source')
            $identity = ConvertFrom-SourceIdentity -Element $source
            $order = Compare-SourceIdentity -Left $identity -Right $result.SourceIdentity
            if ($order.comparable -and $order.order -gt 0) {
                $guardDiscarded = $true
                Add-CompanionWarning -Sink $WarningSink -Code 'pipeline-guard-discarded' -Detail $null
            }
        }

        Invoke-CycleCheckpoint -CancellationToken $CancellationToken -Operations $Operations -Name 'before-current-commit'
        if (-not $guardDiscarded) {
            try {
                if ($Operations.ContainsKey('WriteCurrent')) {
                    & $Operations.WriteCurrent
                }
                else {
                    Write-CompanionCurrent -CompanionRoot $CompanionRoot -Document $result.Digest
                }
                $currentCommitted = $true
            }
            catch {
                return Complete-CycleOutcome -Result $result -Completed $false -CurrentCommitted $false -GuardDiscarded $false -CacheWritten $false -BookkeepingWritten $false -FailurePhase 'commit' -SourceDisposition 'stable' -Retryable $false -Detail 'current-write-failed' -WarningSink $WarningSink
            }
        }

        Invoke-CycleCheckpoint -CancellationToken $CancellationToken -Operations $Operations -Name 'before-cache'
        if (-not $guardDiscarded) {
            try {
                if ($Operations.ContainsKey('ReadBaseline')) {
                    $baseline = & $Operations.ReadBaseline
                }
                else {
                    $baseline = Read-CompanionBaseline -CompanionRoot $CompanionRoot
                }
                $baselineDocument = $baseline.document
                if ($baseline.outcome -ceq 'absent') { Add-CompanionWarning -Sink $WarningSink -Code 'pipeline-baseline-absent' -Detail $null }
                elseif ($baseline.outcome -ceq 'content-invalid') { Add-CompanionWarning -Sink $WarningSink -Code 'pipeline-baseline-content-invalid' -Detail $null }
                elseif ($baseline.outcome -ceq 'infrastructure-failure') { Add-CompanionWarning -Sink $WarningSink -Code 'pipeline-baseline-unreadable' -Detail $null; $baselineDocument = $null }
                if ($Operations.ContainsKey('CompareDiff')) {
                    $diff = & $Operations.CompareDiff
                }
                else {
                    $diff = Compare-Digests -Baseline $baselineDocument -Target $result.Digest -AdapterConfig $AdapterConfig -WarningSink $WarningSink
                }
                if ($Operations.ContainsKey('WriteCache')) {
                    & $Operations.WriteCache
                }
                else {
                    Write-CompanionDiffCache -CompanionRoot $CompanionRoot -Document $diff
                }
                $cacheWritten = $true
            }
            catch {
                return Complete-CycleOutcome -Result $result -Completed $false -CurrentCommitted $true -GuardDiscarded $false -CacheWritten $false -BookkeepingWritten $false -FailurePhase 'cache' -SourceDisposition 'stable' -Retryable $false -Detail 'cycle-cache' -WarningSink $WarningSink
            }
        }

        Invoke-CycleCheckpoint -CancellationToken $CancellationToken -Operations $Operations -Name 'before-bookkeeping'
        try {
            if ($Operations.ContainsKey('WriteBookkeeping')) {
                & $Operations.WriteBookkeeping
            }
            else {
                Write-CompanionBookkeeping -CompanionRoot $CompanionRoot -Document (ConvertTo-WalkIdentity -Source $result.SourceIdentity)
            }
        }
        catch {
            return Complete-CycleOutcome -Result $result -Completed $false -CurrentCommitted $currentCommitted -GuardDiscarded $guardDiscarded -CacheWritten $cacheWritten -BookkeepingWritten $false -FailurePhase 'bookkeeping' -SourceDisposition 'stable' -Retryable $false -Detail 'cycle-bookkeeping' -WarningSink $WarningSink
        }

        return Complete-CycleOutcome -Result $result -Completed $true -CurrentCommitted $currentCommitted -GuardDiscarded $guardDiscarded -CacheWritten $cacheWritten -BookkeepingWritten $true -FailurePhase $null -SourceDisposition 'stable' -Retryable $false -Detail $null -WarningSink $WarningSink
    }
    catch [OperationCanceledException] {
        if ($null -ne $result) {
            $result.Dispose()
            $result = $null
        }
        throw [WatcherCancellationException]::new($WarningSink.Freeze())
    }
    catch {
        return Complete-CycleOutcome -Result $result -Completed $false -CurrentCommitted $currentCommitted -GuardDiscarded $guardDiscarded -CacheWritten $cacheWritten -BookkeepingWritten $false -FailurePhase 'initialize' -SourceDisposition 'not-checked' -Retryable $false -Detail 'cycle-initialize-failed' -WarningSink $WarningSink
    }
    finally {
        if ($null -ne $result) {
            $result.Dispose()
        }
        if ($null -ne $baselineDocument) {
            $baselineDocument.Dispose()
        }
        if ($null -ne $currentDocument) {
            $currentDocument.Dispose()
        }
    }
}

function Invoke-SaveDigest {
    param([Parameter(Mandatory)] [string] $AdapterDirectory, [Parameter(Mandatory)] [AdapterConfig] $AdapterConfig, [Parameter(Mandatory)] [IO.FileInfo] $SourceSave, [Parameter(Mandatory)] [string] $WorkFileStem, [Parameter(Mandatory)] [CompanionWarningSink] $WarningSink, [Parameter()] [Threading.CancellationToken] $CancellationToken = [Threading.CancellationToken]::None)

    if (-not ($WorkFileStem -ceq 'work-cycle' -or $WorkFileStem -cmatch ('^work-walk-' + $script:WorkWalkIndexPattern + '$'))) { throw [ArgumentException]::new('Invalid work file stem.') }
    if ($WorkFileStem -cne 'work-cycle') {
        $walkIndex = 0
        if (-not [int]::TryParse($WorkFileStem.Substring('work-walk-'.Length), [Globalization.NumberStyles]::None, [Globalization.CultureInfo]::InvariantCulture, [ref] $walkIndex)) { throw [ArgumentException]::new('Invalid work file stem.') }
    }
    $tmp = Join-Path (Split-Path $AdapterDirectory -Parent | Split-Path -Parent) '.tmp'
    [void] [IO.Directory]::CreateDirectory($tmp)
    $nonce = Get-SaveDigestNonce
    $base = Join-Path $tmp "$WorkFileStem-$nonce"
    $leasePath = "$base.lease"; $savePath = "$base-save.zip"; $dumpPath = "$base-dump.json"; $digestPath = "$base-digest.json"
    $lease = $null
    $transferred = $false
    try {
        $lease = [IO.File]::Open($leasePath, [IO.FileMode]::CreateNew, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
        $sourceA = [IO.FileInfo]::new($SourceSave.FullName); $sourceA.Refresh()
        if ($sourceA.Length -gt $AdapterConfig.MaxSourceBytes) { throw [SaveDigestStageException]::new('copy', 'unreadable', 'source-size-limit-exceeded', [pscustomobject]@{}, $null) }
        $firstHash = Get-SaveDigestHash -Path $sourceA.FullName -MaximumBytes $AdapterConfig.MaxSourceBytes
        $input = [IO.File]::Open($sourceA.FullName, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete)
        $output = [IO.File]::Open($savePath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        try { $input.CopyTo($output, 65536) } finally { $output.Dispose(); $input.Dispose() }
        [IO.File]::SetLastWriteTimeUtc($savePath, [datetime]::UtcNow)
        $copyHash = Get-SaveDigestHash -Path $savePath -MaximumBytes $AdapterConfig.MaxSourceBytes
        $lastHash = Get-SaveDigestHash -Path $sourceA.FullName -MaximumBytes $AdapterConfig.MaxSourceBytes
        $sourceB = [IO.FileInfo]::new($sourceA.FullName); $sourceB.Refresh()
        if ($sourceA.Length -ne $sourceB.Length -or $sourceA.LastWriteTimeUtc -ne $sourceB.LastWriteTimeUtc -or -not [string]::Equals($firstHash.Sha256, $copyHash.Sha256, [StringComparison]::Ordinal) -or -not [string]::Equals($firstHash.Sha256, $lastHash.Sha256, [StringComparison]::Ordinal)) { throw [SaveDigestStageException]::new('copy', 'changed', 'source-changed', [pscustomobject]@{}, $null) }
        $savedAt = $sourceA.LastWriteTimeUtc.ToString('o', [Globalization.CultureInfo]::InvariantCulture)
        $values = @{ artifactRoot = $AdapterConfig.ArtifactRoot; save = $savePath; dump = $dumpPath; digest = $digestPath; adapterVersion = $AdapterConfig.AdapterVersion; sourceDomainId = $AdapterConfig.SourceDomainId; saveName = $sourceA.Name; savedAt = $savedAt; sourceLength = $firstHash.Length; sourceSha256 = $firstHash.Sha256 }
        $dumpResult = Invoke-AdapterCommand -Command (Expand-AdapterCommand -Command $AdapterConfig.DumpCommand -Values $values) -WorkingDirectory $AdapterDirectory -CancellationToken $CancellationToken
        $dumpReason = Get-AdapterCommandFailureReason -Result $dumpResult -OutputPath $dumpPath
        if ($null -ne $dumpReason) { throw [SaveDigestStageException]::new('dump', 'stable', $dumpReason, [pscustomobject]@{}, $dumpResult.TransportException) }
        $digestResult = Invoke-AdapterCommand -Command (Expand-AdapterCommand -Command $AdapterConfig.DigestCommand -Values $values) -WorkingDirectory $AdapterDirectory -CancellationToken $CancellationToken
        $digestReason = Get-AdapterCommandFailureReason -Result $digestResult -OutputPath $digestPath
        if ($null -ne $digestReason) { throw [SaveDigestStageException]::new('digest', 'stable', $digestReason, [pscustomobject]@{}, $digestResult.TransportException) }
        try {
            $digest = Read-AdapterDigestDocument -Path $digestPath -AdapterConfig $AdapterConfig
            $source = $digest.RootElement.GetProperty('source')
            if (-not [string]::Equals($source.GetProperty('saveFile').GetString(), $sourceA.Name, [StringComparison]::Ordinal) -or -not [string]::Equals($source.GetProperty('savedAt').GetString(), $savedAt, [StringComparison]::Ordinal) -or $source.GetProperty('byteLength').GetInt64() -ne $firstHash.Length -or -not [string]::Equals($source.GetProperty('contentSha256').GetString(), $firstHash.Sha256, [StringComparison]::Ordinal)) { throw [AdapterDigestValidationException]::new('Digest provenance rejected.') }
        }
        catch [SaveDigestStageException] { throw }
        catch { throw [SaveDigestStageException]::new('digest', 'stable', 'document-invalid', [pscustomobject]@{}, $_.Exception) }
        $result = [SaveDigestResult]::new()
        $result.DigestPath = $digestPath; $result.Digest = $digest
        $result.SourceIdentity = New-SourceIdentity -DomainId $AdapterConfig.SourceDomainId -SaveFile $sourceA.Name -SavedAt $sourceA.LastWriteTimeUtc
        $result.SourceReceipt = [pscustomobject]@{ saveFile = $sourceA.Name; savedAt = $savedAt; byteLength = $firstHash.Length; contentSha256 = $firstHash.Sha256 }
        $result.OwnedPaths = @($savePath, $dumpPath, $digestPath, $leasePath); $result.Lease = $lease; $result.WarningSink = $WarningSink
        $lease = $null; $transferred = $true

        return $result
    }
    catch [SaveDigestStageException] { throw }
    catch [IO.FileNotFoundException] { throw [SaveDigestStageException]::new('copy', 'vanished', 'source-vanished', [pscustomobject]@{}, $_.Exception) }
    catch {
        # Any unclassified copy-stage failure is an unreadable source; the size-limit and
        # changed reasons arrive already typed and are rethrown above, never string-matched.
        throw [SaveDigestStageException]::new('copy', 'unreadable', 'source-unreadable', [pscustomobject]@{}, $_.Exception)
    }
    finally {
        if ($null -ne $lease) { $lease.Dispose() }
        if (-not $transferred) { foreach ($path in @($savePath, $dumpPath, $digestPath, $leasePath)) { try { [IO.File]::Delete($path) } catch { Add-CompanionWarning -Sink $WarningSink -Code 'pipeline-cleanup-degraded' -Detail $null } } }
    }
}
