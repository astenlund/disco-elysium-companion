#Requires -Version 7.5
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
Import-Module (Join-Path $repoRoot 'core/tests/TestSupport.psm1') -Force
Add-Type -Path @((Join-Path $repoRoot 'runtime/scripts/NativeFiles.cs'), (Join-Path $repoRoot 'runtime/scripts/JsonDocuments.cs'), (Join-Path $repoRoot 'runtime/scripts/FileToolAdmission.cs'))
$root = New-ScratchCompanionRoot -Prefix 'file-tool-admission'
$utf8 = [Text.UTF8Encoding]::new($false, $true)
foreach ($name in @('memory', 'knowledge', 'state', 'runtime-data', '.tmp')) { [void] [IO.Directory]::CreateDirectory((Join-Path $root $name)) }
$cache = Join-Path $root 'memory/cache.md'
$knowledge = Join-Path $root 'knowledge/readme.md'
$secret = Join-Path $root 'state/current.json'
[IO.File]::WriteAllText($cache, 'cache sentinel', $utf8)
[IO.File]::WriteAllText($knowledge, 'knowledge sentinel', $utf8)
[IO.File]::WriteAllText($secret, 'state sentinel', $utf8)

function Read-Admission {
    param([string] $Target, [string] $Tool)

    return $utf8.GetString([Companion.Runtime.FileToolAdmission]::Inspect($root, $Target, $Tool)) | ConvertFrom-Json -DateKind String
}

$read = Read-Admission -Target $knowledge -Tool Read
Assert-False -Condition $read.missingLeaf -Message 'An ordinary read admits the existing leaf.'
Assert-True -Condition ($read.inspected -ge 3) -Message 'The read retains the companion root, parent and leaf.'
Assert-OrdinalEqual -Actual $read.entries[-1].kind -Expected file -Message 'Read evidence names an ordinary file.'
$newLeaf = Join-Path $root 'memory/new.md'
$write = Read-Admission -Target $newLeaf -Tool Write
Assert-True -Condition $write.missingLeaf -Message 'Write can physically admit a missing leaf below an existing memory parent.'
Assert-False -Condition ([IO.File]::Exists($newLeaf)) -Message 'Physical admission never creates its target.'
Assert-ThrowsType 'FileNotFoundException' { Read-Admission -Target $newLeaf -Tool Read }
Assert-ThrowsType 'FileNotFoundException' { Read-Admission -Target $newLeaf -Tool Edit }
Assert-ThrowsType 'IOException' { Read-Admission -Target (Join-Path $root 'memory/missing/deep.md') -Tool Write }
Assert-ThrowsType 'IOException' { Read-Admission -Target $knowledge -Tool Edit }
Assert-ThrowsType 'IOException' { Read-Admission -Target $knowledge -Tool Write }
Assert-ThrowsType 'IOException' { Read-Admission -Target $root -Tool Grep }
Assert-ThrowsType 'IOException' { Read-Admission -Target $root -Tool Glob }
foreach ($name in @('state', 'runtime-data', '.tmp')) {
    Assert-ThrowsType 'IOException' { Read-Admission -Target (Join-Path $root $name) -Tool Glob }
}
Assert-ThrowsType 'IOException' { Read-Admission -Target ($cache + ':alternate') -Tool Read }
$scan = Read-Admission -Target (Join-Path $root 'knowledge') -Tool Grep
Assert-True -Condition (@($scan.entries | Where-Object { $_.path -ceq $knowledge }).Count -eq 1) -Message 'A directory scan admits the descendant rather than its root alone.'
Assert-OrdinalEqual -Actual (Read-Admission -Target $knowledge -Tool Grep).target -Expected $knowledge -Message 'A file Grep uses direct admission.'

# The hidden descendant is not a returned-match filter: its alias must deny traversal.
$hidden = Join-Path $root 'knowledge/.hidden'
[void] [IO.Directory]::CreateDirectory($hidden)
$alias = Join-Path $hidden 'alias.md'
[void] (New-Item -ItemType HardLink -Path $alias -Target $secret)
Assert-ThrowsType 'IOException' { Read-Admission -Target (Join-Path $root 'knowledge') -Tool Glob }
Assert-ThrowsType 'IOException' { Read-Admission -Target (Join-Path $root 'knowledge') -Tool Grep }
Assert-ThrowsType 'IOException' { Read-Admission -Target $alias -Tool Read }
Assert-OrdinalEqual -Actual ([IO.File]::ReadAllText($secret)) -Expected 'state sentinel' -Message 'Forbidden aliases remain untouched.'
Assert-OrdinalEqual -Actual ([IO.File]::ReadAllText($cache)) -Expected 'cache sentinel' -Message 'Preflight never performs an edit.'
Write-Output 'PASS: file-tool physical admission'
