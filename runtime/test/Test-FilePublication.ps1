#Requires -Version 7.5
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
Import-Module (Join-Path $repoRoot 'core/tests/TestSupport.psm1') -Force
$nativeSources = @('NativeFiles.cs', 'JsonDocuments.cs', 'RuntimeFilePublication.cs') | ForEach-Object { Join-Path $repoRoot "runtime/scripts/$_" }
Add-Type -Path $nativeSources
$fixture = New-ScratchCompanionRoot -Prefix 'runtime-publication'
$utf8 = [Text.UTF8Encoding]::new($false, $true)
$target = Join-Path $fixture 'record.json'

function New-PublicationInput {
    param([Parameter(Mandatory)] [string] $Target, [Parameter(Mandatory)] [string] $Text)

    $stagedFile = $Target + '.' + [guid]::NewGuid().ToString('N') + '.tmp'
    $bytes = $utf8.GetBytes($Text)
    [IO.File]::WriteAllBytes($stagedFile, $bytes)

    return [pscustomobject]@{ path = $stagedFile; hash = [Convert]::ToHexStringLower([Security.Cryptography.SHA256]::HashData($bytes)) }
}

# Arrange/Act/Assert: absent creation preserves exact admitted bytes and caller-owned input.
$originalText = '{"version":1,"number":9007199254740993}'
$original = New-PublicationInput -Target $target -Text $originalText
$created = [Companion.Runtime.RuntimeFilePublication]::Publish($fixture, $target, $original.path, $original.hash, 'config', $true)
Assert-OrdinalEqual -Actual ([IO.File]::ReadAllText($target)) -Expected $originalText -Message 'create-only publication preserves exact bytes'
Assert-True -Condition ([IO.File]::Exists($original.path)) -Message 'helper leaves caller-owned input alone'
Assert-Equal -Actual $created.RetainedSiblings.Length -Expected 0 -Message 'successful creation leaves no helper residue'

# Arrange/Act/Assert: create-only collision cannot become replacement.
$replacementText = '{"version":2,"number":0.123456789012345678901}'
$replacement = New-PublicationInput -Target $target -Text $replacementText
Assert-ThrowsType 'IOException' { [Companion.Runtime.RuntimeFilePublication]::Publish($fixture, $target, $replacement.path, $replacement.hash, 'config', $true) }
Assert-OrdinalEqual -Actual ([IO.File]::ReadAllText($target)) -Expected $originalText -Message 'collision leaves original bytes'

# Arrange/Act/Assert: an existing reader retains the complete old object across replacement.
$held = [IO.File]::Open($target, [IO.FileMode]::Open, [IO.FileAccess]::Read, ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
try {
    $published = [Companion.Runtime.RuntimeFilePublication]::Publish($fixture, $target, $replacement.path, $replacement.hash, 'config', $false)
    Assert-OrdinalEqual -Actual ([IO.File]::ReadAllText($target)) -Expected $replacementText -Message 'new reader sees complete new bytes'
    $oldBytes = [byte[]]::new($utf8.GetByteCount($originalText))
    Assert-Equal -Actual $held.Read($oldBytes, 0, $oldBytes.Length) -Expected $oldBytes.Length -Message 'held reader retains complete old length'
    Assert-OrdinalEqual -Actual ($utf8.GetString($oldBytes)) -Expected $originalText -Message 'held reader retains old content'
    Assert-Equal -Actual $published.RetainedSiblings.Length -Expected 0 -Message 'replacement cleans its backup'
}
finally { $held.Dispose() }

# Arrange/Act/Assert: publication never trusts stale hashes or permissive JSON.
Assert-ThrowsType 'IOException' { [Companion.Runtime.RuntimeFilePublication]::Publish($fixture, $target, $original.path, ('0' * 64), 'config', $false) }
foreach ($invalid in @('{"a":1,"a":2}', ('{"text":"' + ('x' * 524288) + '"}'), ('[' + ((@('0') * 65535) -join ',') + ']'), '[')) {
    $staged = New-PublicationInput -Target $target -Text $invalid
    Assert-ThrowsType 'DocumentInvalidException' { [Companion.Runtime.RuntimeFilePublication]::Publish($fixture, $target, $staged.path, $staged.hash, 'config', $false) }
    Assert-OrdinalEqual -Actual ([IO.File]::ReadAllText($target)) -Expected $replacementText -Message 'invalid input never replaces authority'
}

# Arrange/Act/Assert: an unsafe destination cannot redirect publication to another file.
$protectedFile = Join-Path $fixture 'protected.json'
[IO.File]::WriteAllText($protectedFile, '{"unchanged":true}')
$alias = Join-Path $fixture 'alias.json'
[void] (New-Item -ItemType HardLink -Path $alias -Target $protectedFile)
$aliasInput = New-PublicationInput -Target $alias -Text '{"changed":true}'
Assert-ThrowsType 'IOException' { [Companion.Runtime.RuntimeFilePublication]::Publish($fixture, $alias, $aliasInput.path, $aliasInput.hash, 'config', $false) }
Assert-OrdinalEqual -Actual ([IO.File]::ReadAllText($protectedFile)) -Expected '{"unchanged":true}' -Message 'hard-link destination is untouched'

# Arrange/Act/Assert: prepared text is a bounded, create-only transient at its fixed path.
$tagged = '<companion-turn-context>{"example":9007199254740993}</companion-turn-context>'
$prepared = [Companion.Runtime.RuntimeFilePublication]::PublishPreparedContext($fixture, $utf8.GetBytes($tagged))
$preparedPath = Join-Path $fixture 'prepared-context.txt'
Assert-OrdinalEqual -Actual ([IO.File]::ReadAllText($preparedPath)) -Expected $tagged -Message 'prepared bytes are preserved exactly'
Assert-Equal -Actual $prepared.RetainedSiblings.Length -Expected 0 -Message 'prepared publication leaves no helper residue'
Assert-ThrowsType 'IOException' { [Companion.Runtime.RuntimeFilePublication]::PublishPreparedContext($fixture, $utf8.GetBytes($tagged)) }
Assert-OrdinalEqual -Actual ([IO.File]::ReadAllText($preparedPath)) -Expected $tagged -Message 'an existing artifact cannot be overwritten by another allocation'
[IO.File]::Delete($preparedPath)
foreach ($invalid in @('{}', '<companion-turn-context>{"x":1,"x":2}</companion-turn-context>', ('<companion-turn-context>{"x":"' + ('x' * 4194304) + '"}</companion-turn-context>'))) {
    Assert-ThrowsType 'DocumentInvalidException' { [Companion.Runtime.RuntimeFilePublication]::PublishPreparedContext($fixture, $utf8.GetBytes($invalid)) }
    Assert-False -Condition ([IO.File]::Exists($preparedPath)) -Message 'invalid prepared bytes create no artifact'
}
Write-Output 'PASS: runtime file publication'
