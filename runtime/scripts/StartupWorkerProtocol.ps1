#Requires -Version 7.5

function Read-Frame {
    $header = [byte[]]::new(4)
    $count = $inputStream.Read($header, 0, 4)
    if ($count -eq 0) { return $null }
    while ($count -lt 4) {
        $read = $inputStream.Read($header, $count, 4 - $count)
        if ($read -eq 0) { throw [IO.EndOfStreamException]::new('Incomplete frame header.') }
        $count += $read
    }
    $length = ([int]$header[0] -shl 24) -bor ([int]$header[1] -shl 16) -bor ([int]$header[2] -shl 8) -bor [int]$header[3]
    if ($length -lt 1 -or $length -gt $maximumInputFrame) { throw [IO.InvalidDataException]::new('Invalid frame length.') }
    $body = [byte[]]::new($length)
    $count = 0
    while ($count -lt $length) {
        $read = $inputStream.Read($body, $count, $length - $count)
        if ($read -eq 0) { throw [IO.EndOfStreamException]::new('Incomplete frame body.') }
        $count += $read
    }

    return $utf8.GetString($body)
}

function Write-Frame {
    param([Parameter(Mandatory)] [string] $Text)
    $body = $utf8.GetBytes($Text)
    $length = $body.Length
    if ($length -lt 1 -or $length -gt $maximumOutputFrame) { throw [IO.InvalidDataException]::new('Output frame exceeds its bound.') }
    $header = [byte[]]::new(4)
    $header[0] = [byte](($length -shr 24) -band 255)
    $header[1] = [byte](($length -shr 16) -band 255)
    $header[2] = [byte](($length -shr 8) -band 255)
    $header[3] = [byte]($length -band 255)
    $outputStream.Write($header, 0, 4)
    $outputStream.Write($body, 0, $length)
    $outputStream.Flush()
}

function Assert-ExactFields {
    param([Text.Json.JsonElement] $Element, [string[]] $Names)
    if ($Element.ValueKind -ne [Text.Json.JsonValueKind]::Object) { throw [IO.InvalidDataException]::new('Expected an object.') }
    $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($property in $Element.EnumerateObject()) {
        if (-not $seen.Add($property.Name)) { throw [IO.InvalidDataException]::new('Duplicate field.') }
    }
    if ($seen.Count -ne $Names.Length) { throw [IO.InvalidDataException]::new('Incorrect field count.') }
    foreach ($name in $Names) {
        if (-not $seen.Contains($name)) { throw [IO.InvalidDataException]::new('Missing field.') }
    }
}

function Read-String {
    param([Text.Json.JsonElement] $Element)
    if ($Element.ValueKind -ne [Text.Json.JsonValueKind]::String) { throw [IO.InvalidDataException]::new('Expected a string.') }
    $value = $Element.GetString()
    if ($null -eq $value) { throw [IO.InvalidDataException]::new('Expected a non-null string.') }

    return $value
}

function Read-Integer {
    param([Text.Json.JsonElement] $Element)
    $value = 0
    if ($Element.ValueKind -ne [Text.Json.JsonValueKind]::Number -or -not $Element.TryGetInt32([ref] $value)) {
        throw [IO.InvalidDataException]::new('Expected an integral number.')
    }

    return $value
}
