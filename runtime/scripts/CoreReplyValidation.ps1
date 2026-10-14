function Convert-CoreReply {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [ValidateSet('Publish', 'Settlement', 'Consumer', IgnoreCase = $false)] [string] $Operation,
        [Parameter(Mandatory)] [byte[]] $InputBytes
    )

    [Companion.Runtime.JsonDocuments]::Validate($InputBytes, 'config')
    $utf8 = [Text.UTF8Encoding]::new($false, $true)
    $control = Read-CompanionJson -Json $utf8.GetString($InputBytes) -Budget config
    $root = $control.RootElement
    $names = @($root.EnumerateObject() | ForEach-Object Name)
    if ($names.Count -ne 3 -or @($names | Where-Object { $_ -cnotin @('exitCode', 'stdout', 'stderr') }).Count -ne 0) { throw [FormatException]::new('Reply control is malformed.') }
    $exitElement = $root.GetProperty('exitCode')
    $exitCode = 0
    if ($exitElement.ValueKind -ne [Text.Json.JsonValueKind]::Number -or -not $exitElement.TryGetInt32([ref] $exitCode) -or $exitCode -cnotin @(0, 1)) { throw [FormatException]::new('Reply exit code is invalid.') }
    foreach ($field in @('stdout', 'stderr')) { if ($root.GetProperty($field).ValueKind -ne [Text.Json.JsonValueKind]::String) { throw [FormatException]::new('Reply stream is invalid.') } }
    $stdout = $root.GetProperty('stdout').GetString()
    $stderr = $root.GetProperty('stderr').GetString()
    if ($utf8.GetByteCount($stdout) -gt 65536 -or $utf8.GetByteCount($stderr) -gt 65536) { throw [FormatException]::new('Reply stream exceeds its capture budget.') }
    $class = $null
    $reason = $null
    $targetHash = $null
    if ($exitCode -eq 0) {
        if ($stderr.Length -ne 0) { throw [FormatException]::new('Successful reply has stderr.') }
        $document = switch ($Operation) {
            Publish { Read-StateEventReceipt -Json $stdout }
            Settlement { Read-StateEventSettlementResult -Json $stdout }
            Consumer { Read-CompanionConsumerResult -Json $stdout }
        }
        if ($Operation -ceq 'Publish' -and $document.RootElement.GetProperty('target').ValueKind -ne [Text.Json.JsonValueKind]::Null) {
            $targetHash = [Companion.Runtime.RuntimeCodec]::TargetHash($document.RootElement.GetProperty('target'))
        }
    }
    else {
        $prefix = '[state-event:'
        if ($stdout.Length -ne 0 -or -not $stderr.EndsWith([string][char]10, [StringComparison]::Ordinal)) { throw [FormatException]::new('Failure reply framing is invalid.') }
        $line = $stderr.Substring(0, $stderr.Length - 1)
        if ($line.IndexOfAny([char[]]@([char]10, [char]13)) -ge 0 -or -not $line.StartsWith($prefix, [StringComparison]::Ordinal)) { throw [FormatException]::new('Failure reply framing is invalid.') }
        $delimiter = $line.IndexOf('] ', [StringComparison]::Ordinal)
        if ($delimiter -lt $prefix.Length) { throw [FormatException]::new('Failure reply class is absent.') }
        $class = $line.Substring($prefix.Length, $delimiter - $prefix.Length)
        $document = Read-StateEventDiagnostic -Script $Operation -ExpectedClass $class -Json $line.Substring($delimiter + 2)
        $detail = $document.RootElement.GetProperty('detail').GetString()
        $reason = $detail.Split(' ')[0]
    }
    $result = [ordered]@{ coreReplyVersion = 1; success = $exitCode -eq 0; class = $class; reason = $reason; targetIdentitySha256 = $targetHash; data = $document.Materialized }

    return ConvertTo-CompanionJson -InputObject $result -Budget config
}
