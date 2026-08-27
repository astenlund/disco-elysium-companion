#Requires -Version 7.5

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Import-Module (Join-Path $PSScriptRoot 'TestSupport.psm1') -Force
Import-Module (Join-Path $PSScriptRoot '../DigestDiff.psm1') -Force -DisableNameChecking

# Arrange
$root = New-ScratchCompanionRoot -Prefix 'validated-turn-context-success'
$core = Join-Path $root 'core'
Copy-CompanionCoreTree -Destination $core -EntryScripts @('Get-TurnContext.ps1', 'Get-ValidatedTurnContext.ps1')
$saveDirectory = Join-Path $root 'saves'
[void] [System.IO.Directory]::CreateDirectory($saveDirectory)
[System.IO.File]::WriteAllText((Join-Path $saveDirectory 's-a.zip'), 'fixture', [System.Text.UTF8Encoding]::new($false))
$adapterDirectory = Join-Path $root 'adapters/stub'
[void] [System.IO.Directory]::CreateDirectory($adapterDirectory)
Install-StubAdapterRelease -AdapterDirectory $adapterDirectory
$adapterJson = New-StubAdapterCommandConfig -SaveDirectory $saveDirectory | ConvertTo-Json -Depth 8
[System.IO.File]::WriteAllText((Join-Path $adapterDirectory 'adapter.json'), $adapterJson, [System.Text.UTF8Encoding]::new($false))
$innerResult = Invoke-BoundedPwsh -Arguments @('-File', (Join-Path $core 'Get-TurnContext.ps1'), '-CompanionRoot', $root) -WorkingDirectory $root
Assert-Equal -Actual $innerResult.ExitCode -Expected 0 -Message 'The fixture wrapper produces a successful envelope.'
Assert-Equal -Actual $innerResult.StdErr -Expected '' -Message 'The fixture wrapper produces no stderr.'
$envelopePath = Join-Path $root 'expected-envelope.json'
$tracePath = Join-Path $root 'validated-trace.txt'
[System.IO.File]::WriteAllText($envelopePath, $innerResult.StdOut, [System.Text.UTF8Encoding]::new($false))
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'Invoke-ValidatedTurnContextChildHarness.ps1') -Destination (Join-Path $core 'Get-TurnContext.ps1') -Force

# Act
$result = Invoke-BoundedPwshBytes -Arguments @('-File', (Join-Path $core 'Get-ValidatedTurnContext.ps1'), '-CompanionRoot', $root) -WorkingDirectory $root -Environment @{
    COMPANION_TEST_VALIDATED_ENVELOPE = $envelopePath
    COMPANION_TEST_VALIDATED_TRACE = $tracePath
}

# Assert
Assert-Equal -Actual $result.ExitCode -Expected 0 -Message 'The validated entry point succeeds for an admitted envelope.'
Assert-OrdinalEqual -Actual $result.StdOut -Expected $innerResult.StdOut -Message 'The validated entry point preserves the complete envelope exactly.'
Assert-True -Condition ([System.Linq.Enumerable]::SequenceEqual[byte]($result.StdOutBytes, [System.IO.File]::ReadAllBytes($envelopePath))) -Message 'The validated entry point preserves the complete envelope byte for byte.'
Assert-Equal -Actual $result.StdErr -Expected '' -Message 'A successful validated entry point emits no stderr.'
Assert-OrdinalEqual -Actual ([System.IO.File]::ReadAllText($tracePath).Trim()) -Expected 'invoked' -Message 'The validated entry point invokes the inner wrapper exactly once.'

# Arrange
$escapeSpelling = 'stub' + [char] 0x5c + 'u0067ame'
$escapedEnvelope = $innerResult.StdOut.Replace('stubgame', $escapeSpelling, [System.StringComparison]::Ordinal)
$escapedEnvelopePath = Join-Path $root 'escaped-envelope.json'
$escapedEnvelopeTracePath = Join-Path $root 'validated-escaped-envelope-trace.txt'
[System.IO.File]::WriteAllText($escapedEnvelopePath, $escapedEnvelope, [System.Text.UTF8Encoding]::new($false))

# Act
$escapedEnvelopeResult = Invoke-BoundedPwshBytes -Arguments @('-File', (Join-Path $core 'Get-ValidatedTurnContext.ps1'), '-CompanionRoot', $root) -WorkingDirectory $root -Environment @{
    COMPANION_TEST_VALIDATED_ENVELOPE = $escapedEnvelopePath
    COMPANION_TEST_VALIDATED_TRACE = $escapedEnvelopeTracePath
}

# Assert
Assert-Equal -Actual $escapedEnvelopeResult.ExitCode -Expected 0 -Message 'A valid envelope with noncanonical escape spelling is admitted.'
Assert-True -Condition ([System.Linq.Enumerable]::SequenceEqual[byte]($escapedEnvelopeResult.StdOutBytes, [System.IO.File]::ReadAllBytes($escapedEnvelopePath))) -Message 'Noncanonical JSON escape spelling is forwarded byte for byte without reserialization.'
Assert-OrdinalEqual -Actual ([System.IO.File]::ReadAllText($escapedEnvelopeTracePath).Trim()) -Expected 'invoked' -Message 'The escaped-envelope path invokes the inner wrapper exactly once.'

# Arrange
$outerDeliveryTracePath = Join-Path $root 'validated-outer-delivery-trace.txt'
$partialDeliveryLength = 17

# Act
$outerDeliveryResult = Invoke-BoundedPwsh -Arguments @('-File', (Join-Path $core 'Get-ValidatedTurnContext.ps1'), '-CompanionRoot', $root, '-OutputFailureAfterBytes', $partialDeliveryLength) -WorkingDirectory $root -Environment @{
    COMPANION_TEST_VALIDATED_ENVELOPE = $envelopePath
    COMPANION_TEST_VALIDATED_TRACE = $outerDeliveryTracePath
}

# Assert
Assert-Equal -Actual $outerDeliveryResult.ExitCode -Expected 1 -Message 'A partial final stdout write becomes a typed delivery failure.'
Assert-OrdinalEqual -Actual $outerDeliveryResult.StdOut -Expected $innerResult.StdOut.Substring(0, $partialDeliveryLength) -Message 'A delivery failure exposes only the injected partial stdout prefix.'
Assert-True -Condition $outerDeliveryResult.StdErr.StartsWith('[turn-context:delivery] ', [System.StringComparison]::Ordinal) -Message 'A partial final stdout write emits a delivery diagnostic.'
$outerDeliveryJson = $outerDeliveryResult.StdErr.Substring('[turn-context:delivery] '.Length).TrimEnd("`r", "`n")
$outerDeliveryDiagnostic = Read-TurnContextDiagnostic -Json $outerDeliveryJson -ExpectedClass delivery
Assert-OrdinalEqual -Actual $outerDeliveryDiagnostic.Materialized['consumptionState'] -Expected 'consumed' -Message 'A final stdout failure preserves consumed state.'
Assert-OrdinalEqual -Actual $outerDeliveryDiagnostic.Materialized['detail'] -Expected 'stdout-write-failed' -Message 'A final stdout failure reports the delivery reason.'
Assert-OrdinalEqual -Actual ([System.IO.File]::ReadAllText($outerDeliveryTracePath).Trim()) -Expected 'invoked' -Message 'The outer-delivery path invokes the inner wrapper exactly once.'

# Arrange
$exactEnvelopeBytes = [System.Text.UTF8Encoding]::new($false, $true).GetByteCount($innerResult.StdOut)
$exactCapTracePath = Join-Path $root 'validated-exact-cap-trace.txt'

# Act
$exactCapResult = Invoke-BoundedPwsh -Arguments @('-File', (Join-Path $core 'Get-ValidatedTurnContext.ps1'), '-CompanionRoot', $root, '-StandardOutputMaximumBytes', $exactEnvelopeBytes) -WorkingDirectory $root -Environment @{
    COMPANION_TEST_VALIDATED_ENVELOPE = $envelopePath
    COMPANION_TEST_VALIDATED_TRACE = $exactCapTracePath
}

# Assert
Assert-Equal -Actual $exactCapResult.ExitCode -Expected 0 -Message 'A successful envelope exactly at the stdout byte cap is accepted.'
Assert-OrdinalEqual -Actual $exactCapResult.StdOut -Expected $innerResult.StdOut -Message 'Exact-cap stdout preserves the complete envelope.'
Assert-Equal -Actual $exactCapResult.StdErr -Expected '' -Message 'Exact-cap stdout emits no stderr.'
Assert-OrdinalEqual -Actual ([System.IO.File]::ReadAllText($exactCapTracePath).Trim()) -Expected 'invoked' -Message 'The exact-cap path invokes the inner wrapper exactly once.'

# Arrange
$stdoutOverflowTracePath = Join-Path $root 'validated-stdout-overflow-trace.txt'

# Act
$stdoutOverflowResult = Invoke-BoundedPwsh -Arguments @('-File', (Join-Path $core 'Get-ValidatedTurnContext.ps1'), '-CompanionRoot', $root, '-StandardOutputMaximumBytes', ($exactEnvelopeBytes - 1)) -WorkingDirectory $root -Environment @{
    COMPANION_TEST_VALIDATED_ENVELOPE = $envelopePath
    COMPANION_TEST_VALIDATED_TRACE = $stdoutOverflowTracePath
}

# Assert
Assert-Equal -Actual $stdoutOverflowResult.ExitCode -Expected 1 -Message 'Stdout one byte above its cap fails closed.'
Assert-Equal -Actual $stdoutOverflowResult.StdOut -Expected '' -Message 'Overflowing stdout is never injected.'
Assert-True -Condition $stdoutOverflowResult.StdErr.StartsWith('[turn-context:protocol] ', [System.StringComparison]::Ordinal) -Message 'Overflowing stdout emits a typed protocol diagnostic.'
$stdoutOverflowJson = $stdoutOverflowResult.StdErr.Substring('[turn-context:protocol] '.Length).TrimEnd("`r", "`n")
$stdoutOverflowDiagnostic = Read-TurnContextDiagnostic -Json $stdoutOverflowJson -ExpectedClass protocol -HostGenerated
Assert-OrdinalEqual -Actual $stdoutOverflowDiagnostic.Materialized['consumptionState'] -Expected 'unknown' -Message 'Stdout overflow after process start preserves unknown consumption.'
Assert-OrdinalEqual -Actual $stdoutOverflowDiagnostic.Materialized['detail'] -Expected 'attempt-result-invalid' -Message 'Stdout overflow reports an unavailable attempt result.'
Assert-OrdinalEqual -Actual ([System.IO.File]::ReadAllText($stdoutOverflowTracePath).Trim()) -Expected 'invoked' -Message 'The stdout-overflow path invokes the inner wrapper exactly once.'

# Arrange
$productionStdoutCapTracePath = Join-Path $root 'validated-production-stdout-cap-trace.txt'
$productionStdoutCapCompletionPath = Join-Path $root 'validated-production-stdout-cap-completed.txt'

# Act
$productionStdoutCapResult = Invoke-BoundedPwsh -Arguments @('-File', (Join-Path $core 'Get-ValidatedTurnContext.ps1'), '-CompanionRoot', $root) -WorkingDirectory $root -TimeoutMilliseconds 30000 -Environment @{
    COMPANION_TEST_VALIDATED_COMPLETION_TRACE = $productionStdoutCapCompletionPath
    COMPANION_TEST_VALIDATED_SCENARIO = 'production-stdout-cap'
    COMPANION_TEST_VALIDATED_TRACE = $productionStdoutCapTracePath
}

# Assert
Assert-Equal -Actual $productionStdoutCapResult.ExitCode -Expected 1 -Message 'Production stdout exactly at its byte cap reaches envelope validation.'
$productionStdoutCapJson = $productionStdoutCapResult.StdErr.Substring('[turn-context:protocol] '.Length).TrimEnd("`r", "`n")
$productionStdoutCapDiagnostic = Read-TurnContextDiagnostic -Json $productionStdoutCapJson -ExpectedClass protocol -HostGenerated
Assert-OrdinalEqual -Actual $productionStdoutCapDiagnostic.Materialized['consumptionState'] -Expected 'consumed' -Message 'Exact production stdout is classified by exit-zero envelope validation, not transport overflow.'
Assert-OrdinalEqual -Actual ([System.IO.File]::ReadAllText($productionStdoutCapCompletionPath)) -Expected 'completed' -Message 'The exact production stdout cap lets the child complete.'

# Arrange
$productionStdoutOverflowTracePath = Join-Path $root 'validated-production-stdout-overflow-trace.txt'
$productionStdoutOverflowCompletionPath = Join-Path $root 'validated-production-stdout-overflow-completed.txt'

# Act
$productionStdoutOverflowResult = Invoke-BoundedPwsh -Arguments @('-File', (Join-Path $core 'Get-ValidatedTurnContext.ps1'), '-CompanionRoot', $root) -WorkingDirectory $root -TimeoutMilliseconds 30000 -Environment @{
    COMPANION_TEST_VALIDATED_COMPLETION_TRACE = $productionStdoutOverflowCompletionPath
    COMPANION_TEST_VALIDATED_SCENARIO = 'production-stdout-overflow'
    COMPANION_TEST_VALIDATED_TRACE = $productionStdoutOverflowTracePath
}

# Assert
Assert-Equal -Actual $productionStdoutOverflowResult.ExitCode -Expected 1 -Message 'Production stdout cap plus one fails closed.'
$productionStdoutOverflowJson = $productionStdoutOverflowResult.StdErr.Substring('[turn-context:protocol] '.Length).TrimEnd("`r", "`n")
$productionStdoutOverflowDiagnostic = Read-TurnContextDiagnostic -Json $productionStdoutOverflowJson -ExpectedClass protocol -HostGenerated
Assert-OrdinalEqual -Actual $productionStdoutOverflowDiagnostic.Materialized['consumptionState'] -Expected 'unknown' -Message 'Production stdout cap plus one latches transport overflow.'
Assert-False -Condition ([System.IO.File]::Exists($productionStdoutOverflowCompletionPath)) -Message 'Production stdout overflow terminates the child before completion.'

# Arrange
$terminalTracePath = Join-Path $root 'validated-terminal-trace.txt'
$diagnosticPath = Join-Path $root 'terminal-diagnostic.txt'
$terminalDiagnostic = '[turn-context:config] {"outcomeClass":"config","consumptionState":"none","lockStage":null,"sourceIdentity":null,"generationTimestamp":null,"detail":"adapter-resolution-failed","warnings":[]}' + [System.Environment]::NewLine
[System.IO.File]::WriteAllText($diagnosticPath, $terminalDiagnostic, [System.Text.UTF8Encoding]::new($false))

# Act
$terminalResult = Invoke-BoundedPwsh -Arguments @('-File', (Join-Path $core 'Get-ValidatedTurnContext.ps1'), '-CompanionRoot', $root) -WorkingDirectory $root -Environment @{
    COMPANION_TEST_VALIDATED_DIAGNOSTIC = $diagnosticPath
    COMPANION_TEST_VALIDATED_SCENARIO = 'terminal'
    COMPANION_TEST_VALIDATED_TRACE = $terminalTracePath
}

# Assert
Assert-Equal -Actual $terminalResult.ExitCode -Expected 1 -Message 'The validated entry point preserves an inner terminal failure.'
Assert-Equal -Actual $terminalResult.StdOut -Expected '' -Message 'An inner terminal failure emits no stdout.'
Assert-OrdinalEqual -Actual $terminalResult.StdErr -Expected $terminalDiagnostic -Message 'The validated entry point preserves a validated terminal diagnostic exactly.'
Assert-OrdinalEqual -Actual ([System.IO.File]::ReadAllText($terminalTracePath).Trim()) -Expected 'invoked' -Message 'The terminal path invokes the inner wrapper exactly once.'

# Arrange
$illegalTerminalCases = @(
    [pscustomobject]@{ Name = 'success'; Diagnostic = '[turn-context:success] {"outcomeClass":"success","consumptionState":"consumed","lockStage":null,"sourceIdentity":null,"generationTimestamp":null,"detail":null,"warnings":[]}' + [System.Environment]::NewLine },
    [pscustomobject]@{ Name = 'emit'; Diagnostic = '[turn-context:emit] {"outcomeClass":"emit","consumptionState":"none","lockStage":null,"sourceIdentity":null,"generationTimestamp":null,"detail":"payload-serialize-failed","warnings":[]}' + [System.Environment]::NewLine },
    [pscustomobject]@{ Name = 'consumed-reset'; Diagnostic = '[turn-context:reset-write:consumed] {"outcomeClass":"reset-write:consumed","consumptionState":"consumed","lockStage":null,"sourceIdentity":null,"generationTimestamp":null,"detail":"cache-target-invalid","warnings":[]}' + [System.Environment]::NewLine },
    [pscustomobject]@{ Name = 'class-case'; Diagnostic = '[turn-context:Config] {"outcomeClass":"Config","consumptionState":"none","lockStage":null,"sourceIdentity":null,"generationTimestamp":null,"detail":"adapter-resolution-failed","warnings":[]}' + [System.Environment]::NewLine },
    [pscustomobject]@{ Name = 'reason-case'; Diagnostic = '[turn-context:config] {"outcomeClass":"config","consumptionState":"none","lockStage":null,"sourceIdentity":null,"generationTimestamp":null,"detail":"Adapter-resolution-failed","warnings":[]}' + [System.Environment]::NewLine }
)

foreach ($illegalTerminalCase in $illegalTerminalCases) {
    $illegalTerminalPath = Join-Path $root "illegal-terminal-$($illegalTerminalCase.Name).txt"
    $illegalTerminalTracePath = Join-Path $root "validated-illegal-terminal-$($illegalTerminalCase.Name)-trace.txt"
    [System.IO.File]::WriteAllText($illegalTerminalPath, $illegalTerminalCase.Diagnostic, [System.Text.UTF8Encoding]::new($false))

    # Act
    $illegalTerminalResult = Invoke-BoundedPwsh -Arguments @('-File', (Join-Path $core 'Get-ValidatedTurnContext.ps1'), '-CompanionRoot', $root) -WorkingDirectory $root -Environment @{
        COMPANION_TEST_VALIDATED_DIAGNOSTIC = $illegalTerminalPath
        COMPANION_TEST_VALIDATED_SCENARIO = 'terminal'
        COMPANION_TEST_VALIDATED_TRACE = $illegalTerminalTracePath
    }

    # Assert
    Assert-Equal -Actual $illegalTerminalResult.ExitCode -Expected 1 -Message "Illegal terminal case '$($illegalTerminalCase.Name)' fails closed."
    Assert-Equal -Actual $illegalTerminalResult.StdOut -Expected '' -Message "Illegal terminal case '$($illegalTerminalCase.Name)' emits no stdout."
    Assert-True -Condition $illegalTerminalResult.StdErr.StartsWith('[turn-context:protocol] ', [System.StringComparison]::Ordinal) -Message "Illegal terminal case '$($illegalTerminalCase.Name)' emits a replacement protocol diagnostic."
    $illegalTerminalJson = $illegalTerminalResult.StdErr.Substring('[turn-context:protocol] '.Length).TrimEnd("`r", "`n")
    $illegalTerminalDiagnostic = Read-TurnContextDiagnostic -Json $illegalTerminalJson -ExpectedClass protocol -HostGenerated
    Assert-OrdinalEqual -Actual $illegalTerminalDiagnostic.Materialized['consumptionState'] -Expected 'unknown' -Message "Illegal terminal case '$($illegalTerminalCase.Name)' preserves unknown consumption."
    Assert-OrdinalEqual -Actual ([System.IO.File]::ReadAllText($illegalTerminalTracePath).Trim()) -Expected 'invoked' -Message "Illegal terminal case '$($illegalTerminalCase.Name)' invokes the inner wrapper exactly once."
}

# Arrange
$exactDiagnosticBytes = [System.Text.UTF8Encoding]::new($false, $true).GetByteCount($terminalDiagnostic)
$exactStderrCapTracePath = Join-Path $root 'validated-exact-stderr-cap-trace.txt'

# Act
$exactStderrCapResult = Invoke-BoundedPwsh -Arguments @('-File', (Join-Path $core 'Get-ValidatedTurnContext.ps1'), '-CompanionRoot', $root, '-StandardErrorMaximumBytes', $exactDiagnosticBytes) -WorkingDirectory $root -Environment @{
    COMPANION_TEST_VALIDATED_DIAGNOSTIC = $diagnosticPath
    COMPANION_TEST_VALIDATED_SCENARIO = 'terminal'
    COMPANION_TEST_VALIDATED_TRACE = $exactStderrCapTracePath
}

# Assert
Assert-Equal -Actual $exactStderrCapResult.ExitCode -Expected 1 -Message 'A valid diagnostic exactly at the stderr byte cap is accepted.'
Assert-Equal -Actual $exactStderrCapResult.StdOut -Expected '' -Message 'Exact-cap terminal failure emits no stdout.'
Assert-OrdinalEqual -Actual $exactStderrCapResult.StdErr -Expected $terminalDiagnostic -Message 'Exact-cap stderr preserves the diagnostic exactly.'
Assert-OrdinalEqual -Actual ([System.IO.File]::ReadAllText($exactStderrCapTracePath).Trim()) -Expected 'invoked' -Message 'The exact-stderr-cap path invokes the inner wrapper exactly once.'

# Arrange
$stderrOverflowTracePath = Join-Path $root 'validated-stderr-overflow-trace.txt'

# Act
$stderrOverflowResult = Invoke-BoundedPwsh -Arguments @('-File', (Join-Path $core 'Get-ValidatedTurnContext.ps1'), '-CompanionRoot', $root, '-StandardErrorMaximumBytes', ($exactDiagnosticBytes - 1)) -WorkingDirectory $root -Environment @{
    COMPANION_TEST_VALIDATED_DIAGNOSTIC = $diagnosticPath
    COMPANION_TEST_VALIDATED_SCENARIO = 'terminal'
    COMPANION_TEST_VALIDATED_TRACE = $stderrOverflowTracePath
}

# Assert
Assert-Equal -Actual $stderrOverflowResult.ExitCode -Expected 1 -Message 'Stderr one byte above its cap fails closed.'
Assert-Equal -Actual $stderrOverflowResult.StdOut -Expected '' -Message 'A stderr overflow emits no stdout.'
Assert-True -Condition $stderrOverflowResult.StdErr.StartsWith('[turn-context:protocol] ', [System.StringComparison]::Ordinal) -Message 'A stderr overflow emits a replacement protocol diagnostic.'
$stderrOverflowJson = $stderrOverflowResult.StdErr.Substring('[turn-context:protocol] '.Length).TrimEnd("`r", "`n")
$stderrOverflowDiagnostic = Read-TurnContextDiagnostic -Json $stderrOverflowJson -ExpectedClass protocol -HostGenerated
Assert-OrdinalEqual -Actual $stderrOverflowDiagnostic.Materialized['consumptionState'] -Expected 'unknown' -Message 'Stderr overflow after process start preserves unknown consumption.'
Assert-OrdinalEqual -Actual $stderrOverflowDiagnostic.Materialized['detail'] -Expected 'attempt-result-invalid' -Message 'Stderr overflow reports an unavailable attempt result.'
Assert-OrdinalEqual -Actual ([System.IO.File]::ReadAllText($stderrOverflowTracePath).Trim()) -Expected 'invoked' -Message 'The stderr-overflow path invokes the inner wrapper exactly once.'

# Arrange
$productionStderrCapTracePath = Join-Path $root 'validated-production-stderr-cap-trace.txt'
$productionStderrCapCompletionPath = Join-Path $root 'validated-production-stderr-cap-completed.txt'

# Act
$productionStderrCapResult = Invoke-BoundedPwsh -Arguments @('-File', (Join-Path $core 'Get-ValidatedTurnContext.ps1'), '-CompanionRoot', $root) -WorkingDirectory $root -TimeoutMilliseconds 30000 -Environment @{
    COMPANION_TEST_VALIDATED_COMPLETION_TRACE = $productionStderrCapCompletionPath
    COMPANION_TEST_VALIDATED_SCENARIO = 'production-stderr-cap'
    COMPANION_TEST_VALIDATED_TRACE = $productionStderrCapTracePath
}

# Assert
Assert-Equal -Actual $productionStderrCapResult.ExitCode -Expected 1 -Message 'Production stderr exactly at its byte cap reaches diagnostic validation.'
Assert-True -Condition $productionStderrCapResult.StdErr.StartsWith('[turn-context:protocol] ', [System.StringComparison]::Ordinal) -Message 'Exact production stderr emits a replacement protocol diagnostic after framing validation.'
$productionStderrCapJson = $productionStderrCapResult.StdErr.Substring('[turn-context:protocol] '.Length).TrimEnd("`r", "`n")
$productionStderrCapDiagnostic = Read-TurnContextDiagnostic -Json $productionStderrCapJson -ExpectedClass protocol -HostGenerated
Assert-OrdinalEqual -Actual $productionStderrCapDiagnostic.Materialized['consumptionState'] -Expected 'unknown' -Message 'Exact production stderr is classified by invalid framing after clean capture.'
Assert-OrdinalEqual -Actual ([System.IO.File]::ReadAllText($productionStderrCapCompletionPath)) -Expected 'completed' -Message 'The exact production stderr cap lets the child complete.'

# Arrange
$productionStderrOverflowTracePath = Join-Path $root 'validated-production-stderr-overflow-trace.txt'
$productionStderrOverflowCompletionPath = Join-Path $root 'validated-production-stderr-overflow-completed.txt'

# Act
$productionStderrOverflowResult = Invoke-BoundedPwsh -Arguments @('-File', (Join-Path $core 'Get-ValidatedTurnContext.ps1'), '-CompanionRoot', $root) -WorkingDirectory $root -TimeoutMilliseconds 30000 -Environment @{
    COMPANION_TEST_VALIDATED_COMPLETION_TRACE = $productionStderrOverflowCompletionPath
    COMPANION_TEST_VALIDATED_SCENARIO = 'production-stderr-overflow'
    COMPANION_TEST_VALIDATED_TRACE = $productionStderrOverflowTracePath
}

# Assert
Assert-Equal -Actual $productionStderrOverflowResult.ExitCode -Expected 1 -Message 'Production stderr cap plus one fails closed.'
Assert-True -Condition $productionStderrOverflowResult.StdErr.StartsWith('[turn-context:protocol] ', [System.StringComparison]::Ordinal) -Message 'Production stderr cap plus one emits a replacement protocol diagnostic.'
$productionStderrOverflowJson = $productionStderrOverflowResult.StdErr.Substring('[turn-context:protocol] '.Length).TrimEnd("`r", "`n")
$productionStderrOverflowDiagnostic = Read-TurnContextDiagnostic -Json $productionStderrOverflowJson -ExpectedClass protocol -HostGenerated
Assert-OrdinalEqual -Actual $productionStderrOverflowDiagnostic.Materialized['consumptionState'] -Expected 'unknown' -Message 'Production stderr cap plus one latches transport overflow.'
Assert-False -Condition ([System.IO.File]::Exists($productionStderrOverflowCompletionPath)) -Message 'Production stderr overflow terminates the child before completion.'

# Arrange
$deliveryTracePath = Join-Path $root 'validated-delivery-trace.txt'
$deliveryDiagnosticPath = Join-Path $root 'delivery-diagnostic.txt'
$deliveryEnvelope = Read-TurnContextEnvelope -Json $innerResult.StdOut -TransportOnly
$deliveryState = $deliveryEnvelope.Materialized['state']
$deliveryObject = New-TurnContextDiagnosticObject -Class delivery -ConsumptionState consumed -Detail (New-TurnContextDetail -Class delivery -Reason stdout-write-failed) -SourceIdentity $deliveryState['source'] -GenerationTimestamp $deliveryState['generatedAt'] -LockStage $null -OperationalWarnings (New-CompanionWarningSink -Profile TurnOperational)
$deliveryDiagnostic = '[turn-context:delivery] ' + (ConvertTo-CompanionJson -InputObject $deliveryObject -Budget config) + [System.Environment]::NewLine
[System.IO.File]::WriteAllText($deliveryDiagnosticPath, $deliveryDiagnostic, [System.Text.UTF8Encoding]::new($false))

# Act
$deliveryResult = Invoke-BoundedPwsh -Arguments @('-File', (Join-Path $core 'Get-ValidatedTurnContext.ps1'), '-CompanionRoot', $root) -WorkingDirectory $root -Environment @{
    COMPANION_TEST_VALIDATED_DIAGNOSTIC = $deliveryDiagnosticPath
    COMPANION_TEST_VALIDATED_SCENARIO = 'delivery-partial'
    COMPANION_TEST_VALIDATED_TRACE = $deliveryTracePath
}

# Assert
Assert-Equal -Actual $deliveryResult.ExitCode -Expected 1 -Message 'A delivery failure preserves the inner terminal failure.'
Assert-Equal -Actual $deliveryResult.StdOut -Expected '' -Message 'Partial delivery stdout is discarded.'
Assert-OrdinalEqual -Actual $deliveryResult.StdErr -Expected $deliveryDiagnostic -Message 'A valid delivery diagnostic survives partial child stdout.'
Assert-OrdinalEqual -Actual ([System.IO.File]::ReadAllText($deliveryTracePath).Trim()) -Expected 'invoked' -Message 'The delivery path invokes the inner wrapper exactly once.'

# Arrange
$malformedTracePath = Join-Path $root 'validated-malformed-trace.txt'

# Act
$malformedResult = Invoke-BoundedPwsh -Arguments @('-File', (Join-Path $core 'Get-ValidatedTurnContext.ps1'), '-CompanionRoot', $root) -WorkingDirectory $root -Environment @{
    COMPANION_TEST_VALIDATED_SCENARIO = 'malformed'
    COMPANION_TEST_VALIDATED_TRACE = $malformedTracePath
}

# Assert
Assert-Equal -Actual $malformedResult.ExitCode -Expected 1 -Message 'Malformed successful stdout fails closed.'
Assert-Equal -Actual $malformedResult.StdOut -Expected '' -Message 'Malformed successful stdout is never injected.'
Assert-True -Condition $malformedResult.StdErr.StartsWith('[turn-context:protocol] ', [System.StringComparison]::Ordinal) -Message 'Malformed successful stdout emits a typed protocol diagnostic.'
$malformedJson = $malformedResult.StdErr.Substring('[turn-context:protocol] '.Length).TrimEnd("`r", "`n")
$malformedDiagnostic = Read-TurnContextDiagnostic -Json $malformedJson -ExpectedClass protocol -HostGenerated
Assert-OrdinalEqual -Actual $malformedDiagnostic.Materialized['consumptionState'] -Expected 'consumed' -Message 'An exit-zero malformed envelope preserves the consumed state.'
Assert-OrdinalEqual -Actual $malformedDiagnostic.Materialized['detail'] -Expected 'envelope-invalid' -Message 'An exit-zero malformed envelope reports admission failure.'
Assert-OrdinalEqual -Actual ([System.IO.File]::ReadAllText($malformedTracePath).Trim()) -Expected 'invoked' -Message 'The malformed path invokes the inner wrapper exactly once.'

# Arrange
$invalidTerminalTracePath = Join-Path $root 'validated-invalid-terminal-trace.txt'

# Act
$invalidTerminalResult = Invoke-BoundedPwsh -Arguments @('-File', (Join-Path $core 'Get-ValidatedTurnContext.ps1'), '-CompanionRoot', $root) -WorkingDirectory $root -Environment @{
    COMPANION_TEST_VALIDATED_SCENARIO = 'invalid-terminal'
    COMPANION_TEST_VALIDATED_TRACE = $invalidTerminalTracePath
}

# Assert
Assert-Equal -Actual $invalidTerminalResult.ExitCode -Expected 1 -Message 'Invalid terminal framing fails closed.'
Assert-Equal -Actual $invalidTerminalResult.StdOut -Expected '' -Message 'Invalid terminal framing emits no stdout.'
Assert-True -Condition $invalidTerminalResult.StdErr.StartsWith('[turn-context:protocol] ', [System.StringComparison]::Ordinal) -Message 'Invalid terminal framing emits a typed protocol diagnostic.'
$invalidTerminalJson = $invalidTerminalResult.StdErr.Substring('[turn-context:protocol] '.Length).TrimEnd("`r", "`n")
$invalidTerminalDiagnostic = Read-TurnContextDiagnostic -Json $invalidTerminalJson -ExpectedClass protocol -HostGenerated
Assert-OrdinalEqual -Actual $invalidTerminalDiagnostic.Materialized['consumptionState'] -Expected 'unknown' -Message 'Invalid exit-one framing preserves unknown consumption.'
Assert-OrdinalEqual -Actual $invalidTerminalDiagnostic.Materialized['detail'] -Expected 'attempt-result-invalid' -Message 'Invalid exit-one framing reports an invalid attempt result.'
Assert-OrdinalEqual -Actual ([System.IO.File]::ReadAllText($invalidTerminalTracePath).Trim()) -Expected 'invoked' -Message 'The invalid terminal path invokes the inner wrapper exactly once.'

# Arrange
$invalidUtf8TracePath = Join-Path $root 'validated-invalid-utf8-trace.txt'

# Act
$invalidUtf8Result = Invoke-BoundedPwsh -Arguments @('-File', (Join-Path $core 'Get-ValidatedTurnContext.ps1'), '-CompanionRoot', $root) -WorkingDirectory $root -Environment @{
    COMPANION_TEST_VALIDATED_SCENARIO = 'invalid-utf8'
    COMPANION_TEST_VALIDATED_TRACE = $invalidUtf8TracePath
}

# Assert
Assert-Equal -Actual $invalidUtf8Result.ExitCode -Expected 1 -Message 'Invalid UTF-8 child output fails closed.'
Assert-Equal -Actual $invalidUtf8Result.StdOut -Expected '' -Message 'Invalid UTF-8 child output is never injected.'
Assert-True -Condition $invalidUtf8Result.StdErr.StartsWith('[turn-context:protocol] ', [System.StringComparison]::Ordinal) -Message 'Invalid UTF-8 child output emits a typed protocol diagnostic.'
$invalidUtf8Json = $invalidUtf8Result.StdErr.Substring('[turn-context:protocol] '.Length).TrimEnd("`r", "`n")
$invalidUtf8Diagnostic = Read-TurnContextDiagnostic -Json $invalidUtf8Json -ExpectedClass protocol -HostGenerated
Assert-OrdinalEqual -Actual $invalidUtf8Diagnostic.Materialized['consumptionState'] -Expected 'unknown' -Message 'Invalid UTF-8 after process start preserves unknown consumption.'
Assert-OrdinalEqual -Actual $invalidUtf8Diagnostic.Materialized['detail'] -Expected 'attempt-result-invalid' -Message 'Invalid UTF-8 reports an unavailable attempt result.'
Assert-OrdinalEqual -Actual ([System.IO.File]::ReadAllText($invalidUtf8TracePath).Trim()) -Expected 'invoked' -Message 'The invalid-UTF-8 path invokes the inner wrapper exactly once.'

# Arrange
$postBaselineTracePath = Join-Path $root 'validated-post-baseline-trace.txt'
$baselineAdvancePath = Join-Path $root 'validated-baseline-advanced.txt'

# Act
$postBaselineResult = Invoke-BoundedPwsh -Arguments @('-File', (Join-Path $core 'Get-ValidatedTurnContext.ps1'), '-CompanionRoot', $root) -WorkingDirectory $root -Environment @{
    COMPANION_TEST_VALIDATED_BASELINE_TRACE = $baselineAdvancePath
    COMPANION_TEST_VALIDATED_SCENARIO = 'invalid-utf8-after-baseline'
    COMPANION_TEST_VALIDATED_TRACE = $postBaselineTracePath
}

# Assert
Assert-Equal -Actual $postBaselineResult.ExitCode -Expected 1 -Message 'A capture failure after instrumented baseline advancement fails closed.'
$postBaselineJson = $postBaselineResult.StdErr.Substring('[turn-context:protocol] '.Length).TrimEnd("`r", "`n")
$postBaselineDiagnostic = Read-TurnContextDiagnostic -Json $postBaselineJson -ExpectedClass protocol -HostGenerated
Assert-OrdinalEqual -Actual $postBaselineDiagnostic.Materialized['consumptionState'] -Expected 'unknown' -Message 'A post-baseline capture failure does not guess consumption from rejected bytes.'
Assert-OrdinalEqual -Actual ([System.IO.File]::ReadAllText($baselineAdvancePath)) -Expected 'advanced' -Message 'The post-baseline transport fixture advanced its instrumented baseline before failing.'

# Arrange
$abnormalExitTracePath = Join-Path $root 'validated-abnormal-exit-trace.txt'

# Act
$abnormalExitResult = Invoke-BoundedPwsh -Arguments @('-File', (Join-Path $core 'Get-ValidatedTurnContext.ps1'), '-CompanionRoot', $root) -WorkingDirectory $root -Environment @{
    COMPANION_TEST_VALIDATED_SCENARIO = 'abnormal-exit'
    COMPANION_TEST_VALIDATED_TRACE = $abnormalExitTracePath
}

# Assert
Assert-Equal -Actual $abnormalExitResult.ExitCode -Expected 1 -Message 'An abnormal child exit fails closed.'
Assert-Equal -Actual $abnormalExitResult.StdOut -Expected '' -Message 'An abnormal child exit emits no stdout.'
Assert-True -Condition $abnormalExitResult.StdErr.StartsWith('[turn-context:protocol] ', [System.StringComparison]::Ordinal) -Message 'An abnormal child exit emits a typed protocol diagnostic.'
$abnormalExitJson = $abnormalExitResult.StdErr.Substring('[turn-context:protocol] '.Length).TrimEnd("`r", "`n")
$abnormalExitDiagnostic = Read-TurnContextDiagnostic -Json $abnormalExitJson -ExpectedClass protocol -HostGenerated
Assert-OrdinalEqual -Actual $abnormalExitDiagnostic.Materialized['consumptionState'] -Expected 'unknown' -Message 'An abnormal exit preserves unknown consumption.'
Assert-OrdinalEqual -Actual $abnormalExitDiagnostic.Materialized['detail'] -Expected 'attempt-result-invalid' -Message 'An abnormal exit reports an unavailable attempt result.'
Assert-OrdinalEqual -Actual ([System.IO.File]::ReadAllText($abnormalExitTracePath).Trim()) -Expected 'invoked' -Message 'The abnormal-exit path invokes the inner wrapper exactly once.'

# Arrange
$successStderrTracePath = Join-Path $root 'validated-success-stderr-trace.txt'

# Act
$successStderrResult = Invoke-BoundedPwsh -Arguments @('-File', (Join-Path $core 'Get-ValidatedTurnContext.ps1'), '-CompanionRoot', $root) -WorkingDirectory $root -Environment @{
    COMPANION_TEST_VALIDATED_ENVELOPE = $envelopePath
    COMPANION_TEST_VALIDATED_SCENARIO = 'success-stderr'
    COMPANION_TEST_VALIDATED_TRACE = $successStderrTracePath
}

# Assert
Assert-Equal -Actual $successStderrResult.ExitCode -Expected 1 -Message 'Exit zero with stderr fails closed.'
Assert-Equal -Actual $successStderrResult.StdOut -Expected '' -Message 'Exit zero with stderr never injects its envelope.'
Assert-True -Condition $successStderrResult.StdErr.StartsWith('[turn-context:protocol] ', [System.StringComparison]::Ordinal) -Message 'Exit zero with stderr emits a typed protocol diagnostic.'
$successStderrJson = $successStderrResult.StdErr.Substring('[turn-context:protocol] '.Length).TrimEnd("`r", "`n")
$successStderrDiagnostic = Read-TurnContextDiagnostic -Json $successStderrJson -ExpectedClass protocol -HostGenerated
Assert-OrdinalEqual -Actual $successStderrDiagnostic.Materialized['consumptionState'] -Expected 'consumed' -Message 'Exit zero with stderr preserves consumed state.'
Assert-OrdinalEqual -Actual $successStderrDiagnostic.Materialized['detail'] -Expected 'envelope-invalid' -Message 'Exit zero with stderr reports invalid envelope delivery.'
Assert-OrdinalEqual -Actual ([System.IO.File]::ReadAllText($successStderrTracePath).Trim()) -Expected 'invoked' -Message 'The exit-zero stderr path invokes the inner wrapper exactly once.'

# Arrange
$identityMismatchEnvelopePath = Join-Path $root 'identity-mismatch-envelope.json'
$identityMismatchTracePath = Join-Path $root 'validated-identity-mismatch-trace.txt'
$identityMismatchEnvelope = $innerResult.StdOut.Replace('"game":"stubgame"', '"game":"othergame"', [System.StringComparison]::Ordinal)
[System.IO.File]::WriteAllText($identityMismatchEnvelopePath, $identityMismatchEnvelope, [System.Text.UTF8Encoding]::new($false))

# Act
$identityMismatchResult = Invoke-BoundedPwsh -Arguments @('-File', (Join-Path $core 'Get-ValidatedTurnContext.ps1'), '-CompanionRoot', $root) -WorkingDirectory $root -Environment @{
    COMPANION_TEST_VALIDATED_ENVELOPE = $identityMismatchEnvelopePath
    COMPANION_TEST_VALIDATED_TRACE = $identityMismatchTracePath
}

# Assert
Assert-Equal -Actual $identityMismatchResult.ExitCode -Expected 1 -Message 'Adapter identity mismatch fails closed.'
Assert-Equal -Actual $identityMismatchResult.StdOut -Expected '' -Message 'Adapter identity mismatch never injects its envelope.'
Assert-True -Condition $identityMismatchResult.StdErr.StartsWith('[turn-context:protocol] ', [System.StringComparison]::Ordinal) -Message 'Adapter identity mismatch emits a typed protocol diagnostic.'
$identityMismatchJson = $identityMismatchResult.StdErr.Substring('[turn-context:protocol] '.Length).TrimEnd("`r", "`n")
$identityMismatchDiagnostic = Read-TurnContextDiagnostic -Json $identityMismatchJson -ExpectedClass protocol -HostGenerated
Assert-OrdinalEqual -Actual $identityMismatchDiagnostic.Materialized['consumptionState'] -Expected 'consumed' -Message 'Adapter identity mismatch preserves consumed state.'
Assert-OrdinalEqual -Actual $identityMismatchDiagnostic.Materialized['detail'] -Expected 'envelope-invalid' -Message 'Adapter identity mismatch reports admission failure.'
Assert-OrdinalEqual -Actual ([System.IO.File]::ReadAllText($identityMismatchTracePath).Trim()) -Expected 'invoked' -Message 'The identity-mismatch path invokes the inner wrapper exactly once.'

# Arrange
$adapterRejectionTracePath = Join-Path $root 'validated-adapter-rejection-trace.txt'
$validatorPath = Join-Path $adapterDirectory 'releases/2/schema-2/adapters/stub/Validate-Digest.psm1'
$rejectingValidator = "function Assert-AdapterDigestSemantics { param([Parameter(Mandatory)] [object] `$Document) throw [AdapterDigestValidationException]::new('fixture rejection') }`nExport-ModuleMember -Function Assert-AdapterDigestSemantics`n"
[System.IO.File]::WriteAllText($validatorPath, $rejectingValidator, [System.Text.UTF8Encoding]::new($false))

# Act
$adapterRejectionResult = Invoke-BoundedPwsh -Arguments @('-File', (Join-Path $core 'Get-ValidatedTurnContext.ps1'), '-CompanionRoot', $root) -WorkingDirectory $root -Environment @{
    COMPANION_TEST_VALIDATED_ENVELOPE = $envelopePath
    COMPANION_TEST_VALIDATED_TRACE = $adapterRejectionTracePath
}

# Assert
Assert-Equal -Actual $adapterRejectionResult.ExitCode -Expected 1 -Message 'Adapter semantic rejection fails closed.'
Assert-Equal -Actual $adapterRejectionResult.StdOut -Expected '' -Message 'Adapter semantic rejection never injects its envelope.'
Assert-True -Condition $adapterRejectionResult.StdErr.StartsWith('[turn-context:protocol] ', [System.StringComparison]::Ordinal) -Message 'Adapter semantic rejection emits a typed protocol diagnostic.'
$adapterRejectionJson = $adapterRejectionResult.StdErr.Substring('[turn-context:protocol] '.Length).TrimEnd("`r", "`n")
$adapterRejectionDiagnostic = Read-TurnContextDiagnostic -Json $adapterRejectionJson -ExpectedClass protocol -HostGenerated
Assert-OrdinalEqual -Actual $adapterRejectionDiagnostic.Materialized['consumptionState'] -Expected 'consumed' -Message 'Adapter semantic rejection preserves consumed state.'
Assert-OrdinalEqual -Actual $adapterRejectionDiagnostic.Materialized['detail'] -Expected 'envelope-invalid' -Message 'Adapter semantic rejection reports admission failure.'
Assert-OrdinalEqual -Actual ([System.IO.File]::ReadAllText($adapterRejectionTracePath).Trim()) -Expected 'invoked' -Message 'The adapter-rejection path invokes the inner wrapper exactly once.'

# Arrange
$processStartTracePath = Join-Path $root 'validated-process-start-trace.txt'
$missingPowerShellPath = Join-Path $root 'missing-pwsh.exe'

# Act
$processStartResult = Invoke-BoundedPwsh -Arguments @('-File', (Join-Path $core 'Get-ValidatedTurnContext.ps1'), '-CompanionRoot', $root, '-PowerShellExecutable', $missingPowerShellPath) -WorkingDirectory $root -Environment @{
    COMPANION_TEST_VALIDATED_ENVELOPE = $envelopePath
    COMPANION_TEST_VALIDATED_TRACE = $processStartTracePath
}

# Assert
Assert-Equal -Actual $processStartResult.ExitCode -Expected 1 -Message 'A child process-start failure fails closed.'
Assert-Equal -Actual $processStartResult.StdOut -Expected '' -Message 'A child process-start failure emits no stdout.'
Assert-True -Condition $processStartResult.StdErr.StartsWith('[turn-context:protocol] ', [System.StringComparison]::Ordinal) -Message 'A child process-start failure emits a typed protocol diagnostic.'
$processStartJson = $processStartResult.StdErr.Substring('[turn-context:protocol] '.Length).TrimEnd("`r", "`n")
$processStartDiagnostic = Read-TurnContextDiagnostic -Json $processStartJson -ExpectedClass protocol -HostGenerated
Assert-OrdinalEqual -Actual $processStartDiagnostic.Materialized['consumptionState'] -Expected 'none' -Message 'A child process-start failure preserves the not-started state.'
Assert-OrdinalEqual -Actual $processStartDiagnostic.Materialized['detail'] -Expected 'attempt-result-invalid' -Message 'A child process-start failure reports the unavailable attempt result.'
Assert-False -Condition ([System.IO.File]::Exists($processStartTracePath)) -Message 'A process-start failure never reaches the inner wrapper.'

# Arrange
$relativeRootTracePath = Join-Path $root 'validated-relative-root-trace.txt'

# Act
$relativeRootResult = Invoke-BoundedPwsh -Arguments @('-File', (Join-Path $core 'Get-ValidatedTurnContext.ps1'), '-CompanionRoot', '.') -WorkingDirectory $root -Environment @{
    COMPANION_TEST_VALIDATED_ENVELOPE = $envelopePath
    COMPANION_TEST_VALIDATED_TRACE = $relativeRootTracePath
}

# Assert
Assert-Equal -Actual $relativeRootResult.ExitCode -Expected 1 -Message 'A relative companion root fails closed.'
Assert-Equal -Actual $relativeRootResult.StdOut -Expected '' -Message 'A relative companion root emits no stdout.'
Assert-True -Condition $relativeRootResult.StdErr.StartsWith('[turn-context:protocol] ', [System.StringComparison]::Ordinal) -Message 'A relative companion root emits a typed protocol diagnostic.'
$relativeRootJson = $relativeRootResult.StdErr.Substring('[turn-context:protocol] '.Length).TrimEnd("`r", "`n")
$relativeRootDiagnostic = Read-TurnContextDiagnostic -Json $relativeRootJson -ExpectedClass protocol -HostGenerated
Assert-OrdinalEqual -Actual $relativeRootDiagnostic.Materialized['consumptionState'] -Expected 'none' -Message 'A relative root preserves the not-started state.'
Assert-OrdinalEqual -Actual $relativeRootDiagnostic.Materialized['detail'] -Expected 'attempt-result-invalid' -Message 'A relative root reports an invalid attempt result.'
Assert-False -Condition ([System.IO.File]::Exists($relativeRootTracePath)) -Message 'A relative root never reaches the inner wrapper.'

# Arrange
$missingRoot = Join-Path $root 'missing-root'
$missingRootTracePath = Join-Path $root 'validated-missing-root-trace.txt'

# Act
$missingRootResult = Invoke-BoundedPwsh -Arguments @('-File', (Join-Path $core 'Get-ValidatedTurnContext.ps1'), '-CompanionRoot', $missingRoot) -WorkingDirectory $root -Environment @{
    COMPANION_TEST_VALIDATED_ENVELOPE = $envelopePath
    COMPANION_TEST_VALIDATED_TRACE = $missingRootTracePath
}

# Assert
Assert-Equal -Actual $missingRootResult.ExitCode -Expected 1 -Message 'A missing companion root fails closed.'
Assert-Equal -Actual $missingRootResult.StdOut -Expected '' -Message 'A missing companion root emits no stdout.'
Assert-True -Condition $missingRootResult.StdErr.StartsWith('[turn-context:protocol] ', [System.StringComparison]::Ordinal) -Message 'A missing companion root emits a typed protocol diagnostic.'
$missingRootJson = $missingRootResult.StdErr.Substring('[turn-context:protocol] '.Length).TrimEnd("`r", "`n")
$missingRootDiagnostic = Read-TurnContextDiagnostic -Json $missingRootJson -ExpectedClass protocol -HostGenerated
Assert-OrdinalEqual -Actual $missingRootDiagnostic.Materialized['consumptionState'] -Expected 'none' -Message 'A missing root preserves the not-started state.'
Assert-OrdinalEqual -Actual $missingRootDiagnostic.Materialized['detail'] -Expected 'attempt-result-invalid' -Message 'A missing root reports an invalid attempt result.'
Assert-False -Condition ([System.IO.File]::Exists($missingRootTracePath)) -Message 'A missing root never reaches the inner wrapper.'

# Arrange
$invalidTimeoutTracePath = Join-Path $root 'validated-invalid-timeout-trace.txt'

# Act
$invalidTimeoutResult = Invoke-BoundedPwsh -Arguments @('-File', (Join-Path $core 'Get-ValidatedTurnContext.ps1'), '-CompanionRoot', $root, '-TimeoutSeconds', [int]::MaxValue) -WorkingDirectory $root -Environment @{
    COMPANION_TEST_VALIDATED_ENVELOPE = $envelopePath
    COMPANION_TEST_VALIDATED_TRACE = $invalidTimeoutTracePath
}

# Assert
Assert-Equal -Actual $invalidTimeoutResult.ExitCode -Expected 1 -Message 'A timer-unsafe timeout fails closed.'
Assert-Equal -Actual $invalidTimeoutResult.StdOut -Expected '' -Message 'A timer-unsafe timeout emits no stdout.'
Assert-True -Condition $invalidTimeoutResult.StdErr.StartsWith('[turn-context:protocol] ', [System.StringComparison]::Ordinal) -Message 'A timer-unsafe timeout emits a typed protocol diagnostic.'
$invalidTimeoutJson = $invalidTimeoutResult.StdErr.Substring('[turn-context:protocol] '.Length).TrimEnd("`r", "`n")
$invalidTimeoutDiagnostic = Read-TurnContextDiagnostic -Json $invalidTimeoutJson -ExpectedClass protocol -HostGenerated
Assert-OrdinalEqual -Actual $invalidTimeoutDiagnostic.Materialized['consumptionState'] -Expected 'none' -Message 'A rejected timeout preserves the not-started state.'
Assert-OrdinalEqual -Actual $invalidTimeoutDiagnostic.Materialized['detail'] -Expected 'attempt-result-invalid' -Message 'A rejected timeout reports an invalid attempt result.'
Assert-False -Condition ([System.IO.File]::Exists($invalidTimeoutTracePath)) -Message 'A rejected timeout never reaches the inner wrapper.'

# Arrange
$unsafeLimitCases = @(
    [pscustomobject]@{ Name = 'stdout'; Arguments = @('-StandardOutputMaximumBytes', '33554433'); TracePath = (Join-Path $root 'validated-unsafe-stdout-limit-trace.txt') },
    [pscustomobject]@{ Name = 'stderr'; Arguments = @('-StandardErrorMaximumBytes', '65537'); TracePath = (Join-Path $root 'validated-unsafe-stderr-limit-trace.txt') }
)

foreach ($unsafeLimitCase in $unsafeLimitCases) {
    # Act
    $unsafeLimitResult = Invoke-BoundedPwsh -Arguments (@('-File', (Join-Path $core 'Get-ValidatedTurnContext.ps1'), '-CompanionRoot', $root) + $unsafeLimitCase.Arguments) -WorkingDirectory $root -Environment @{
        COMPANION_TEST_VALIDATED_ENVELOPE = $envelopePath
        COMPANION_TEST_VALIDATED_TRACE = $unsafeLimitCase.TracePath
    }

    # Assert
    Assert-Equal -Actual $unsafeLimitResult.ExitCode -Expected 1 -Message "An unsafe $($unsafeLimitCase.Name) cap fails closed."
    $unsafeLimitJson = $unsafeLimitResult.StdErr.Substring('[turn-context:protocol] '.Length).TrimEnd("`r", "`n")
    $unsafeLimitDiagnostic = Read-TurnContextDiagnostic -Json $unsafeLimitJson -ExpectedClass protocol -HostGenerated
    Assert-OrdinalEqual -Actual $unsafeLimitDiagnostic.Materialized['consumptionState'] -Expected 'none' -Message "An unsafe $($unsafeLimitCase.Name) cap is rejected before process start."
    Assert-False -Condition ([System.IO.File]::Exists($unsafeLimitCase.TracePath)) -Message "An unsafe $($unsafeLimitCase.Name) cap never reaches the inner wrapper."
}

# Arrange
$timeoutTracePath = Join-Path $root 'validated-timeout-trace.txt'

# Act
$timeoutResult = Invoke-BoundedPwsh -Arguments @('-File', (Join-Path $core 'Get-ValidatedTurnContext.ps1'), '-CompanionRoot', $root, '-TimeoutSeconds', '2') -WorkingDirectory $root -TimeoutMilliseconds 10000 -Environment @{
    COMPANION_TEST_VALIDATED_ENVELOPE = $envelopePath
    COMPANION_TEST_VALIDATED_SCENARIO = 'hang'
    COMPANION_TEST_VALIDATED_TRACE = $timeoutTracePath
}

# Assert
Assert-Equal -Actual $timeoutResult.ExitCode -Expected 1 -Message 'A child deadline fails closed.'
Assert-Equal -Actual $timeoutResult.StdOut -Expected '' -Message 'A child deadline emits no stdout.'
Assert-True -Condition $timeoutResult.StdErr.StartsWith('[turn-context:protocol] ', [System.StringComparison]::Ordinal) -Message 'A child deadline emits a typed protocol diagnostic.'
$timeoutJson = $timeoutResult.StdErr.Substring('[turn-context:protocol] '.Length).TrimEnd("`r", "`n")
$timeoutDiagnostic = Read-TurnContextDiagnostic -Json $timeoutJson -ExpectedClass protocol -HostGenerated
Assert-OrdinalEqual -Actual $timeoutDiagnostic.Materialized['consumptionState'] -Expected 'unknown' -Message 'A deadline after process start preserves unknown consumption.'
Assert-OrdinalEqual -Actual $timeoutDiagnostic.Materialized['detail'] -Expected 'attempt-result-invalid' -Message 'A deadline reports the unavailable attempt result.'
Assert-OrdinalEqual -Actual ([System.IO.File]::ReadAllText($timeoutTracePath).Trim()) -Expected 'invoked' -Message 'The deadline path starts the inner wrapper exactly once.'

# Arrange
$captureSetupFailureTracePath = Join-Path $root 'validated-capture-setup-failure-trace.txt'

# Act
$captureSetupFailureResult = Invoke-BoundedPwsh -Arguments @('-File', (Join-Path $core 'Get-ValidatedTurnContext.ps1'), '-CompanionRoot', $root, '-FailCaptureSetup') -WorkingDirectory $root -TimeoutMilliseconds 10000 -Environment @{
    COMPANION_TEST_VALIDATED_ENVELOPE = $envelopePath
    COMPANION_TEST_VALIDATED_SCENARIO = 'hang'
    COMPANION_TEST_VALIDATED_TRACE = $captureSetupFailureTracePath
}

# Assert
Assert-Equal -Actual $captureSetupFailureResult.ExitCode -Expected 1 -Message 'A capture setup failure after child start fails closed.'
Assert-Equal -Actual $captureSetupFailureResult.StdOut -Expected '' -Message 'A capture setup failure emits no stdout.'
Assert-True -Condition $captureSetupFailureResult.StdErr.StartsWith('[turn-context:protocol] ', [System.StringComparison]::Ordinal) -Message 'A capture setup failure emits a typed protocol diagnostic.'
$captureSetupFailureJson = $captureSetupFailureResult.StdErr.Substring('[turn-context:protocol] '.Length).TrimEnd("`r", "`n")
$captureSetupFailureDiagnostic = Read-TurnContextDiagnostic -Json $captureSetupFailureJson -ExpectedClass protocol -HostGenerated
Assert-OrdinalEqual -Actual $captureSetupFailureDiagnostic.Materialized['consumptionState'] -Expected 'unknown' -Message 'A capture setup failure after process start preserves unknown consumption.'
Assert-OrdinalEqual -Actual $captureSetupFailureDiagnostic.Materialized['detail'] -Expected 'attempt-result-invalid' -Message 'A capture setup failure reports an unavailable attempt result.'

# Arrange
$waitFailureTracePath = Join-Path $root 'validated-wait-failure-trace.txt'

# Act
$waitFailureResult = Invoke-BoundedPwsh -Arguments @('-File', (Join-Path $core 'Get-ValidatedTurnContext.ps1'), '-CompanionRoot', $root, '-FailProcessWait') -WorkingDirectory $root -TimeoutMilliseconds 10000 -Environment @{
    COMPANION_TEST_VALIDATED_ENVELOPE = $envelopePath
    COMPANION_TEST_VALIDATED_TRACE = $waitFailureTracePath
}

# Assert
Assert-Equal -Actual $waitFailureResult.ExitCode -Expected 1 -Message 'A faulted process-wait task after child start fails closed.'
$waitFailureJson = $waitFailureResult.StdErr.Substring('[turn-context:protocol] '.Length).TrimEnd("`r", "`n")
$waitFailureDiagnostic = Read-TurnContextDiagnostic -Json $waitFailureJson -ExpectedClass protocol -HostGenerated
Assert-OrdinalEqual -Actual $waitFailureDiagnostic.Materialized['consumptionState'] -Expected 'unknown' -Message 'A faulted process-wait task after process start preserves unknown consumption.'
Assert-OrdinalEqual -Actual $waitFailureDiagnostic.Materialized['detail'] -Expected 'attempt-result-invalid' -Message 'A faulted process-wait task reports an unavailable attempt result.'

# Arrange
$teardownFailureTracePath = Join-Path $root 'validated-teardown-failure-trace.txt'

# Act
$teardownFailureResult = Invoke-BoundedPwsh -Arguments @('-File', (Join-Path $core 'Get-ValidatedTurnContext.ps1'), '-CompanionRoot', $root, '-TimeoutSeconds', '2', '-TeardownFailureOperation', 'Kill') -WorkingDirectory $root -TimeoutMilliseconds 10000 -Environment @{
    COMPANION_TEST_VALIDATED_ENVELOPE = $envelopePath
    COMPANION_TEST_VALIDATED_SCENARIO = 'hang'
    COMPANION_TEST_VALIDATED_TRACE = $teardownFailureTracePath
}

# Assert
Assert-Equal -Actual $teardownFailureResult.ExitCode -Expected 1 -Message 'A teardown operation failure retains the latched transport failure.'
Assert-Equal -Actual $teardownFailureResult.StdOut -Expected '' -Message 'A teardown operation failure emits no stdout.'
Assert-True -Condition $teardownFailureResult.StdErr.StartsWith('[turn-context:protocol] ', [System.StringComparison]::Ordinal) -Message 'A teardown operation failure emits a typed protocol diagnostic.'
$teardownFailureJson = $teardownFailureResult.StdErr.Substring('[turn-context:protocol] '.Length).TrimEnd("`r", "`n")
$teardownFailureDiagnostic = Read-TurnContextDiagnostic -Json $teardownFailureJson -ExpectedClass protocol -HostGenerated
Assert-OrdinalEqual -Actual $teardownFailureDiagnostic.Materialized['consumptionState'] -Expected 'unknown' -Message 'A teardown failure after process start preserves unknown consumption.'
Assert-OrdinalEqual -Actual $teardownFailureDiagnostic.Materialized['detail'] -Expected 'attempt-result-invalid' -Message 'A teardown failure does not replace the latched failure detail.'
Assert-OrdinalEqual -Actual ([System.IO.File]::ReadAllText($teardownFailureTracePath).Trim()) -Expected 'invoked' -Message 'The teardown-failure path invokes the inner wrapper exactly once.'

# Arrange
$blockingTeardownTracePath = Join-Path $root 'validated-blocking-teardown-trace.txt'
$blockingTeardownStopwatch = [System.Diagnostics.Stopwatch]::StartNew()

# Act
$blockingTeardownResult = Invoke-BoundedPwsh -Arguments @('-File', (Join-Path $core 'Get-ValidatedTurnContext.ps1'), '-CompanionRoot', $root, '-TimeoutSeconds', '2', '-TeardownFailureOperation', 'BlockKill') -WorkingDirectory $root -TimeoutMilliseconds 12000 -Environment @{
    COMPANION_TEST_VALIDATED_ENVELOPE = $envelopePath
    COMPANION_TEST_VALIDATED_SCENARIO = 'hang'
    COMPANION_TEST_VALIDATED_TRACE = $blockingTeardownTracePath
}
$blockingTeardownStopwatch.Stop()

# Assert
Assert-Equal -Actual $blockingTeardownResult.ExitCode -Expected 1 -Message 'A blocking teardown operation retains the latched transport failure.'
Assert-True -Condition ($blockingTeardownStopwatch.ElapsedMilliseconds -lt 9000) -Message 'The complete teardown remains within the deadline plus five-second grace.'
$blockingTeardownJson = $blockingTeardownResult.StdErr.Substring('[turn-context:protocol] '.Length).TrimEnd("`r", "`n")
$blockingTeardownDiagnostic = Read-TurnContextDiagnostic -Json $blockingTeardownJson -ExpectedClass protocol -HostGenerated
Assert-OrdinalEqual -Actual $blockingTeardownDiagnostic.Materialized['consumptionState'] -Expected 'unknown' -Message 'A blocking teardown operation preserves unknown consumption.'

# Arrange
$teardownProbeStartInfo = [System.Diagnostics.ProcessStartInfo]::new()
$teardownProbeStartInfo.FileName = 'pwsh'
$teardownProbeStartInfo.WorkingDirectory = $root
$teardownProbeStartInfo.UseShellExecute = $false
foreach ($argument in @('-NoProfile', '-File', (Join-Path $core 'Get-TurnContext.ps1'), '-PipeHolder')) {
    $teardownProbeStartInfo.ArgumentList.Add($argument)
}
$teardownProbeProcess = [System.Diagnostics.Process]::Start($teardownProbeStartInfo)
$teardownProbeOutput = [System.IO.MemoryStream]::new()
$teardownProbeError = [System.IO.MemoryStream]::new()
$teardownProbeCancellation = [System.Threading.CancellationTokenSource]::new()

# Act
$teardownProbeTask = [CompanionProcessTeardown]::RunAsync($teardownProbeProcess, $teardownProbeOutput, $teardownProbeError, $teardownProbeCancellation, [System.Threading.Tasks.Task[]] @(), 'BlockKill')
[System.Threading.Thread]::Sleep(500)

# Assert
Assert-False -Condition $teardownProbeTask.IsCompleted -Message 'The injected kill operation remains blocked during the cleanup probe.'
Assert-False -Condition $teardownProbeOutput.CanRead -Message 'Stdout closure is attempted independently of a blocked kill.'
Assert-False -Condition $teardownProbeError.CanRead -Message 'Stderr closure is attempted independently of a blocked kill.'
Assert-True -Condition $teardownProbeCancellation.IsCancellationRequested -Message 'Pump cancellation is attempted independently of a blocked kill.'
try {
    if (-not $teardownProbeProcess.HasExited) {
        $teardownProbeProcess.Kill($true)
    }
}
catch {
    # The background teardown owns final cleanup after the probe assertions.
}

# Arrange
$inheritedPipeTracePath = Join-Path $root 'validated-inherited-pipe-trace.txt'

# Act
$inheritedPipeResult = Invoke-BoundedPwsh -Arguments @('-File', (Join-Path $core 'Get-ValidatedTurnContext.ps1'), '-CompanionRoot', $root, '-TimeoutSeconds', '2') -WorkingDirectory $root -TimeoutMilliseconds 10000 -Environment @{
    COMPANION_TEST_VALIDATED_SCENARIO = 'inherited-pipe'
    COMPANION_TEST_VALIDATED_TRACE = $inheritedPipeTracePath
}

# Assert
Assert-Equal -Actual $inheritedPipeResult.ExitCode -Expected 1 -Message 'An inherited pipe that outlives the child fails closed at the deadline.'
Assert-Equal -Actual $inheritedPipeResult.StdOut -Expected '' -Message 'An incomplete pipe drain emits no stdout.'
Assert-True -Condition $inheritedPipeResult.StdErr.StartsWith('[turn-context:protocol] ', [System.StringComparison]::Ordinal) -Message 'An incomplete pipe drain emits a typed protocol diagnostic.'
$inheritedPipeJson = $inheritedPipeResult.StdErr.Substring('[turn-context:protocol] '.Length).TrimEnd("`r", "`n")
$inheritedPipeDiagnostic = Read-TurnContextDiagnostic -Json $inheritedPipeJson -ExpectedClass protocol -HostGenerated
Assert-OrdinalEqual -Actual $inheritedPipeDiagnostic.Materialized['consumptionState'] -Expected 'unknown' -Message 'An incomplete drain after process start preserves unknown consumption.'
Assert-OrdinalEqual -Actual $inheritedPipeDiagnostic.Materialized['detail'] -Expected 'attempt-result-invalid' -Message 'An incomplete drain reports an unavailable attempt result.'
Assert-OrdinalEqual -Actual ([System.IO.File]::ReadAllText($inheritedPipeTracePath).Trim()) -Expected 'invoked' -Message 'The incomplete-drain path invokes the inner wrapper exactly once.'

# Arrange
$rawHelperInheritedPipeTracePath = Join-Path $root 'raw-helper-inherited-pipe-trace.txt'

# Act / Assert
Assert-ThrowsType -TypeName System.TimeoutException -Action {
    Invoke-BoundedPwshBytes -Arguments @('-File', (Join-Path $core 'Get-TurnContext.ps1'), '-CompanionRoot', $root) -WorkingDirectory $root -TimeoutMilliseconds 250 -Environment @{
        COMPANION_TEST_VALIDATED_SCENARIO = 'inherited-pipe'
        COMPANION_TEST_VALIDATED_TRACE = $rawHelperInheritedPipeTracePath
    }
}

Write-Output 'PASS: validated turn context'
