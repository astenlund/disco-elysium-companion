#Requires -Version 7.5

[CmdletBinding()]
param(
    [Parameter()]
    [ValidateSet('All', 'EscapeEquivalentDuplicate', 'BoundaryMatrix', 'CaseAndLexemes', 'BudgetsAndDepth', 'InvalidUtf8', 'ScalarRoots', 'OwnedElement', 'Serialization')]
    [string] $Only = 'All'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Import-Module (Join-Path (Split-Path $PSScriptRoot -Parent) 'DigestDiff.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'TestSupport.psm1') -Force

function Test-ReadRejectsEscapeEquivalentDuplicate {
    Assert-ThrowsType -TypeName 'CompanionJsonParseException' -Action {
        Read-CompanionJson -Json '{"x":1,"\u0078":2}' -Budget config
    }
}

function Test-ReadBoundaryMatrixForBothInputs {
    $path = Join-Path (Join-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) '.tmp') "companion-json-$PID-matrix.json"
    try {
        foreach ($json in @('{"x":1,"x":2}', '{"x":1,"\u0078":2}', '{"x":')) {
            [IO.File]::WriteAllText($path, $json, [Text.UTF8Encoding]::new($false))
            Assert-ThrowsType -TypeName 'CompanionJsonParseException' -Action { Read-CompanionJson -Json $json -Budget config }
            Assert-ThrowsType -TypeName 'CompanionJsonParseException' -Action { Read-CompanionJson -Path $path -Budget config }
        }
        $caseDistinct = '{"x":1,"X":2}'
        [IO.File]::WriteAllText($path, $caseDistinct, [Text.UTF8Encoding]::new($false))
        foreach ($value in @((Read-CompanionJson -Json $caseDistinct -Budget config), (Read-CompanionJson -Path $path -Budget config))) {
            Assert-True -Condition ($value.Materialized.ContainsKey('x') -and $value.Materialized.ContainsKey('X')) -Message 'case-distinct properties are legal for both inputs'
        }
        $exact = '{"x":1}'
        $byteCount = [Text.Encoding]::UTF8.GetByteCount($exact)
        [IO.File]::WriteAllText($path, $exact, [Text.UTF8Encoding]::new($false))
        foreach ($read in @({ Read-CompanionJson -Json $exact -Budget ([pscustomobject]@{ MaxBytes = $byteCount; MaxTokens = 4; MaxTextBytes = 1 }) }, { Read-CompanionJson -Path $path -Budget ([pscustomobject]@{ MaxBytes = $byteCount; MaxTokens = 4; MaxTextBytes = 1 }) })) {
            $null = & $read
        }
        foreach ($budget in @(
                [pscustomobject]@{ MaxBytes = $byteCount - 1; MaxTokens = 4; MaxTextBytes = 1 },
                [pscustomobject]@{ MaxBytes = $byteCount; MaxTokens = 3; MaxTextBytes = 1 },
                [pscustomobject]@{ MaxBytes = $byteCount; MaxTokens = 4; MaxTextBytes = 0 })) {
            Assert-ThrowsType -TypeName 'CompanionJsonParseException' -Action { Read-CompanionJson -Json $exact -Budget $budget }
            Assert-ThrowsType -TypeName 'CompanionJsonParseException' -Action { Read-CompanionJson -Path $path -Budget $budget }
        }
    }
    finally {
        Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
    }
}

function Test-ReadPreservesCaseDistinctPropertiesAndNumberLexemes {
    $value = Read-CompanionJson -Json '{"x":1,"X":1e2}' -Budget config
    Assert-True -Condition $value.Materialized.ContainsKey('x') -Message 'lowercase property is retained'
    Assert-True -Condition $value.Materialized.ContainsKey('X') -Message 'uppercase property is retained'
    Assert-OrdinalEqual -Actual $value.RootElement.GetProperty('X').GetRawText() -Expected '1e2' -Message 'owned JSON element preserves the numeric lexeme'
}

function Test-ReadHonorsBudgetsAndDepth {
    $configBytes = [Text.Encoding]::UTF8.GetByteCount('{"x":1}')
    Assert-Equal -Actual (Read-CompanionJson -Json '{"x":1}' -Budget ([pscustomobject]@{ MaxBytes = $configBytes; MaxTokens = 4; MaxTextBytes = 1 })).Materialized['x'] -Expected ([long] 1) -Message 'exact custom budget is accepted'
    Assert-ThrowsType -TypeName 'CompanionJsonParseException' -Action {
        Read-CompanionJson -Json '{"x":1}' -Budget ([pscustomobject]@{ MaxBytes = $configBytes - 1; MaxTokens = 4; MaxTextBytes = 1 })
    }
    $maxDepth = Invoke-InCompanionModule -ScriptBlock { $script:CompanionJsonMaxDepth }
    $depth64 = ('[' * $maxDepth) + '0' + (']' * $maxDepth)
    $depth65 = ('[' * ($maxDepth + 1)) + '0' + (']' * ($maxDepth + 1))
    $null = Read-CompanionJson -Json $depth64 -Budget dump
    Assert-ThrowsType -TypeName 'CompanionJsonParseException' -Action { Read-CompanionJson -Json $depth65 -Budget dump }
    $path = Join-Path (Join-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) '.tmp') "companion-json-$PID-depth.json"
    try {
        [IO.File]::WriteAllText($path, $depth64, [Text.UTF8Encoding]::new($false))
        $null = Read-CompanionJson -Path $path -Budget dump
        [IO.File]::WriteAllText($path, $depth65, [Text.UTF8Encoding]::new($false))
        Assert-ThrowsType -TypeName 'CompanionJsonParseException' -Action { Read-CompanionJson -Path $path -Budget dump }
    }
    finally {
        Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
    }
}

function Test-ReadPathRejectsInvalidUtf8AndAllowsReplacement {
    $path = Join-Path (Join-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) '.tmp') "companion-json-$PID-invalid.json"
    try {
        [IO.File]::WriteAllBytes($path, [byte[]](0x7B, 0x22, 0x78, 0x22, 0x3A, 0xC3, 0x28, 0x7D))
        Assert-ThrowsType -TypeName 'CompanionJsonParseException' -Action { Read-CompanionJson -Path $path -Budget config }
        [IO.File]::WriteAllText($path, '{"x":true}', [Text.UTF8Encoding]::new($false))
        Assert-Equal -Actual (Read-CompanionJson -Path $path -Budget config).Materialized['x'] -Expected $true -Message 'path opens with replacement-compatible sharing'
    }
    finally {
        Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
    }
}

function Test-ReadRejectsIsolatedSurrogateAndSupportsScalarAndNull {
    Assert-ThrowsType -TypeName 'CompanionJsonParseException' -Action { Read-CompanionJson -Json ([string][char]0xD800) -Budget config }
    Assert-ThrowsType -TypeName 'CompanionJsonParseException' -Action { Read-CompanionJson -Json ([string][char]0xDC00) -Budget config }
    Assert-Equal -Actual (Read-CompanionJson -Json '42' -Budget config).Materialized -Expected ([long] 42) -Message 'scalar root is retained'
    Assert-True -Condition ($null -eq (Read-CompanionJson -Json 'null' -Budget config).Materialized) -Message 'null root is retained'
    $path = Join-Path (Join-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) '.tmp') "companion-json-$PID-scalar.json"
    try {
        [IO.File]::WriteAllText($path, '42', [Text.UTF8Encoding]::new($false))
        Assert-Equal -Actual (Read-CompanionJson -Path $path -Budget config).Materialized -Expected ([long] 42) -Message 'path scalar root is retained'
        [IO.File]::WriteAllText($path, 'null', [Text.UTF8Encoding]::new($false))
        Assert-True -Condition ($null -eq (Read-CompanionJson -Path $path -Budget config).Materialized) -Message 'path null root is retained'
    }
    finally {
        Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
    }
}

function Test-ReadKeepsOwnedElementAndRejectsMixedParameterSets {
    $value = Read-CompanionJson -Json '{"n":1e2}' -Budget config
    [GC]::Collect()
    [GC]::WaitForPendingFinalizers()
    Assert-OrdinalEqual -Actual $value.RootElement.GetProperty('n').GetRawText() -Expected '1e2' -Message 'owned element survives temporary document disposal'
    $caught = $null
    try { Read-CompanionJson -Path 'unused' -Json '{}' -Budget config } catch { $caught = $_ }
    Assert-True -Condition ($null -ne $caught -and $caught.Exception -is [Management.Automation.ParameterBindingException]) -Message 'input parameter sets are mutually exclusive'
}

function Test-SerializationUsesStrictBoundedUtf8AndExactJsonElement {
    $raw = (Read-CompanionJson -Json '{"n":1e2}' -Budget config).RootElement
    $json = ConvertTo-CompanionJson -InputObject ([ordered]@{ child = $raw; text = 'hej' }) -Budget config
    Assert-OrdinalEqual -Actual $json -Expected '{"child":{"n":1e2},"text":"hej"}' -Message 'JSON element is written without a numeric round trip'
    Assert-ThrowsType -TypeName 'CompanionJsonParseException' -Action {
        ConvertTo-CompanionJson -InputObject @{ text = 'hej' } -Budget ([pscustomobject]@{ MaxBytes = 1; MaxTokens = 10; MaxTextBytes = 10 })
    }
    $input = [ordered]@{ text = 'hej' }
    $exact = '{"text":"hej"}'
    $exactBytes = [Text.Encoding]::UTF8.GetByteCount($exact)
    Assert-OrdinalEqual -Actual (ConvertTo-CompanionJson -InputObject $input -Budget ([pscustomobject]@{ MaxBytes = $exactBytes; MaxTokens = 4; MaxTextBytes = 7 })) -Expected $exact -Message 'exact serializer limits are accepted'
    foreach ($budget in @(
            [pscustomobject]@{ MaxBytes = $exactBytes - 1; MaxTokens = 4; MaxTextBytes = 7 },
            [pscustomobject]@{ MaxBytes = $exactBytes; MaxTokens = 3; MaxTextBytes = 7 },
            [pscustomobject]@{ MaxBytes = $exactBytes; MaxTokens = 4; MaxTextBytes = 6 })) {
        Assert-ThrowsType -TypeName 'CompanionJsonParseException' -Action { ConvertTo-CompanionJson -InputObject $input -Budget $budget }
    }
}

$tests = [ordered]@{
    EscapeEquivalentDuplicate = ${function:Test-ReadRejectsEscapeEquivalentDuplicate}
    BoundaryMatrix = ${function:Test-ReadBoundaryMatrixForBothInputs}
    CaseAndLexemes = ${function:Test-ReadPreservesCaseDistinctPropertiesAndNumberLexemes}
    BudgetsAndDepth = ${function:Test-ReadHonorsBudgetsAndDepth}
    InvalidUtf8 = ${function:Test-ReadPathRejectsInvalidUtf8AndAllowsReplacement}
    ScalarRoots = ${function:Test-ReadRejectsIsolatedSurrogateAndSupportsScalarAndNull}
    OwnedElement = ${function:Test-ReadKeepsOwnedElementAndRejectsMixedParameterSets}
    Serialization = ${function:Test-SerializationUsesStrictBoundedUtf8AndExactJsonElement}
}

if ($Only -eq 'All') {
    foreach ($test in $tests.Values) {
        & $test
    }
}
else {
    & $tests[$Only]
}

Write-Output 'PASS: Companion JSON'
