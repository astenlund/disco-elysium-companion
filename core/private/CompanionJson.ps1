$script:CompanionJsonUtf8 = [System.Text.UTF8Encoding]::new($false, $true)
$script:CompanionJsonMaxDepth = 64
$script:CompanionJsonProfiles = @{
    config = [pscustomobject]@{ MaxBytes = 1048576; MaxTokens = 65536; MaxTextBytes = 524288 }
    dump = [pscustomobject]@{ MaxBytes = 16777216; MaxTokens = 2000000; MaxTextBytes = 8388608 }
    digest = [pscustomobject]@{ MaxBytes = 8388608; MaxTokens = 500000; MaxTextBytes = 4194304 }
    diff = [pscustomobject]@{ MaxBytes = 16777216; MaxTokens = 1000000; MaxTextBytes = 8388608 }
    'walk-result' = [pscustomobject]@{ MaxBytes = 16777216; MaxTokens = 1000000; MaxTextBytes = 8388608 }
    'turn-context' = [pscustomobject]@{ MaxBytes = 33554432; MaxTokens = 2000000; MaxTextBytes = 16777216 }
}

if ($null -eq ('CompanionJsonScanner' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Text;
using System.Text.Json;

public sealed class CompanionJsonScanFailure : Exception
{
    public CompanionJsonScanFailure() : base("Invalid Companion JSON.") { }
}

public static class CompanionJsonScanner
{
    private static readonly UTF8Encoding Utf8 = new UTF8Encoding(false, true);

    public static long[] Validate(byte[] bytes, long maxTokens, long maxTextBytes, int maxDepth)
    {
        try
        {
            Utf8.GetCharCount(bytes);
            var reader = new Utf8JsonReader(bytes, new JsonReaderOptions { MaxDepth = maxDepth, CommentHandling = JsonCommentHandling.Disallow, AllowTrailingCommas = false });
            var properties = new Stack<HashSet<string>>();
            long tokens = 0;
            long textBytes = 0;
            while (reader.Read())
            {
                if (++tokens > maxTokens) throw new CompanionJsonScanFailure();
                if (reader.TokenType == JsonTokenType.StartObject)
                {
                    if (reader.CurrentDepth + 1 > maxDepth) throw new CompanionJsonScanFailure();
                    properties.Push(new HashSet<string>(StringComparer.Ordinal));
                }
                else if (reader.TokenType == JsonTokenType.EndObject)
                {
                    properties.Pop();
                }
                else if (reader.TokenType == JsonTokenType.StartArray && reader.CurrentDepth + 1 > maxDepth)
                {
                    throw new CompanionJsonScanFailure();
                }
                if (reader.TokenType == JsonTokenType.PropertyName || reader.TokenType == JsonTokenType.String)
                {
                    string value = reader.GetString();
                    int length = Utf8.GetByteCount(value);
                    checked { textBytes += length; }
                    if (textBytes > maxTextBytes) throw new CompanionJsonScanFailure();
                    if (reader.TokenType == JsonTokenType.PropertyName && !properties.Peek().Add(value)) throw new CompanionJsonScanFailure();
                }
            }
            return new[] { tokens, textBytes };
        }
        catch (CompanionJsonScanFailure) { throw; }
        catch (Exception) { throw new CompanionJsonScanFailure(); }
    }
}

public sealed class CompanionJsonByteCapStream : System.IO.Stream
{
    private readonly System.IO.MemoryStream inner = new System.IO.MemoryStream();
    private readonly long maximumBytes;

    public CompanionJsonByteCapStream(long maximumBytes) { this.maximumBytes = maximumBytes; }
    public byte[] ToArray() { return inner.ToArray(); }
    public override bool CanRead { get { return false; } }
    public override bool CanSeek { get { return false; } }
    public override bool CanWrite { get { return true; } }
    public override long Length { get { return inner.Length; } }
    public override long Position { get { return inner.Position; } set { throw new NotSupportedException(); } }
    public override void Flush() { inner.Flush(); }
    public override System.Threading.Tasks.Task FlushAsync(System.Threading.CancellationToken cancellationToken) { return inner.FlushAsync(cancellationToken); }
    public override int Read(byte[] buffer, int offset, int count) { throw new NotSupportedException(); }
    public override long Seek(long offset, System.IO.SeekOrigin origin) { throw new NotSupportedException(); }
    public override void SetLength(long value) { throw new NotSupportedException(); }
    public override void Write(byte[] buffer, int offset, int count)
    {
        if (count > maximumBytes - inner.Length) throw new CompanionJsonScanFailure();
        inner.Write(buffer, offset, count);
    }
    public override void WriteByte(byte value)
    {
        if (inner.Length >= maximumBytes) throw new CompanionJsonScanFailure();
        inner.WriteByte(value);
    }
}
'@ -ErrorAction Stop
}

function Get-CompanionJsonBudget {
    param([Parameter(Mandatory)] $Budget)

    if ($Budget -is [string]) {
        if (-not $script:CompanionJsonProfiles.ContainsKey($Budget)) {
            throw [CompanionJsonParseException]::new('Unknown Companion JSON budget profile.')
        }

        return $script:CompanionJsonProfiles[$Budget]
    }

    foreach ($name in 'MaxBytes', 'MaxTokens', 'MaxTextBytes') {
        if ($null -eq $Budget.PSObject.Properties[$name] -or $Budget.$name -isnot [ValueType] -or [int64] $Budget.$name -lt 0) {
            throw [CompanionJsonParseException]::new('Invalid Companion JSON budget profile.')
        }
    }

    return [pscustomobject]@{ MaxBytes = [int64] $Budget.MaxBytes; MaxTokens = [int64] $Budget.MaxTokens; MaxTextBytes = [int64] $Budget.MaxTextBytes }
}

function Test-CompanionJsonBytes {
    param([Parameter(Mandatory)] [byte[]] $Bytes, [Parameter(Mandatory)] $Budget)

    if ($Bytes.LongLength -gt $Budget.MaxBytes) {
        throw [CompanionJsonParseException]::new('Companion JSON exceeds its byte budget.')
    }
    try {
        [void] [CompanionJsonScanner]::Validate($Bytes, $Budget.MaxTokens, $Budget.MaxTextBytes, $script:CompanionJsonMaxDepth)
    }
    catch {
        throw [CompanionJsonParseException]::new('Companion JSON parsing failed.', $_.Exception)
    }
}

function Read-CompanionJson {
    [CmdletBinding(DefaultParameterSetName = 'Path')]
    param(
        [Parameter(Mandatory, Position = 0, ParameterSetName = 'Path')] [string] $Path,
        [Parameter(Mandatory, ParameterSetName = 'Json')] [string] $Json,
        [Parameter(Mandatory)] $Budget
    )

    $resolvedBudget = Get-CompanionJsonBudget -Budget $Budget
    if ($PSCmdlet.ParameterSetName -eq 'Path') {
        $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
        try {
            $maximumRead = [Math]::Min([int64]::MaxValue, $resolvedBudget.MaxBytes + 1)
            $buffer = [IO.MemoryStream]::new()
            $chunk = [byte[]]::new(81920)
            while (($read = $stream.Read($chunk, 0, $chunk.Length)) -gt 0) {
                $remaining = $maximumRead - $buffer.Length
                if ($remaining -le 0) { break }
                $buffer.Write($chunk, 0, [Math]::Min($read, [int] $remaining))
            }
            $bytes = $buffer.ToArray()
        }
        finally {
            $stream.Dispose()
        }
    }
    else {
        try {
            if ($script:CompanionJsonUtf8.GetByteCount($Json) -gt $resolvedBudget.MaxBytes) {
                throw [CompanionJsonParseException]::new('Companion JSON exceeds its byte budget.')
            }
            $bytes = $script:CompanionJsonUtf8.GetBytes($Json)
        }
        catch [CompanionJsonParseException] {
            throw
        }
        catch {
            throw [CompanionJsonParseException]::new('Companion JSON is not strict UTF-8.', $_.Exception)
        }
    }

    Test-CompanionJsonBytes -Bytes $bytes -Budget $resolvedBudget
    try {
        $options = [Text.Json.JsonDocumentOptions]::new(); $options.MaxDepth = $script:CompanionJsonMaxDepth; $options.CommentHandling = [Text.Json.JsonCommentHandling]::Disallow
        $document = [Text.Json.JsonDocument]::Parse([System.ReadOnlyMemory[byte]]::new($bytes), $options)
        try {
            $value = [CompanionJsonValue]::new()
            $value.RootElement = $document.RootElement.Clone()
            $value.Materialized = $script:CompanionJsonUtf8.GetString($bytes) | ConvertFrom-Json -AsHashtable -DateKind String -Depth $script:CompanionJsonMaxDepth -ErrorAction Stop

            return $value
        }
        finally {
            $document.Dispose()
        }
    }
    catch {
        if ($_.Exception -is [CompanionJsonParseException]) { throw }
        throw [CompanionJsonParseException]::new('Companion JSON materialization failed.', $_.Exception)
    }
}

# The one authoritative JSON-serializable number-type set; the writer and the measurer
# both dispatch through Test-CompanionJsonNumber so they cannot drift apart.
$script:CompanionJsonNumberTypes = @([byte], [sbyte], [int16], [uint16], [int], [uint32], [long], [uint64], [single], [double], [decimal])
function Test-CompanionJsonNumber {
    param([Parameter(Mandatory)] $Value)

    foreach ($type in $script:CompanionJsonNumberTypes) { if ($Value -is $type) { return $true } }

    return $false
}

function Write-CompanionJsonValue {
    param([Parameter(Mandatory)] [Text.Json.Utf8JsonWriter] $Writer, [AllowNull()] $Value)

    if ($null -eq $Value) { $Writer.WriteNullValue(); return }
    if ($Value -is [Text.Json.JsonElement]) { $Value.WriteTo($Writer); return }
    if ($Value -is [string]) { $Writer.WriteStringValue($Value); return }
    if ($Value -is [bool]) { $Writer.WriteBooleanValue($Value); return }
    if (Test-CompanionJsonNumber -Value $Value) { $Writer.WriteNumberValue($Value); return }
    if ($Value -is [Collections.IDictionary]) {
        $Writer.WriteStartObject()
        foreach ($entry in $Value.GetEnumerator()) { $Writer.WritePropertyName([string] $entry.Key); Write-CompanionJsonValue -Writer $Writer -Value $entry.Value }
        $Writer.WriteEndObject()
        return
    }
    if ($Value -is [Collections.IEnumerable]) {
        $Writer.WriteStartArray()
        foreach ($item in $Value) { Write-CompanionJsonValue -Writer $Writer -Value $item }
        $Writer.WriteEndArray()
        return
    }
    throw [CompanionJsonParseException]::new('Unsupported Companion JSON value.')
}

function Add-CompanionJsonCharge {
    param([Parameter(Mandatory)] $Charge, [Parameter(Mandatory)] [long] $Tokens, [Parameter(Mandatory)] [long] $TextBytes)

    $Charge.Tokens += $Tokens
    $Charge.TextBytes += $TextBytes
    if ($Charge.Tokens -gt $Charge.Budget.MaxTokens -or $Charge.TextBytes -gt $Charge.Budget.MaxTextBytes) {
        throw [CompanionJsonParseException]::new('Companion JSON exceeds its token or decoded-text budget.')
    }
}

# The one accounting vocabulary shared by both measurers: a container opens and closes
# for two tokens, text (a property name or string value) is one token plus its UTF-8
# byte count, and any other scalar is one token.
function Add-CompanionJsonContainerCharge { param([Parameter(Mandatory)] $Charge) Add-CompanionJsonCharge -Charge $Charge -Tokens 2 -TextBytes 0 }
function Add-CompanionJsonTextCharge { param([Parameter(Mandatory)] $Charge, [Parameter(Mandatory)] [AllowEmptyString()] [string] $Text) Add-CompanionJsonCharge -Charge $Charge -Tokens 1 -TextBytes $script:CompanionJsonUtf8.GetByteCount($Text) }
function Add-CompanionJsonScalarCharge { param([Parameter(Mandatory)] $Charge) Add-CompanionJsonCharge -Charge $Charge -Tokens 1 -TextBytes 0 }

function Measure-CompanionJsonElement {
    param([Parameter(Mandatory)] [Text.Json.JsonElement] $Element, [Parameter(Mandatory)] $Charge)

    switch ($Element.ValueKind) {
        Object {
            Add-CompanionJsonContainerCharge -Charge $Charge
            foreach ($property in $Element.EnumerateObject()) {
                Add-CompanionJsonTextCharge -Charge $Charge -Text $property.Name
                Measure-CompanionJsonElement -Element $property.Value -Charge $Charge
            }
            return
        }
        Array {
            Add-CompanionJsonContainerCharge -Charge $Charge
            foreach ($item in $Element.EnumerateArray()) { Measure-CompanionJsonElement -Element $item -Charge $Charge }
            return
        }
        String { Add-CompanionJsonTextCharge -Charge $Charge -Text $Element.GetString(); return }
        default { Add-CompanionJsonScalarCharge -Charge $Charge; return }
    }
}

function Measure-CompanionJsonValue {
    param([AllowNull()] $Value, [Parameter(Mandatory)] $Charge)

    if ($null -eq $Value) { Add-CompanionJsonScalarCharge -Charge $Charge; return }
    if ($Value -is [Text.Json.JsonElement]) { Measure-CompanionJsonElement -Element $Value -Charge $Charge; return }
    if ($Value -is [string]) { Add-CompanionJsonTextCharge -Charge $Charge -Text $Value; return }
    if ($Value -is [bool] -or (Test-CompanionJsonNumber -Value $Value)) { Add-CompanionJsonScalarCharge -Charge $Charge; return }
    if ($Value -is [Collections.IDictionary]) {
        Add-CompanionJsonContainerCharge -Charge $Charge
        foreach ($entry in $Value.GetEnumerator()) {
            Add-CompanionJsonTextCharge -Charge $Charge -Text ([string] $entry.Key)
            Measure-CompanionJsonValue -Value $entry.Value -Charge $Charge
        }
        return
    }
    if ($Value -is [Collections.IEnumerable]) {
        Add-CompanionJsonContainerCharge -Charge $Charge
        foreach ($item in $Value) { Measure-CompanionJsonValue -Value $item -Charge $Charge }
        return
    }
    throw [CompanionJsonParseException]::new('Unsupported Companion JSON value.')
}

function ConvertTo-CompanionJson {
    param([Parameter(Mandatory)] $InputObject, [Parameter(Mandatory)] $Budget)

    $resolvedBudget = Get-CompanionJsonBudget -Budget $Budget
    $charge = [pscustomobject]@{ Budget = $resolvedBudget; Tokens = [long] 0; TextBytes = [long] 0 }
    Measure-CompanionJsonValue -Value $InputObject -Charge $charge
    $stream = [CompanionJsonByteCapStream]::new($resolvedBudget.MaxBytes)
    try {
        $writer = [Text.Json.Utf8JsonWriter]::new($stream, [Text.Json.JsonWriterOptions]@{ Indented = $false; MaxDepth = $script:CompanionJsonMaxDepth })
        try {
            Write-CompanionJsonValue -Writer $writer -Value $InputObject
            $writer.Flush()
        }
        finally {
            $writer.Dispose()
        }
        $bytes = $stream.ToArray()
    }
    catch {
        if ($_.Exception -is [CompanionJsonParseException]) { throw }
        throw [CompanionJsonParseException]::new('Companion JSON serialization failed.', $_.Exception)
    }
    finally {
        $stream.Dispose()
    }
    try {
        return $script:CompanionJsonUtf8.GetString($bytes)
    }
    catch {
        throw [CompanionJsonParseException]::new('Companion JSON serialization failed.', $_.Exception)
    }
}
