$script:WatcherCycleTraceHook = $null

function Write-WatcherCycleTrace {
    param([Parameter(Mandatory)] [string] $Step)

    if ($null -ne $script:WatcherCycleTraceHook) {
        & $script:WatcherCycleTraceHook $Step
    }
}

class WatcherSample {
    [string] $domainId
    [string] $name
    [datetime] $savedAt
    [long] $size
    WatcherSample([string] $DomainId, [string] $Name, [datetime] $SavedAt, [long] $Size) {
        if ([string]::IsNullOrEmpty($DomainId) -or [string]::IsNullOrEmpty($Name) -or $Name.IndexOfAny([IO.Path]::GetInvalidFileNameChars()) -ge 0 -or $Name.Contains([IO.Path]::DirectorySeparatorChar) -or $Name.Contains([IO.Path]::AltDirectorySeparatorChar) -or $SavedAt.Kind -ne [DateTimeKind]::Utc -or $Size -lt 0) { throw [ArgumentException]::new('Invalid watcher sample.') }
        $this.domainId = $DomainId; $this.name = $Name; $this.savedAt = $SavedAt; $this.size = $Size
    }
}

class WatcherPollResult {
    [AllowNull()] [WatcherSample] $sample
    [string] $disposition
    [object] $warnings
    [AllowNull()] [CycleOutcome] $cycleOutcome
    WatcherPollResult([WatcherSample] $Sample, [string] $Disposition, [object] $Warnings, [CycleOutcome] $CycleOutcome) {
        $legal = @('sampled','quiescent','no-saves','config-failed','enumeration-failed','candidate-limit-exceeded','observation-incomplete','bookkeeping-read-failed','current-read-failed','lock-failed','busy','cycled','cancelled')
        if ($Disposition -notin $legal -or $null -eq $Warnings) { throw [ArgumentException]::new('Invalid watcher poll result.') }
        if (($Disposition -in @('sampled','quiescent')) -ne ($null -ne $Sample)) { throw [ArgumentException]::new('Invalid watcher sample disposition.') }
        if (($Disposition -eq 'cycled') -ne ($null -ne $CycleOutcome)) { throw [ArgumentException]::new('Invalid watcher cycle disposition.') }
        $this.sample = $Sample; $this.disposition = $Disposition; $this.warnings = $Warnings; $this.cycleOutcome = $CycleOutcome
    }
}

class WatcherBookkeepingReadResult {
    [string] $status
    [AllowNull()] [CompanionJsonValue] $value
    WatcherBookkeepingReadResult([string] $Status, [CompanionJsonValue] $Value) {
        if ($Status -notin @('valid','absent','content-invalid') -or (($Status -eq 'valid') -ne ($null -ne $Value))) { throw [ArgumentException]::new('Invalid watcher bookkeeping result.') }
        $this.status=$Status; $this.value=$Value
    }
}

class WatcherCurrentReadResult {
    [string] $status
    [AllowNull()] [CompanionJsonValue] $digest
    WatcherCurrentReadResult([string] $Status, [CompanionJsonValue] $Digest) {
        if ($Status -notin @('valid','absent','core-invalid','stale') -or (($Status -eq 'valid') -ne ($null -ne $Digest))) { throw [ArgumentException]::new('Invalid watcher current result.') }
        $this.status=$Status; $this.digest=$Digest
    }
}

class WatcherStabilityResult {
    [string] $status
    [AllowNull()] [IO.FileInfo] $candidate
    WatcherStabilityResult([string] $Status, [IO.FileInfo] $Candidate) {
        if ($Status -notin @('stable','unstable','vanished','unreadable','cancelled') -or (($Status -eq 'stable') -ne ($null -ne $Candidate))) { throw [ArgumentException]::new('Invalid watcher stability result.') }
        $this.status=$Status; $this.candidate=$Candidate
    }
}

class WatcherCycleLockTryResult {
    [string] $status
    [AllowNull()] [IDisposable] $owner
    WatcherCycleLockTryResult([string] $Status, [IDisposable] $Owner) {
        if ($Status -notin @('acquired','busy','cancelled') -or (($Status -eq 'acquired') -ne ($null -ne $Owner))) { throw [ArgumentException]::new('Invalid watcher cycle lock result.') }
        $this.status=$Status; $this.owner=$Owner
    }
}

class WatcherValidatorWarmHold : System.IDisposable {
    hidden [AllowNull()] [IDisposable] $Lease
    hidden [AllowNull()] [string] $Path

    [void] Adopt([string] $ValidatorPath) {
        if ($null -ne $this.Lease -and [string]::Equals($this.Path, $ValidatorPath, [StringComparison]::Ordinal)) { return }
        $acquired = $null
        # The hold is an import-cost optimization, never a gate: a failed acquisition
        # (including a poisoned entry) leaves the hold unchanged and the poll unaffected.
        try { $acquired = Acquire-AdapterValidatorLease -ValidatorPath $ValidatorPath } catch { return }
        if ($null -ne $this.Lease) { $this.Lease.Dispose() }
        $this.Lease = $acquired
        $this.Path = $ValidatorPath
    }

    [void] Dispose() {
        if ($null -ne $this.Lease) {
            $this.Lease.Dispose()
            $this.Lease = $null
            $this.Path = $null
        }
    }
}

class WatcherRuntimeServices {
    [scriptblock] $ResolveConfig; [scriptblock] $GetCandidates; [scriptblock] $ReadBookkeeping; [scriptblock] $ReadCurrent; [scriptblock] $TestStable; [scriptblock] $TryAcquireCycleLock; [scriptblock] $InvokeCycle
    [AllowNull()] [IDisposable] $WarmHold
    WatcherRuntimeServices([scriptblock] $ResolveConfig, [scriptblock] $GetCandidates, [scriptblock] $ReadBookkeeping, [scriptblock] $ReadCurrent, [scriptblock] $TestStable, [scriptblock] $TryAcquireCycleLock, [scriptblock] $InvokeCycle) {
        if ($null -eq $ResolveConfig -or $null -eq $GetCandidates -or $null -eq $ReadBookkeeping -or $null -eq $ReadCurrent -or $null -eq $TestStable -or $null -eq $TryAcquireCycleLock -or $null -eq $InvokeCycle) { throw [ArgumentNullException]::new('Watcher service.') }
        $this.ResolveConfig=$ResolveConfig; $this.GetCandidates=$GetCandidates; $this.ReadBookkeeping=$ReadBookkeeping; $this.ReadCurrent=$ReadCurrent; $this.TestStable=$TestStable; $this.TryAcquireCycleLock=$TryAcquireCycleLock; $this.InvokeCycle=$InvokeCycle
    }
}

function New-WatcherRuntimeServices {
    param([Parameter(Mandatory)] [string] $AdapterName, [Parameter(Mandatory)] [string] $CompanionRoot)

    # The adapter/root are baked into each closure as single-quoted literals so the bundle
    # is self-contained and reentrant (two bundles never share scope), while function and
    # type resolution stays dynamic so the module-level test stubs still take effect.
    $adapterLiteral = "'" + $AdapterName.Replace("'", "''") + "'"
    $rootLiteral = "'" + $CompanionRoot.Replace("'", "''") + "'"

    $resolveConfig = [ScriptBlock]::Create(('param($Token) Get-AdapterConfig -Adapter @ADAPTER@ -CompanionRoot @ROOT@ -Profile Acquisition').Replace('@ADAPTER@', $adapterLiteral).Replace('@ROOT@', $rootLiteral))
    $getCandidates = { param($Config, $Token) Get-SaveCandidates -SaveDirectory $Config.SaveDirectory -SaveGlob $Config.SaveGlob }
    $readBookkeeping = [ScriptBlock]::Create(('param($Config, $Token) $path = Get-CompanionStatePath -CompanionRoot @ROOT@ -Name $script:StateFileNames.Bookkeeping; if (-not [IO.File]::Exists($path)) { return [WatcherBookkeepingReadResult]::new("absent", $null) }; try { $value = Read-CompanionJson -Path $path -Budget config; [WatcherBookkeepingReadResult]::new("valid", $value) } catch [CompanionContentException] { [WatcherBookkeepingReadResult]::new("content-invalid", $null) }').Replace('@ROOT@', $rootLiteral))
    $readCurrent = [ScriptBlock]::Create(('param($Config, $Token) $current = Read-CompanionCurrent -CompanionRoot @ROOT@ -AdapterConfig $Config; if ($current.outcome -eq "valid") { [WatcherCurrentReadResult]::new("valid", $current.document) } elseif ($current.outcome -eq "absent") { [WatcherCurrentReadResult]::new("absent", $null) } elseif ($current.outcome -eq "stale") { [WatcherCurrentReadResult]::new("stale", $null) } elseif ($current.outcome -eq "validator-infrastructure") { throw [AdapterValidatorInfrastructureException]::new("Adapter validator infrastructure failed during the watcher current read.", $null) } else { [WatcherCurrentReadResult]::new("core-invalid", $null) }').Replace('@ROOT@', $rootLiteral))
    $testStable = { param($Config, $File, $Token) try { if (Test-FileWriteStable -Path $File.FullName -CancellationToken $Token) { [WatcherStabilityResult]::new('stable', $File) } else { [WatcherStabilityResult]::new('unstable', $null) } } catch [SaveSourceException] { [WatcherStabilityResult]::new($_.Exception.SourceDisposition, $null) } }
    $tryAcquireCycleLock = { param($Root, $Token) try { [WatcherCycleLockTryResult]::new('acquired', (Enter-CompanionCycleLock -CompanionRoot $Root -TimeoutMilliseconds 0 -CancellationToken $Token)) } catch [TimeoutException] { [WatcherCycleLockTryResult]::new('busy', $null) } }
    $invokeCycle = [ScriptBlock]::Create((@'
param($Owner, $Config, $File, $Sink, $Token)

$confirmation = $null
try {
    if ($Token.IsCancellationRequested) {
        throw [WatcherCancellationException]::new($Sink.Freeze())
    }

    $confirmation = Get-AdapterConfig -Adapter @ADAPTER@ -CompanionRoot @ROOT@ -Profile Acquisition
    if (-not [string]::Equals($Config.ConfigReceipt, $confirmation.ConfigReceipt, [StringComparison]::Ordinal)) {
        throw [AdapterConfigurationException]::new('adapter-config-changed')
    }
    Write-WatcherCycleTrace -Step 'config-confirmed'

    $revalidated = @(Get-SaveCandidates -SaveDirectory $confirmation.SaveDirectory -SaveGlob $confirmation.SaveGlob)
    if ($revalidated.Count -eq 0) {
        throw [SaveSourceException]::new('vanished', 'save-source-vanished', [IO.FileNotFoundException]::new())
    }

    $candidate = $revalidated[0]
    $candidate.Refresh()
    if (-not [string]::Equals($candidate.Name, $File.Name, [StringComparison]::Ordinal) -or $candidate.LastWriteTimeUtc -ne $File.LastWriteTimeUtc -or $candidate.Length -ne $File.Length) {
        throw [SaveSourceException]::new('changed', 'save-source-changed', [IO.IOException]::new())
    }
    Write-WatcherCycleTrace -Step 'candidate-revalidated'

    if (-not (Test-FileWriteStable -Path $candidate.FullName -CancellationToken $Token)) {
        throw [SaveSourceException]::new('changed', 'save-source-changed', [IO.IOException]::new())
    }
    Write-WatcherCycleTrace -Step 'stability-revalidated'

    if ($Token.IsCancellationRequested) {
        throw [WatcherCancellationException]::new($Sink.Freeze())
    }

    Initialize-CompanionStateDirectories -CompanionRoot @ROOT@
    Write-WatcherCycleTrace -Step 'roots-recreated'
    Invoke-WorkFileReaper -CompanionRoot @ROOT@ -WarningSink $Sink
    Write-WatcherCycleTrace -Step 'full-reaper-complete'

    Write-WatcherCycleTrace -Step 'cycle-work-allocated'
    return Invoke-CompanionCycle -CompanionRoot @ROOT@ -AdapterDirectory $confirmation.AdapterDirectory -AdapterConfig $confirmation -SourceSave $candidate -WarningSink $Sink -CancellationToken $Token
}
finally {
    if ($null -ne $confirmation) {
        $confirmation.Dispose()
    }

    $Owner.Dispose()
    Write-WatcherCycleTrace -Step 'resources-disposed'
}
'@).Replace('@ADAPTER@', $adapterLiteral).Replace('@ROOT@', $rootLiteral))

    $services = [WatcherRuntimeServices]::new($resolveConfig, $getCandidates, $readBookkeeping, $readCurrent, $testStable, $tryAcquireCycleLock, $invokeCycle)
    $services.WarmHold = [WatcherValidatorWarmHold]::new()

    return $services
}

function Test-WatcherSampleEqual { param([AllowNull()][WatcherSample]$Left,[WatcherSample]$Right) return $null -ne $Left -and [string]::Equals($Left.domainId,$Right.domainId,[StringComparison]::Ordinal) -and [string]::Equals($Left.name,$Right.name,[StringComparison]::Ordinal) -and $Left.savedAt -eq $Right.savedAt -and $Left.size -eq $Right.size }

function Test-WatcherBookkeepingMatchesSample {
    param([WatcherBookkeepingReadResult] $Bookkeeping, [WatcherSample] $Sample)

    if ($Bookkeeping.status -cne 'valid') { return $false }
    try {
        $value = $Bookkeeping.value.Materialized
        return [string]::Equals([string] $value['domainId'], $Sample.domainId, [StringComparison]::Ordinal) -and [string]::Equals([string] $value['saveFile'], $Sample.name, [StringComparison]::Ordinal) -and [datetime]::Parse([string] $value['savedAt'], [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind).ToUniversalTime() -eq $Sample.savedAt
    }
    catch { return $false }
}

function Test-WatcherCurrentCoversSample {
    param([WatcherCurrentReadResult] $Current, [WatcherSample] $Sample)

    if ($Current.status -cne 'valid') { return $false }
    try {
        $source = $Current.digest.Materialized['source']
        $currentIdentity = ConvertFrom-SourceIdentity -Value $source
        $sampleIdentity = New-SourceIdentity -DomainId $Sample.domainId -SaveFile $Sample.name -SavedAt $Sample.savedAt
        $comparison = Compare-SourceIdentity -Left $currentIdentity -Right $sampleIdentity
        return $comparison.comparable -and $comparison.order -ge 0
    }
    catch { return $false }
}

function Invoke-WatcherPoll {
    param([AllowNull()][WatcherSample]$PriorSample,[Parameter(Mandatory)][WatcherRuntimeServices]$Services,[Parameter(Mandatory)][string]$CompanionRoot,[Parameter(Mandatory)][Threading.CancellationToken]$CancellationToken)
    if ($CancellationToken.IsCancellationRequested) { return [WatcherPollResult]::new($null,'cancelled',@(),$null) }
    $config=$null
    try {
        try { $config=& $Services.ResolveConfig $CancellationToken } catch { if ($CancellationToken.IsCancellationRequested) { return [WatcherPollResult]::new($null,'cancelled',@(),$null) }; return [WatcherPollResult]::new($null,'config-failed',@(),$null) }
        if ($null -ne $Services.WarmHold -and $config -is [AdapterCompatibilityConfig]) { $Services.WarmHold.Adopt($config.ValidatorPath) }
        if ($CancellationToken.IsCancellationRequested) { return [WatcherPollResult]::new($null,'cancelled',@(),$null) }
        try { $candidates=@(& $Services.GetCandidates $config $CancellationToken) } catch [SaveCandidateLimitException] { return [WatcherPollResult]::new($null,'candidate-limit-exceeded',@(),$null) } catch { if ($CancellationToken.IsCancellationRequested) { return [WatcherPollResult]::new($null,'cancelled',@(),$null) }; return [WatcherPollResult]::new($null,'enumeration-failed',@(),$null) }
        if ($CancellationToken.IsCancellationRequested) { return [WatcherPollResult]::new($null,'cancelled',@(),$null) }
        if ($candidates.Count -eq 0) { return [WatcherPollResult]::new($null,'no-saves',@(),$null) }
        try { $file=$candidates[0]; $file.Refresh(); $sample=[WatcherSample]::new($config.SourceDomainId,$file.Name,$file.LastWriteTimeUtc,$file.Length) } catch { return [WatcherPollResult]::new($null,'observation-incomplete',@(),$null) }
        if ($CancellationToken.IsCancellationRequested) { return [WatcherPollResult]::new($null,'cancelled',@(),$null) }
        if (-not (Test-WatcherSampleEqual $PriorSample $sample)) { return [WatcherPollResult]::new($sample,'sampled',@(),$null) }
        try { $book=& $Services.ReadBookkeeping $config $CancellationToken } catch { if ($CancellationToken.IsCancellationRequested) { return [WatcherPollResult]::new($null,'cancelled',@(),$null) }; return [WatcherPollResult]::new($null,'bookkeeping-read-failed',@(),$null) }
        if ($CancellationToken.IsCancellationRequested) { return [WatcherPollResult]::new($null,'cancelled',@(),$null) }
        try { $current=& $Services.ReadCurrent $config $CancellationToken } catch { if ($CancellationToken.IsCancellationRequested) { return [WatcherPollResult]::new($null,'cancelled',@(),$null) }; return [WatcherPollResult]::new($null,'current-read-failed',@(),$null) }
        if ($CancellationToken.IsCancellationRequested) { return [WatcherPollResult]::new($null,'cancelled',@(),$null) }
        $trigger = -not (Test-WatcherBookkeepingMatchesSample -Bookkeeping $book -Sample $sample) -or -not (Test-WatcherCurrentCoversSample -Current $current -Sample $sample)
        if (-not $trigger) { return [WatcherPollResult]::new($sample,'quiescent',@(),$null) }
        $stable=& $Services.TestStable $config $file $CancellationToken
        if ($stable.status -eq 'cancelled' -or $CancellationToken.IsCancellationRequested) { return [WatcherPollResult]::new($null,'cancelled',@(),$null) }
        if ($stable.status -ne 'stable') { return [WatcherPollResult]::new($null,'observation-incomplete',@(),$null) }
        try {
            $lock=& $Services.TryAcquireCycleLock $CompanionRoot $CancellationToken
        }
        catch {
            if ($CancellationToken.IsCancellationRequested) {
                return [WatcherPollResult]::new($null,'cancelled',@(),$null)
            }

            return [WatcherPollResult]::new($null,'lock-failed',@(),$null)
        }

        if ($lock.status -eq 'busy') { return [WatcherPollResult]::new($null,'busy',@(),$null) }
        if ($lock.status -eq 'cancelled') { return [WatcherPollResult]::new($null,'cancelled',@(),$null) }
        if ($CancellationToken.IsCancellationRequested) { $lock.owner.Dispose(); return [WatcherPollResult]::new($null,'cancelled',@(),$null) }
        $sink=New-CompanionWarningSink -Profile Cycle
        try {
            $outcome=& $Services.InvokeCycle $lock.owner $config $stable.candidate $sink $CancellationToken
        }
        catch [AdapterConfigurationException] {
            return [WatcherPollResult]::new($null,'config-failed',@(),$null)
        }

        if ($CancellationToken.IsCancellationRequested) { return [WatcherPollResult]::new($null,'cancelled',$outcome.Warnings,$null) }
        return [WatcherPollResult]::new($null,'cycled',$outcome.Warnings,$outcome)
    } catch [WatcherCancellationException] { return [WatcherPollResult]::new($null,'cancelled',$_.Exception.Warnings,$null) } catch [OperationCanceledException] { return [WatcherPollResult]::new($null,'cancelled',@(),$null) }
    finally { if ($null -ne $config -and $config -is [IDisposable]) { $config.Dispose() } }
}

function Wait-WatcherInterval { param([int]$IntervalSeconds,[Parameter(Mandatory)][Threading.CancellationToken]$CancellationToken) $remaining=[long][Math]::Max(2,$IntervalSeconds); while($remaining -gt 0){$chunk=[int][Math]::Min(86400,$remaining); if($CancellationToken.WaitHandle.WaitOne([TimeSpan]::FromSeconds($chunk))){throw [WatcherCancellationException]::new(@())};$remaining-=$chunk} }

function Invoke-CompanionWatcher {
    param([Parameter(Mandatory)][ValidateNotNullOrEmpty()][string]$AdapterName,[Parameter(Mandatory)][ValidateNotNullOrEmpty()][string]$CompanionRoot,[int]$IntervalSeconds=30,[Parameter(Mandatory)][Threading.CancellationToken]$CancellationToken,[WatcherRuntimeServices]$Services)
    if($null -eq $Services){$Services=New-WatcherRuntimeServices -AdapterName $AdapterName -CompanionRoot $CompanionRoot}; $prior=$null
    try {
        while(-not $CancellationToken.IsCancellationRequested){ try { $result=Invoke-WatcherPoll -PriorSample $prior -Services $Services -CompanionRoot $CompanionRoot -CancellationToken $CancellationToken; $prior=$result.sample; if($result.disposition -eq 'cancelled'){return}; Wait-WatcherInterval -IntervalSeconds $IntervalSeconds -CancellationToken $CancellationToken } catch [WatcherCancellationException] { return } catch { $prior=$null; if($CancellationToken.IsCancellationRequested){return}; try { Wait-WatcherInterval -IntervalSeconds $IntervalSeconds -CancellationToken $CancellationToken } catch [WatcherCancellationException] { return } } }
    }
    finally { if ($null -ne $Services.WarmHold) { $Services.WarmHold.Dispose() } }
}
