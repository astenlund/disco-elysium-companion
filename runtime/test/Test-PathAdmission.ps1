#Requires -Version 7.5
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
Import-Module (Join-Path $repoRoot 'core/tests/TestSupport.psm1') -Force
Add-Type -Path (Join-Path $repoRoot 'runtime/scripts/NativeFiles.cs')
$fixture = New-ScratchCompanionRoot -Prefix 'runtime-admission'
$owned = Join-Path $fixture 'owned'
$neighbor = Join-Path $fixture 'owned-other'
[void] [IO.Directory]::CreateDirectory($owned)
[void] [IO.Directory]::CreateDirectory($neighbor)
$ordinary = Join-Path $owned 'ordinary.json'
$sentinel = Join-Path $neighbor 'sentinel.json'
[IO.File]::WriteAllText($ordinary, '{"owned":true}')
[IO.File]::WriteAllText($sentinel, '{"outsideAllowedRoot":true}')

# Arrange/Act/Assert: ordinary files and absent suffixes have distinct admission results.
$admitted = [Companion.Runtime.NativeFiles]::AdmitWithin($owned, $ordinary, $false)
Assert-True -Condition $admitted.Exists -Message 'ordinary file exists'
Assert-False -Condition $admitted.IsDirectory -Message 'ordinary target is a file'
Assert-Equal -Actual $admitted.Links -Expected ([uint32] 1) -Message 'ordinary file has one link'
Assert-True -Condition ($admitted.Identity -cmatch '^[a-f0-9]{32}$') -Message 'full file identity is returned'
$missing = [Companion.Runtime.NativeFiles]::AdmitWithin($owned, (Join-Path $owned 'missing/leaf.json'), $true)
Assert-False -Condition $missing.Exists -Message 'absent suffix stays absent'
Assert-Equal -Actual $missing.Missing.Count -Expected 2 -Message 'both absent components are reported'
Assert-OrdinalEqual -Actual $missing.Missing[0] -Expected 'missing' -Message 'missing suffix starts at first absent component'
Assert-ThrowsType 'FileNotFoundException' { [Companion.Runtime.NativeFiles]::AdmitWithin($owned, (Join-Path $owned 'missing.json'), $false) }

# Arrange/Act/Assert: component containment rejects a sibling sharing the same text prefix.
Assert-ThrowsType 'IOException' { [Companion.Runtime.NativeFiles]::AdmitWithin($owned, $sentinel, $false) }
Assert-ThrowsType 'IOException' { [Companion.Runtime.NativeFiles]::AdmitWithin($owned, (Join-Path $ordinary 'child.json'), $true) }

# Arrange/Act/Assert: no file content is opened through hard-link aliases or redirected ancestors.
$hardLink = Join-Path $owned 'hard-link.json'
[void] (New-Item -ItemType HardLink -Path $hardLink -Target $sentinel)
Assert-ThrowsType 'IOException' { [Companion.Runtime.NativeFiles]::AdmitWithin($owned, $hardLink, $false) }
$junction = Join-Path $owned 'redirected'
[void] (New-Item -ItemType Junction -Path $junction -Target $neighbor)
Assert-ThrowsType 'IOException' { [Companion.Runtime.NativeFiles]::AdmitWithin($owned, (Join-Path $junction 'sentinel.json'), $false) }
Assert-ThrowsType 'IOException' { [Companion.Runtime.NativeFiles]::AdmitWithin($owned, (Join-Path $junction 'new.json'), $true) }
Assert-ThrowsType 'IOException' { [Companion.Runtime.NativeFiles]::AdmitWithin($junction, (Join-Path $junction 'sentinel.json'), $false) }

# Arrange/Act/Assert: reject ambiguous namespace forms before attempting metadata access.
foreach ($suffix in @('ordinary.json:stream', 'NUL', 'COM1.txt', 'trailing.', 'trailing ', '../owned-other/sentinel.json')) {
    Assert-ThrowsType 'IOException' { [Companion.Runtime.NativeFiles]::AdmitWithin($owned, ($owned + '/' + $suffix), $true) }
}
Assert-ThrowsType 'IOException' { [Companion.Runtime.NativeFiles]::NormalizePath('relative.json') }
Assert-ThrowsType 'IOException' { [Companion.Runtime.NativeFiles]::NormalizePath('C:relative.json') }
Assert-OrdinalEqual -Actual ([IO.File]::ReadAllText($sentinel)) -Expected '{"outsideAllowedRoot":true}' -Message 'rejected aliases preserve the sentinel'
Assert-OrdinalEqual -Actual ([IO.File]::ReadAllText($ordinary)) -Expected '{"owned":true}' -Message 'ordinary admission changes no content'

# Arrange/Act/Assert: hashed scope paths and publication siblings can exceed legacy MAX_PATH.
$longDirectory = Join-Path (Join-Path $owned ('a' * 100)) ('b' * 100)
[void] [IO.Directory]::CreateDirectory($longDirectory)
$longFile = Join-Path $longDirectory 'record.json'
[IO.File]::WriteAllText($longFile, '{"long":true}')
Assert-True -Condition ($longFile.Length -gt 260) -Message 'fixture reaches the long-path boundary'
$longAdmission = [Companion.Runtime.NativeFiles]::AdmitWithin($owned, $longFile, $false)
Assert-True -Condition $longAdmission.Exists -Message 'ordinary long path remains admissible'
Write-Output 'PASS: native path admission'
