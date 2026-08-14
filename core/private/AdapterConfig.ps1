$script:AdapterValidatorCache = [hashtable]::new([StringComparer]::Ordinal)
$script:AdapterValidatorCacheLock = [object]::new()
$script:AdapterVocabulary = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
foreach ($name in 'game', 'adapterVersion', 'saveDirectory', 'saveGlob', 'maxSourceBytes', 'dumpCommand', 'dumpEntrypointIndex', 'digestCommand', 'digestEntrypointIndex', 'diffExcludePaths', 'ambientExtraPaths') { [void] $script:AdapterVocabulary.Add($name) }
$script:AdapterPlaceholders = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
foreach ($name in 'artifactRoot', 'save', 'dump', 'digest', 'adapterVersion', 'sourceDomainId', 'saveName', 'savedAt', 'sourceLength', 'sourceSha256') { [void] $script:AdapterPlaceholders.Add($name) }

function Fail-AdapterConfiguration { throw [AdapterConfigurationException]::new('Adapter configuration is invalid.') }
function Get-AdapterSha256 {
    param([Parameter(Mandatory)] [byte[]] $Bytes)

    return [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($Bytes)).ToLowerInvariant()
}
function Get-AdapterWalkPolicyId {
    param([Parameter(Mandatory)] [AllowNull()] [AllowEmptyCollection()] [string[]] $DiffExcludePaths, [Parameter(Mandatory)] [AllowNull()] [AllowEmptyCollection()] [string[]] $AmbientExtraPaths)

    $encoding = [Text.UTF8Encoding]::new($false)
    $bytes = [Collections.Generic.List[byte]]::new()
    $writeUInt32BigEndian = {
        param([uint32] $Value)
        $bytes.Add([byte] (($Value -shr 24) -band 0xff)); $bytes.Add([byte] (($Value -shr 16) -band 0xff)); $bytes.Add([byte] (($Value -shr 8) -band 0xff)); $bytes.Add([byte] ($Value -band 0xff))
    }
    $writeLengthPrefixedUtf8 = {
        param([string] $Text)
        $data = $encoding.GetBytes($Text)
        & $writeUInt32BigEndian ([uint32] $data.Length)
        foreach ($byte in $data) { $bytes.Add($byte) }
    }
    # A configured array can present as null when absent; the empty policy set is the
    # hash-neutral form for both members, mirroring the prior join-as-empty behavior.
    $copySortedOrdinal = {
        param([AllowNull()] [string[]] $Pointers)
        $copy = [Collections.Generic.List[string]]::new([string[]] ($Pointers ?? [string[]] @()))
        $copy.Sort([StringComparer]::Ordinal)
        return , $copy
    }

    & $writeLengthPrefixedUtf8 'companion-walk-policy-v1'
    foreach ($pointers in @((& $copySortedOrdinal $DiffExcludePaths), (& $copySortedOrdinal $AmbientExtraPaths))) {
        & $writeUInt32BigEndian ([uint32] $pointers.Count)
        foreach ($pointer in $pointers) { & $writeLengthPrefixedUtf8 $pointer }
    }

    return Get-AdapterSha256 -Bytes $bytes.ToArray()
}
function Test-AdapterPathDescendant {
    param([Parameter(Mandatory)] [string] $Path, [Parameter(Mandatory)] [string] $Root)

    $normalizedPath = [IO.Path]::GetFullPath($Path).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
    $normalizedRoot = [IO.Path]::GetFullPath($Root).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
    return $normalizedPath.StartsWith($normalizedRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::Ordinal)
}
function Get-AdapterJsonProperty {
    param([Parameter(Mandatory)] [Text.Json.JsonElement] $Root, [Parameter(Mandatory)] [string] $Name)

    $value = [Text.Json.JsonElement]::new()
    if (-not $Root.TryGetProperty($Name, [ref] $value)) { Fail-AdapterConfiguration }

    return $value
}
function Get-AdapterNonEmptyString {
    param([Parameter(Mandatory)] [Text.Json.JsonElement] $Value)

    if ($Value.ValueKind -ne [Text.Json.JsonValueKind]::String) { Fail-AdapterConfiguration }
    $text = $Value.GetString()
    if ([string]::IsNullOrEmpty($text)) { Fail-AdapterConfiguration }

    return $text
}
function Get-AdapterInt64 {
    param([Parameter(Mandatory)] [Text.Json.JsonElement] $Value, [bool] $Positive = $false, [bool] $Nonnegative = $false)

    if ($Value.ValueKind -ne [Text.Json.JsonValueKind]::Number) { Fail-AdapterConfiguration }
    $number = 0L
    if (-not $Value.TryGetInt64([ref] $number) -or $Value.GetRawText() -notmatch '^-?(0|[1-9][0-9]*)$' -or ($Positive -and $number -le 0) -or ($Nonnegative -and $number -lt 0)) { Fail-AdapterConfiguration }

    return $number
}
function Get-AdapterPointerArray {
    param([Parameter(Mandatory)] [Text.Json.JsonElement] $Root, [Parameter(Mandatory)] [string] $Name)

    $property = [Text.Json.JsonElement]::new()
    if (-not $Root.TryGetProperty($Name, [ref] $property)) { return [string[]] @() }
    if ($property.ValueKind -ne [Text.Json.JsonValueKind]::Array) { Fail-AdapterConfiguration }
    $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    $values = [Collections.Generic.List[string]]::new()
    foreach ($element in $property.EnumerateArray()) {
        $pointer = Get-AdapterNonEmptyString -Value $element
        if (-not $pointer.StartsWith('/', [StringComparison]::Ordinal)) { Fail-AdapterConfiguration }
        # Every RFC 6901 escape must be exactly ~0 or ~1; anything else is non-canonical.
        if ($pointer -match '~(?![01])') { Fail-AdapterConfiguration }
        $tokens = ConvertFrom-DiffPointer -Pointer $pointer
        if ($tokens.Count -lt 2 -or -not [string]::Equals($tokens[0], 'extra', [StringComparison]::Ordinal)) { Fail-AdapterConfiguration }
        # Reference tokens are object keys beneath /extra; a pure-array-index shape is not valid title grammar.
        for ($index = 1; $index -lt $tokens.Count; $index++) { if ($tokens[$index] -match '^[0-9]+$') { Fail-AdapterConfiguration } }
        if (-not $seen.Add($pointer)) { Fail-AdapterConfiguration }
        $values.Add($pointer)
    }

    return [string[]] $values.ToArray()
}
function Get-AdapterCommand {
    param([Parameter(Mandatory)] [Text.Json.JsonElement] $Root, [Parameter(Mandatory)] [string] $Name)

    $value = Get-AdapterJsonProperty -Root $Root -Name $Name
    if ($value.ValueKind -ne [Text.Json.JsonValueKind]::Array -or $value.GetArrayLength() -eq 0) { Fail-AdapterConfiguration }
    $values = [Collections.Generic.List[string]]::new()
    foreach ($element in $value.EnumerateArray()) {
        if ($element.ValueKind -ne [Text.Json.JsonValueKind]::String) { Fail-AdapterConfiguration }
        $values.Add($element.GetString())
    }
    if ([string]::IsNullOrEmpty($values[0])) { Fail-AdapterConfiguration }

    return [string[]] $values.ToArray()
}
function Test-AdapterCommandPlaceholders {
    param([Parameter(Mandatory)] [string[]] $Command, [Parameter(Mandatory)] [string[]] $Required)

    $present = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($token in $Command) {
        foreach ($match in [regex]::Matches($token, '\{([^{}]*)\}')) {
            if (-not $script:AdapterPlaceholders.Contains($match.Groups[1].Value)) { Fail-AdapterConfiguration }
            [void] $present.Add($match.Groups[1].Value)
        }
        if ($token.IndexOf('{', [StringComparison]::Ordinal) -ge 0 -or $token.IndexOf('}', [StringComparison]::Ordinal) -ge 0) {
            $remainder = [regex]::Replace($token, '\{[^{}]*\}', '')
            if ($remainder.IndexOf('{', [StringComparison]::Ordinal) -ge 0 -or $remainder.IndexOf('}', [StringComparison]::Ordinal) -ge 0) { Fail-AdapterConfiguration }
        }
    }
    foreach ($placeholder in $Required) { if (-not $present.Contains($placeholder)) { Fail-AdapterConfiguration } }
}
function Test-AdapterEntrypoint {
    param([Parameter(Mandatory)] [string[]] $Command, [Parameter(Mandatory)] [long] $Index, [Parameter(Mandatory)] [string] $ArtifactRoot)

    if ($Index -gt [int]::MaxValue -or $Index -ge $Command.Length) { Fail-AdapterConfiguration }
    if (($Index -eq 0) -and ($Command.Length -gt 0)) { $entry = $Command[0] }
    elseif ($Index -eq 3 -and $Command.Length -ge 4 -and [string]::Equals($Command[0], 'pwsh', [StringComparison]::Ordinal) -and [string]::Equals($Command[1], '-NoProfile', [StringComparison]::Ordinal) -and [string]::Equals($Command[2], '-File', [StringComparison]::Ordinal)) { $entry = $Command[3] }
    else { Fail-AdapterConfiguration }
    if ($entry.IndexOf('{artifactRoot}', [StringComparison]::Ordinal) -lt 0) { Fail-AdapterConfiguration }
    $expanded = $entry.Replace('{artifactRoot}', $ArtifactRoot)
    $fullEntry = [IO.Path]::GetFullPath($expanded)
    if (-not (Test-AdapterPathDescendant -Path $fullEntry -Root $ArtifactRoot) -or -not (Test-Path -LiteralPath $fullEntry -PathType Leaf)) { Fail-AdapterConfiguration }
    if ($Index -eq 3 -and -not $fullEntry.EndsWith('.ps1', [StringComparison]::Ordinal)) { Fail-AdapterConfiguration }
}
function Invoke-AdapterValidatorTeardown {
    param([Parameter(Mandatory)] [System.Management.Automation.PSModuleInfo] $Module)

    try {
        $streams = @(& { param($Module) Remove-Module -ModuleInfo $Module -Force -ErrorAction Stop } $Module 2>&1 3>&1 4>&1 5>&1 6>&1)
        if ($streams.Count -ne 0 -or $null -ne (Get-Module | Where-Object { [object]::ReferenceEquals($_, $Module) })) { return $false }
        return $true
    }
    catch { return $false }
}
function Acquire-AdapterValidatorLease {
    param([Parameter(Mandatory)] [string] $ValidatorPath)

    $key = [IO.Path]::GetFullPath($ValidatorPath)
    [Threading.Monitor]::Enter($script:AdapterValidatorCacheLock)
    try {
        if ($script:AdapterValidatorCache.ContainsKey($key)) {
            $entry = $script:AdapterValidatorCache[$key]
            if ($entry.State -ne 'loaded') { throw [AdapterConfigurationException]::new('adapter-release-corrupt') }
            $entry.Count++
            return [AdapterValidatorLease]::new($key, $entry.Command)
        }
        $module = $null
        try {
            $output = @(& { param($Path) Import-Module -Name $Path -Force -PassThru -ErrorAction Stop } $key 2>&1 3>&1 4>&1 5>&1 6>&1)
            if ($output.Count -ne 1 -or $output[0] -isnot [System.Management.Automation.PSModuleInfo]) { throw [InvalidOperationException]::new() }
            $module = $output[0]
            $exports = @($module.ExportedCommands.Keys)
            if ($exports.Count -ne 1 -or -not [string]::Equals($exports[0], 'Assert-AdapterDigestSemantics', [StringComparison]::Ordinal)) { throw [InvalidOperationException]::new() }
            $command = $module.ExportedCommands['Assert-AdapterDigestSemantics']
            $script:AdapterValidatorCache[$key] = [pscustomobject]@{ State = 'loaded'; Count = 1; Module = $module; Command = $command }
            return [AdapterValidatorLease]::new($key, $command)
        }
        catch {
            if ($null -ne $module -and -not (Invoke-AdapterValidatorTeardown -Module $module)) { $script:AdapterValidatorCache[$key] = [pscustomobject]@{ State = 'poisoned' } }
            throw [AdapterConfigurationException]::new('adapter-release-corrupt', $_.Exception)
        }
    }
    finally { [Threading.Monitor]::Exit($script:AdapterValidatorCacheLock) }
}
function Release-AdapterValidatorLease {
    param([Parameter(Mandatory)] [string] $CacheKey)

    [Threading.Monitor]::Enter($script:AdapterValidatorCacheLock)
    try {
        if (-not $script:AdapterValidatorCache.ContainsKey($CacheKey)) { return }
        $entry = $script:AdapterValidatorCache[$CacheKey]
        if ($entry.State -ne 'loaded') { return }
        $entry.Count--
        if ($entry.Count -gt 0) { return }
        $entry.State = 'unloading'
        if (Invoke-AdapterValidatorTeardown -Module $entry.Module) { $script:AdapterValidatorCache.Remove($CacheKey) } else { $entry.State = 'poisoned' }
    }
    finally { [Threading.Monitor]::Exit($script:AdapterValidatorCacheLock) }
}
function Get-AdapterConfig {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [string] $CompanionRoot,
        [Parameter()] [string] $Adapter,
        [Parameter(Mandatory)] [ValidateSet('StateCompatibility', 'Acquisition')] [string] $Profile
    )

    try {
        if (-not [IO.Path]::IsPathFullyQualified($CompanionRoot)) { Fail-AdapterConfiguration }
        $root = [IO.Path]::GetFullPath($CompanionRoot)
        if (-not (Test-Path -LiteralPath $root -PathType Container)) { Fail-AdapterConfiguration }
        $adaptersRoot = Join-Path $root 'adapters'
        if (-not (Test-Path -LiteralPath $adaptersRoot -PathType Container)) { Fail-AdapterConfiguration }
        $directories = @([IO.Directory]::EnumerateDirectories($adaptersRoot))
        if ([string]::IsNullOrEmpty($Adapter)) { if ($directories.Count -ne 1) { Fail-AdapterConfiguration }; $adapterDirectory = $directories[0] }
        else {
            if ($Adapter -eq '.' -or $Adapter -eq '..' -or $Adapter.IndexOfAny([char[]]'\\/') -ge 0 -or [IO.Path]::IsPathFullyQualified($Adapter)) { Fail-AdapterConfiguration }
            $matches = @($directories | Where-Object { [string]::Equals([IO.Path]::GetFileName($_), $Adapter, [StringComparison]::OrdinalIgnoreCase) })
            if ($matches.Count -ne 1) { Fail-AdapterConfiguration }
            $adapterDirectory = $matches[0]
        }
        $adapterDirectory = [IO.Path]::GetFullPath($adapterDirectory)
        if (-not [string]::Equals([IO.Directory]::GetParent($adapterDirectory).FullName, [IO.Path]::GetFullPath($adaptersRoot), [StringComparison]::OrdinalIgnoreCase)) { Fail-AdapterConfiguration }
        $jsonPath = Join-Path $adapterDirectory 'adapter.json'
        $bytes = [IO.File]::ReadAllBytes($jsonPath)
        $document = Read-CompanionJson -Json ($script:CompanionJsonUtf8.GetString($bytes)) -Budget config
        $json = $document.RootElement
        if ($json.ValueKind -ne [Text.Json.JsonValueKind]::Object) { Fail-AdapterConfiguration }
        foreach ($property in $json.EnumerateObject()) { if (-not $script:AdapterVocabulary.Contains($property.Name)) { Fail-AdapterConfiguration } }
        $game = Get-AdapterNonEmptyString (Get-AdapterJsonProperty $json game)
        $version = Get-AdapterInt64 (Get-AdapterJsonProperty $json adapterVersion)
        $saveDirectory = Get-AdapterNonEmptyString (Get-AdapterJsonProperty $json saveDirectory)
        if (-not [IO.Path]::IsPathFullyQualified($saveDirectory)) { Fail-AdapterConfiguration }
        $saveGlob = Get-AdapterNonEmptyString (Get-AdapterJsonProperty $json saveGlob)
        $exclusions = Get-AdapterPointerArray -Root $json -Name diffExcludePaths
        $artifactRoot = Join-Path $adapterDirectory ('releases/' + $version.ToString([Globalization.CultureInfo]::InvariantCulture) + '/schema-' + (Get-CoreSchemaVersion))
        $artifactRoot = [IO.Path]::GetFullPath($artifactRoot)
        $adapterName = [IO.Path]::GetFileName($adapterDirectory)
        $validatorPath = Join-Path $artifactRoot "adapters/$adapterName/Validate-Digest.psm1"
        if (-not (Test-Path -LiteralPath $validatorPath -PathType Leaf)) { Fail-AdapterConfiguration }
        $config = if ($Profile -eq 'Acquisition') { [AdapterConfig]::new() } else { [AdapterCompatibilityConfig]::new() }
        $config.AdapterName = $adapterName; $config.AdapterDirectory = $adapterDirectory; $config.Game = $game; $config.AdapterVersion = $version; $config.SaveDirectory = [IO.Path]::GetFullPath($saveDirectory); $config.SaveGlob = $saveGlob; $config.DiffExcludePaths = $exclusions
        $config.SourceDomainId = Get-AdapterSha256 -Bytes ([Text.UTF8Encoding]::new($false).GetBytes($config.SaveDirectory + [char]0 + $saveGlob))
        $config.ConfigReceipt = Get-AdapterSha256 -Bytes $bytes; $config.ArtifactRoot = $artifactRoot; $config.ValidatorPath = [IO.Path]::GetFullPath($validatorPath)
        # Every non-module rule for the selected profile resolves BEFORE the validator lease
        # is acquired (spec section 8), so an invalid acquisition-only config (save-dir,
        # maxSourceBytes, command/entrypoint grammar, ambientExtraPaths) never imports a
        # validator module that later must be torn down.
        if ($Profile -eq 'Acquisition') {
            if (-not (Test-Path -LiteralPath $config.SaveDirectory -PathType Container)) { Fail-AdapterConfiguration }
            $config.MaxSourceBytes = Get-AdapterInt64 (Get-AdapterJsonProperty $json maxSourceBytes) $true
            if ($config.MaxSourceBytes -eq [long]::MaxValue) { Fail-AdapterConfiguration }
            $config.DumpCommand = Get-AdapterCommand -Root $json -Name dumpCommand; $config.DigestCommand = Get-AdapterCommand -Root $json -Name digestCommand
            $config.DumpEntrypointIndex = Get-AdapterInt64 (Get-AdapterJsonProperty $json dumpEntrypointIndex) $false $true; $config.DigestEntrypointIndex = Get-AdapterInt64 (Get-AdapterJsonProperty $json digestEntrypointIndex) $false $true
            Test-AdapterCommandPlaceholders -Command $config.DumpCommand -Required @('artifactRoot', 'save', 'dump')
            Test-AdapterCommandPlaceholders -Command $config.DigestCommand -Required @('artifactRoot', 'dump', 'digest', 'adapterVersion', 'sourceDomainId', 'saveName', 'savedAt', 'sourceLength', 'sourceSha256')
            Test-AdapterEntrypoint -Command $config.DumpCommand -Index $config.DumpEntrypointIndex -ArtifactRoot $artifactRoot; Test-AdapterEntrypoint -Command $config.DigestCommand -Index $config.DigestEntrypointIndex -ArtifactRoot $artifactRoot
            $config.AmbientExtraPaths = Get-AdapterPointerArray -Root $json -Name ambientExtraPaths
            $config.WalkPolicyId = Get-AdapterWalkPolicyId -DiffExcludePaths $config.DiffExcludePaths -AmbientExtraPaths $config.AmbientExtraPaths
        }
        $lease = Acquire-AdapterValidatorLease -ValidatorPath $validatorPath
        try {
            $config.Lease = $lease; $config.Validator = $lease.Command

            return $config
        }
        catch { $lease.Dispose(); throw }
    }
    catch [AdapterConfigurationException] { throw }
    catch { throw [AdapterConfigurationException]::new('Adapter configuration is invalid.', $_.Exception) }
}
function Assert-AdapterDigestDocument {
    param([Parameter(Mandatory)] [CompanionJsonValue] $Document, [Parameter(Mandatory)] [AdapterCompatibilityConfig] $AdapterConfig)

    if ($AdapterConfig.Disposed) { throw [AdapterValidatorInfrastructureException]::new('Adapter configuration was disposed.', $null) }
    try {
        $root = $Document.RootElement
        if ((Get-Property $root schemaVersion).GetInt64() -ne (Get-CoreSchemaVersion) -or (Get-Property $root adapterVersion).GetInt64() -ne $AdapterConfig.AdapterVersion -or -not [string]::Equals((Get-Property $root game).GetString(), $AdapterConfig.Game, [StringComparison]::Ordinal) -or -not [string]::Equals((Get-Property (Get-Property $root source) domainId).GetString(), $AdapterConfig.SourceDomainId, [StringComparison]::Ordinal)) { throw [AdapterDigestValidationException]::new('Adapter digest rejected.') }
        try {
            $result = @(& $AdapterConfig.Validator $Document 2>&1 3>&1 4>&1 5>&1 6>&1)
        }
        catch [AdapterDigestValidationException] { throw }
        catch [AdapterConfigurationException] { throw [AdapterValidatorInfrastructureException]::new('Adapter validator invocation failed.', $_.Exception) }
        catch [CompanionContentException] { throw }
        catch { throw [AdapterValidatorInfrastructureException]::new('Adapter validator invocation failed.', $_.Exception) }
        if ($result.Count -ne 0) { throw [AdapterConfigurationException]::new('adapter-release-corrupt') }
    }
    catch [AdapterDigestValidationException], [AdapterValidatorInfrastructureException], [AdapterConfigurationException], [CompanionContentException] { throw }
    catch { throw [AdapterValidatorInfrastructureException]::new('Adapter digest validation machinery failed.', $_.Exception) }
}

function Test-ValidatorInfrastructureFailure {
    param([Parameter(Mandatory)] [System.Exception] $Exception)

    # An AdapterConfigurationException raised at a validation boundary is machinery,
    # not document content; both types classify as validator infrastructure.
    return $Exception -is [AdapterValidatorInfrastructureException] -or $Exception -is [AdapterConfigurationException]
}
function Read-AdapterDigestDocument {
    [CmdletBinding(DefaultParameterSetName = 'Path')]
    param([Parameter(Mandatory, Position = 0, ParameterSetName = 'Path')] [string] $Path, [Parameter(Mandatory, ParameterSetName = 'Json')] [string] $Json, [Parameter(Mandatory)] [AdapterCompatibilityConfig] $AdapterConfig)

    $document = if ($PSCmdlet.ParameterSetName -eq 'Path') { Read-DigestDocument -Path $Path } else { Read-DigestDocument -Json $Json }
    Assert-AdapterDigestDocument -Document $document -AdapterConfig $AdapterConfig

    return $document
}
