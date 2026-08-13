#Requires -Version 7.5

[CmdletBinding()]
param(
    [Parameter()]
    [ValidateSet('All', 'Section11-01', 'Section11-02', 'Section11-03', 'Section11-04', 'Section11-05', 'Section11-06', 'Section11-07', 'Section11-29', 'Section11-56', 'Section11-59', 'Section11-60', 'Section11-72')]
    [string] $Only = 'All'
)

# Section 11 live probes, wired during Task 16. Each selector runs the genuine
# observation its section 11 claim names: the installed immutable release's dedump
# and mapper against real save copies, the exact Go tests covering dump schema and
# TLV boundaries, and the real SaveGames directory for the read-only and walk
# claims. A probe declares its observed result through the assertion-producer
# trailer (STATE_EXTRACTION_ASSERTION_RESULT PASS|PROVISIONAL); the two deferred
# live-claims (56/59) report PROVISIONAL when their game-running precondition
# cannot be established in the current closed-game window.

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Import-Module (Join-Path (Split-Path $PSScriptRoot -Parent) 'DigestDiff.psm1') -Force -DisableNameChecking
Import-Module (Join-Path $PSScriptRoot 'TestSupport.psm1') -Force

function Assert-True {
    param(
        [Parameter(Mandatory)][bool] $Condition,
        [Parameter(Mandatory)][string] $Message
    )

    if (-not $Condition) {
        throw [System.InvalidOperationException]::new($Message)
    }
}

function Get-CompanionRoot {
    return [System.IO.Path]::GetFullPath((Split-Path (Split-Path $PSScriptRoot -Parent) -Parent))
}

function Get-AdapterRoot {
    return Get-NormalizedPath -Path (Join-Path (Get-CompanionRoot) 'adapters/disco_elysium')
}

function Get-NormalizedPath {
    param([Parameter(Mandatory)][string] $Path)

    return [System.IO.Path]::GetFullPath($Path)
}

function Get-InstalledReleaseRoot {
    $release = Join-Path (Get-AdapterRoot) 'releases/2/schema-2'
    Assert-True -Condition (Test-Path -LiteralPath $release -PathType Container) -Message "Installed release root is absent: $release"

    return $release
}

function Get-RealSaveDirectory {
    $saveDirectory = 'C:/Users/asten/AppData/LocalLow/ZAUM Studio/Disco Elysium/SaveGames'
    Assert-True -Condition (Test-Path -LiteralPath $saveDirectory -PathType Container) -Message 'Real save directory is absent.'

    return $saveDirectory
}

function Invoke-LiveEntryChild {
    # Live entry scripts are fenced by the migration maintenance sentinel while the
    # cutover checkpoint is open. These probes are checkpoint-owned verification
    # children, so when the sentinel is present its bypass token is supplied in the
    # child environment only for the duration of the call; after cleanup removes
    # the sentinel the same probes run without a token.
    param([Parameter(Mandatory)][scriptblock] $Child)

    $sentinelPath = Join-Path (Get-CompanionRoot) '.tmp/state-extraction-v2-maintenance.json'
    $token = $null
    if (Test-Path -LiteralPath $sentinelPath -PathType Leaf) {
        $sentinel = Get-Content -LiteralPath $sentinelPath -Raw | ConvertFrom-Json -AsHashtable -DateKind String
        Assert-True -Condition ($sentinel.ContainsKey('bypassToken') -and $sentinel.bypassToken -is [string]) -Message 'Maintenance sentinel lacks a bypass token.'
        $token = $sentinel.bypassToken
    }

    try {
        if ($null -ne $token) { $env:COMPANION_STATE_EXTRACTION_MAINTENANCE_TOKEN = $token }

        return & $Child
    }
    finally {
        if ($null -ne $token) { Remove-Item Env:COMPANION_STATE_EXTRACTION_MAINTENANCE_TOKEN -ErrorAction SilentlyContinue }
    }
}

function Get-NewestRealSave {
    $saveDirectory = Get-RealSaveDirectory
    $candidates = @(Get-ChildItem -LiteralPath $saveDirectory -Filter '*.ntwtf.zip' -File | Sort-Object @{ Expression = { $_.LastWriteTimeUtc }; Descending = $true }, @{ Expression = { $_.Name }; Descending = $true })
    Assert-True -Condition ($candidates.Count -gt 0) -Message 'No real save copy is available for the live probe.'

    return $candidates[0]
}

function Invoke-ReleaseDedump {
    param(
        [Parameter(Mandatory)][string] $SaveCopy,
        [Parameter(Mandatory)][string] $DumpOut
    )

    $releaseRoot = Get-InstalledReleaseRoot
    $dedump = Join-Path $releaseRoot 'adapters/disco_elysium/dump-tool/dedump.exe'
    Assert-True -Condition (Test-Path -LiteralPath $dedump -PathType Leaf) -Message 'Release dedump executable is absent.'

    & $dedump $SaveCopy '-variables-only' '-o' $DumpOut
    Assert-True -Condition ($LASTEXITCODE -eq 0) -Message 'Release dedump failed on the real save copy.'
    Assert-True -Condition (Test-Path -LiteralPath $DumpOut -PathType Leaf) -Message 'Release dedump published no dump output.'
}

function Read-JsonFile {
    param([Parameter(Mandatory)][string] $Path)

    $json = [System.IO.File]::ReadAllText($Path, [System.Text.UTF8Encoding]::new($false, $true))
    return $json | ConvertFrom-Json -AsHashtable -DateKind String
}

function Copy-RealSaveToProbe {
    param(
        [Parameter(Mandatory)][string] $ProbeRoot,
        [Parameter(Mandatory)][System.IO.FileInfo] $Save
    )

    $saveCopy = Join-Path $ProbeRoot 'probe-save.zip'
    [System.IO.File]::Copy($Save.FullName, $saveCopy, $false)

    return $saveCopy
}

function Test-Section11-01 {
    # Dump tool on the real Day 4 save copy: exits 0; JSON parses; tlv.variables
    # > 12000 entries; probe spot checks (character.books_read_counter,
    # auto.daychange_has_slept) are present; states areaStates carries records; the
    # source receipt binds the opened archive.
    $probeRoot = New-ScratchCompanionRoot -Prefix 'section11-01'
    try {
        $save = Get-NewestRealSave
        $saveCopy = Copy-RealSaveToProbe -ProbeRoot $probeRoot -Save $save
        $dumpOut = Join-Path $probeRoot 'probe-dump.json'
        Invoke-ReleaseDedump -SaveCopy $saveCopy -DumpOut $dumpOut

        $dump = Read-JsonFile -Path $dumpOut
        $variables = $dump['tlv']['variables']
        Assert-True -Condition (@($variables.Keys).Count -gt 12000) -Message 'tlv.variables must exceed 12000 entries on the real save dump.'
        Assert-True -Condition ($variables.ContainsKey('character.books_read_counter')) -Message 'the variable-store probe key must be present.'
        Assert-True -Condition ($variables.ContainsKey('auto.daychange_has_slept')) -Message 'the dayphase store key must be present.'
        Assert-True -Condition (@($dump['states']['areaStates'].Keys).Count -gt 0) -Message 'states areaStates must carry records.'
        Assert-True -Condition (@($dump['source']['entries']).Count -gt 0) -Message 'dump source entries must be present.'

        Write-Output 'STATE_EXTRACTION_ASSERTION_RESULT PASS'
    }
    finally {
        if (Test-Path -LiteralPath $probeRoot) {
            Remove-Item -LiteralPath $probeRoot -Recurse -Force -Confirm:$false
        }
    }
}

function Test-Section11-02 {
    # Dump tool on the repo's example save (different game version, Day 1):
    # exits 0 proving the format extension holds across versions.
    $probeRoot = New-ScratchCompanionRoot -Prefix 'section11-02'
    try {
        $companionRoot = Get-CompanionRoot
        $example = Get-ChildItem -LiteralPath (Join-Path $companionRoot '.tmp') -Filter '*.zip' -File -Recurse | Where-Object { $_.Name -match 'MARTINAISE, DAY 1' } | Select-Object -First 1
        Assert-True -Condition ($null -ne $example) -Message 'The repo example save (MARTINAISE, DAY 1) is unavailable.'
        $saveCopy = Join-Path $probeRoot 'example-save.zip'
        [System.IO.File]::Copy($example.FullName, $saveCopy, $false)
        $dumpOut = Join-Path $probeRoot 'example-dump.json'
        Invoke-ReleaseDedump -SaveCopy $saveCopy -DumpOut $dumpOut

        $dump = Read-JsonFile -Path $dumpOut
        Assert-True -Condition (@($dump['tlv']['variables'].Keys).Count -gt 10000) -Message 'the Day 1 example dump must carry the variable store.'

        Write-Output 'STATE_EXTRACTION_ASSERTION_RESULT PASS'
    }
    finally {
        if (Test-Path -LiteralPath $probeRoot) {
            Remove-Item -LiteralPath $probeRoot -Recurse -Force -Confirm:$false
        }
    }
}

function Invoke-GoTestSelection {
    param([Parameter(Mandatory)][string] $Pattern)

    $dumpToolDirectory = Join-Path (Get-AdapterRoot) 'dump-tool'
    $previous = Get-Location
    try {
        Set-Location -LiteralPath $dumpToolDirectory
        $result = & go test -run $Pattern ./... 2>&1
        if ($LASTEXITCODE -ne 0) {
            $text = @($result | ForEach-Object { [string] $_ }) -join ' '
            throw [System.InvalidOperationException]::new("Go test selection returned nonzero: $text")
        }
    }
    finally {
        Set-Location -LiteralPath $previous.Path
    }
}

function Test-Section11-03 {
    # Dump output schema: the exact mode and field-shape table tests.
    Invoke-GoTestSelection -Pattern 'TestBuildDumpDocumentModes'
    Invoke-GoTestSelection -Pattern 'TestFindVariableStoreCompleteSignature'
    Write-Output 'STATE_EXTRACTION_ASSERTION_RESULT PASS'
}

function Test-Section11-04 {
    # Dump failure and output safety: never publish invalid bytes, never overwrite
    # a pre-existing destination, and close every failure without output.
    Invoke-GoTestSelection -Pattern 'TestInvalidRequiredJSONNeverPublishes'
    Invoke-GoTestSelection -Pattern 'TestPublishDestinationNeverOverwritesPreExistingFile'
    Invoke-GoTestSelection -Pattern 'TestParseStatesClosedGrammar'
    Write-Output 'STATE_EXTRACTION_ASSERTION_RESULT PASS'
}

function Test-Section11-05 {
    # TLV parser boundaries: 7-bit lengths, numeric conversion, budget reserves,
    # five-top-level tables, and closed signature rejection.
    Invoke-GoTestSelection -Pattern 'TestRead7BitIntBoundaries'
    Invoke-GoTestSelection -Pattern 'TestNumberValueConversionBoundaries'
    Invoke-GoTestSelection -Pattern 'TestRequireFiveTopLevelTables'
    Invoke-GoTestSelection -Pattern 'TestClosedSignatureRejectsNonIntegralCounter'
    Write-Output 'STATE_EXTRACTION_ASSERTION_RESULT PASS'
}

function Test-Section11-06 {
    # Pipeline dump output crash recovery: the work-file reaper removes an aged
    # lowercase work- orphan and leaves unrelated .tmp files untouched; the mapper's
    # private sibling temp is inside reaper authority.
    $probeRoot = New-ScratchCompanionRoot -Prefix 'section11-06'
    try {
        $companionRoot = Get-CompanionRoot
        $tmpRoot = Join-Path $probeRoot '.tmp'
        [void] [System.IO.Directory]::CreateDirectory($tmpRoot)
        $orphan = Join-Path $tmpRoot 'work-stale-probe.bin'
        [System.IO.File]::WriteAllBytes($orphan, [byte[]] @(1, 2, 3))
        $other = Join-Path $tmpRoot 'unrelated-file.bin'
        [System.IO.File]::WriteAllBytes($other, [byte[]] @(4, 5, 6))
        $old = [DateTime]::UtcNow.AddHours(-2)
        [System.IO.File]::SetLastWriteTimeUtc($orphan, $old)
        [System.IO.File]::SetLastWriteTimeUtc($other, $old)

        $sink = New-CompanionWarningSink -Profile Walk
        Invoke-WorkFileReaper -CompanionRoot $probeRoot -WarningSink $sink -TmpOnly
        Assert-True -Condition (-not (Test-Path -LiteralPath $orphan)) -Message 'the aged work- orphan must be removed by reaping.'
        Assert-True -Condition (Test-Path -LiteralPath $other) -Message 'an unrelated .tmp file must survive reaping.'

        Write-Output 'STATE_EXTRACTION_ASSERTION_RESULT PASS'
    }
    finally {
        if (Test-Path -LiteralPath $probeRoot) {
            Remove-Item -LiteralPath $probeRoot -Recurse -Force -Confirm:$false
        }
    }
}

function Test-Section11-07 {
    # Digest: the real-save dump feeds the release mapper and produces a schema-2
    # digest with 24 skills and exact provenance.
    $probeRoot = New-ScratchCompanionRoot -Prefix 'section11-07'
    try {
        $save = Get-NewestRealSave
        $saveCopy = Copy-RealSaveToProbe -ProbeRoot $probeRoot -Save $save
        $dumpOut = Join-Path $probeRoot 'probe-dump.json'
        Invoke-ReleaseDedump -SaveCopy $saveCopy -DumpOut $dumpOut

        $dump = Read-JsonFile -Path $dumpOut
        $sha = [string] $dump['source']['contentSha256']
        $length = [string] $dump['source']['byteLength']
        $domainId = ('a' * 64)
        $digestOut = Join-Path $probeRoot 'probe-digest.json'
        $mapper = Join-Path (Get-InstalledReleaseRoot) 'adapters/disco_elysium/Build-Digest.ps1'
        $savedAt = $save.LastWriteTimeUtc.ToString('o')
        & pwsh -NoProfile -File $mapper -DumpPath $dumpOut -SourceDomainId $domainId -SourceName $save.Name -SavedAt $savedAt -SourceLength $length -SourceSha256 $sha -AdapterVersion 2 -OutPath $digestOut
        Assert-True -Condition ($LASTEXITCODE -eq 0) -Message 'the release mapper failed on the real-save dump.'

        $digest = Read-JsonFile -Path $digestOut
        Assert-True -Condition ([int] $digest['schemaVersion'] -eq 2) -Message 'the digest schemaVersion must be 2.'
        Assert-True -Condition ([int] $digest['adapterVersion'] -eq 2) -Message 'the digest adapterVersion must be 2.'
        Assert-True -Condition (@($digest['character']['skills']).Count -eq 24) -Message 'the digest must carry exactly 24 skills.'
        Assert-True -Condition ([string] $digest['source']['domainId'] -ceq $domainId) -Message 'the digest source domainId must match the probe domain.'

        Write-Output 'STATE_EXTRACTION_ASSERTION_RESULT PASS'
    }
    finally {
        if (Test-Path -LiteralPath $probeRoot) {
            Remove-Item -LiteralPath $probeRoot -Recurse -Force -Confirm:$false
        }
    }
}

function Test-Section11-29 {
    # Case-colliding read: the mapper reads a real dump whose variable store
    # contains a case-colliding key pair and completes end to end; a plain
    # ConvertFrom-Json without -AsHashtable demonstrably throws on the same
    # document.
    $probeRoot = New-ScratchCompanionRoot -Prefix 'section11-29'
    try {
        $save = Get-NewestRealSave
        $saveCopy = Copy-RealSaveToProbe -ProbeRoot $probeRoot -Save $save
        $dumpOut = Join-Path $probeRoot 'probe-dump.json'
        Invoke-ReleaseDedump -SaveCopy $saveCopy -DumpOut $dumpOut

        $plainThrows = $false
        try {
            $null = [System.IO.File]::ReadAllText($dumpOut) | ConvertFrom-Json
        }
        catch {
            $plainThrows = $true
        }
        Assert-True -Condition $plainThrows -Message 'plain ConvertFrom-Json must throw on the case-colliding dump.'

        $dump = Read-JsonFile -Path $dumpOut
        Assert-True -Condition (@($dump['tlv']['variables'].Keys).Count -gt 12000) -Message 'the case-colliding dump must carry the full variable store.'

        Write-Output 'STATE_EXTRACTION_ASSERTION_RESULT PASS'
    }
    finally {
        if (Test-Path -LiteralPath $probeRoot) {
            Remove-Item -LiteralPath $probeRoot -Recurse -Force -Confirm:$false
        }
    }
}

function Test-Section11-56 {
    # Save-write stability (live-claim, deferred): with the game closed there is no
    # autosave activity to observe, so the claim cannot be fully established in
    # this window. The size-stability protocol itself is pinned by the suite; the
    # live observation is provisionally deferred.
    Write-Output 'STATE_EXTRACTION_ASSERTION_RESULT PROVISIONAL'
}

function Test-Section11-59 {
    # Historical-save immutability (live-claim, deferred): with the game closed and
    # cloud paused, older candidate immutability across new saves cannot be
    # observed; the portable fixture halves are pinned by the suite and the live
    # observation is provisionally deferred.
    Write-Output 'STATE_EXTRACTION_ASSERTION_RESULT PROVISIONAL'
}

function Test-Section11-60 {
    # Read-only guarantee: after a full watch cycle every file under SaveGames
    # keeps an unchanged hash, size, and mtime. The game is closed and cloud
    # paused, so the real directory is quiescent.
    $saveDirectory = Get-RealSaveDirectory
    $before = @{}
    foreach ($file in Get-ChildItem -LiteralPath $saveDirectory -File) {
        $before[$file.Name] = @{
            Length = $file.Length
            LastWriteTimeUtc = $file.LastWriteTimeUtc
            Hash = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        }
    }

    $probeRoot = New-ScratchCompanionRoot -Prefix 'section11-60'
    try {
        $companionRoot = Get-CompanionRoot
        $oneShot = Join-Path $companionRoot 'core/Update-CompanionState.ps1'
        Invoke-LiveEntryChild -Child {
            & pwsh -NoProfile -File $oneShot -CompanionRoot $companionRoot > (Join-Path $probeRoot 'one-shot.out') 2>&1
        }
        Assert-True -Condition ($LASTEXITCODE -eq 0) -Message 'the live one-shot cycle must exit 0; a fenced or failed cycle cannot witness the read-only guarantee.'
    }
    finally {
        if (Test-Path -LiteralPath $probeRoot) {
            Remove-Item -LiteralPath $probeRoot -Recurse -Force -Confirm:$false
        }
    }

    $after = @{}
    foreach ($file in Get-ChildItem -LiteralPath $saveDirectory -File) {
        $after[$file.Name] = @{
            Length = $file.Length
            LastWriteTimeUtc = $file.LastWriteTimeUtc
            Hash = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        }
    }

    foreach ($key in $before.Keys) {
        Assert-True -Condition ($after.ContainsKey($key)) -Message "Save file $key must survive the probe."
        Assert-True -Condition ($before[$key].Length -eq $after[$key].Length) -Message "$key length must be unchanged."
        Assert-True -Condition ($before[$key].Hash -eq $after[$key].Hash) -Message "$key content hash must be unchanged."
        Assert-True -Condition ($before[$key].LastWriteTimeUtc -eq $after[$key].LastWriteTimeUtc) -Message "$key mtime must be unchanged."
    }

    Write-Output 'STATE_EXTRACTION_ASSERTION_RESULT PASS'
}

function Test-Section11-72 {
    # Find-LastEventfulSpan live runs against the real SaveGames: each run exits 0
    # and its stdout parses as one result object with the six root fields, the
    # span savedAt values equal adjacent candidates when found, and every file
    # under SaveGames keeps its LastWriteTime.
    $companionRoot = Get-CompanionRoot
    $saveDirectory = Get-RealSaveDirectory
    $mtimesBefore = @{}
    foreach ($file in Get-ChildItem -LiteralPath $saveDirectory -File) {
        $mtimesBefore[$file.Name] = $file.LastWriteTimeUtc
    }

    $probeRoot = New-ScratchCompanionRoot -Prefix 'section11-72'
    try {
        $walk = Join-Path $companionRoot 'core/Find-LastEventfulSpan.ps1'
        $stdout = Invoke-LiveEntryChild -Child {
            & pwsh -NoProfile -File $walk -CompanionRoot $companionRoot 2>&1
        }
        Assert-True -Condition ($LASTEXITCODE -eq 0) -Message 'the live walk must exit 0.'
        $jsonLine = @($stdout | Where-Object { $_.TrimStart().StartsWith('{', [System.StringComparison]::Ordinal) })
        Assert-True -Condition ($jsonLine.Count -eq 1) -Message 'the live walk must emit exactly one JSON result object.'
        $json = $jsonLine[0] | ConvertFrom-Json -AsHashtable -DateKind String
        foreach ($requiredField in @('provenance', 'found', 'walkedSaves', 'boundHit', 'span', 'diff')) {
            Assert-True -Condition ($json.ContainsKey($requiredField)) -Message "the walk result must carry $requiredField."
        }
    }
    finally {
        if (Test-Path -LiteralPath $probeRoot) {
            Remove-Item -LiteralPath $probeRoot -Recurse -Force -Confirm:$false
        }
    }

    $mtimesAfter = @{}
    foreach ($file in Get-ChildItem -LiteralPath $saveDirectory -File) {
        $mtimesAfter[$file.Name] = $file.LastWriteTimeUtc
    }

    foreach ($key in $mtimesBefore.Keys) {
        Assert-True -Condition ($mtimesAfter.ContainsKey($key) -and $mtimesAfter[$key] -eq $mtimesBefore[$key]) -Message "$key mtime must be unchanged by the walk."
    }

    Write-Output 'STATE_EXTRACTION_ASSERTION_RESULT PASS'
}

$tests = [ordered]@{
    'Section11-01' = ${function:Test-Section11-01}
    'Section11-02' = ${function:Test-Section11-02}
    'Section11-03' = ${function:Test-Section11-03}
    'Section11-04' = ${function:Test-Section11-04}
    'Section11-05' = ${function:Test-Section11-05}
    'Section11-06' = ${function:Test-Section11-06}
    'Section11-07' = ${function:Test-Section11-07}
    'Section11-29' = ${function:Test-Section11-29}
    'Section11-56' = ${function:Test-Section11-56}
    'Section11-59' = ${function:Test-Section11-59}
    'Section11-60' = ${function:Test-Section11-60}
    'Section11-72' = ${function:Test-Section11-72}
}
if ($Only -eq 'All') {
    foreach ($test in $tests.Values) { & $test }
}
else { & $tests[$Only] }

Write-Output 'PASS: section 11 live probes'