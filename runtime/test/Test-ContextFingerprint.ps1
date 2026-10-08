#Requires -Version 7.5
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
Import-Module (Join-Path $repoRoot 'core/tests/TestSupport.psm1') -Force
Add-Type -Path @((Join-Path $repoRoot 'runtime/scripts/JsonDocuments.cs'), (Join-Path $repoRoot 'runtime/scripts/ContextFingerprint.cs'))
$utf8 = [Text.UTF8Encoding]::new($false, $true)
$instructions = 'a' * 64
$provider = 'b' * 64
function Fingerprint {
    param([string] $Json, [string] $InstructionsHash = $instructions, [string] $ProviderHash = $provider)

    return [Companion.Runtime.ContextFingerprint]::Compute($utf8.GetBytes($Json), $InstructionsHash, $ProviderHash)
}

$first = '{"interactionId":"one","requestReceivedAt":"old","freshness":{"state":"fresh","class":null,"reason":null,"lastGoodGeneratedAt":"old"},"operational":{"state":"current","warnings":[]},"correction":null,"degraded":null,"events":[{"eventId":"one","sequence":1,"redelivery":false,"type":"state.consumed","baselineReset":false,"warnings":[],"diff":{"currentSource":{"save":"old"},"currentGeneratedAt":"old","baselineGeneratedAt":"old","value":1}}],"state":{"generatedAt":"old","source":{"save":"old"},"extra":{"value":9007199254740993,"source":"meaningful"}}}'
$churn = $first.Replace('"old"', '"new"').Replace('"one"', '"two"').Replace('"sequence":1', '"sequence":2').Replace('"redelivery":false', '"redelivery":true')
Assert-OrdinalEqual -Actual (Fingerprint $first) -Expected (Fingerprint $churn) -Message 'interaction, source, timestamps and redelivery churn do not refund window recovery'
foreach ($changed in @(
    $first.Replace('9007199254740993', '9007199254740992'),
    $first.Replace('"meaningful"', '"different"'),
    $first.Replace('"baselineReset":false', '"baselineReset":true'),
    $first.Replace('"state":"fresh"', '"state":"failed"'),
    $first.Replace('"correction":null', '"correction":{"correctionId":"x","reason":"contextUncertain"}')
)) {
    Assert-False -Condition ((Fingerprint $first) -ceq (Fingerprint $changed)) -Message 'substantive context changes remain distinct'
}
Assert-False -Condition ((Fingerprint $first) -ceq (Fingerprint $first -InstructionsHash ('c' * 64))) -Message 'instructions participate in candidate comparison'
Assert-False -Condition ((Fingerprint $first) -ceq (Fingerprint $first -ProviderHash ('c' * 64))) -Message 'effective provider options participate in candidate comparison'
$escape = [string][char]92
Assert-OrdinalEqual -Actual (Fingerprint ('{"state":{"extra":{"s":"' + $escape + 'u0061","n":[1.0,100e-2,-0]}}}')) -Expected (Fingerprint '{"state":{"extra":{"n":[1,1,0],"s":"a"}}}') -Message 'property order, escaped spelling and equivalent exact decimal values compare semantically'
Assert-OrdinalEqual -Actual (Fingerprint '{"state":{"extra":{"n":1e400}}}') -Expected (Fingerprint '{"state":{"extra":{"n":10e399}}}') -Message 'large exponents never pass through floating point'
$exponent = '9' * 10000
$lowerExponent = ('9' * 9999) + '8'
Assert-OrdinalEqual -Actual (Fingerprint ('{"state":{"extra":{"n":1e' + $exponent + '}}}')) -Expected (Fingerprint ('{"state":{"extra":{"n":10e' + $lowerExponent + '}}}')) -Message 'arbitrarily spelled exponent magnitude stays linear and unexpanded'
Assert-ThrowsType 'DocumentInvalidException' { Fingerprint '{"state":null,"state":{}}' }
Write-Output 'PASS: lossless semantic context fingerprints'
