#Requires -Version 7.5
param(
    [Parameter(Mandatory)][string] $BootstrapBase64,
    [Parameter(Mandatory)][string] $NativeBase64,
    [Parameter(Mandatory)][string] $PinBase64,
    [Parameter(Mandatory)][string] $RequestBase64,
    [Parameter(Mandatory)][string] $RootBase64,
    [Parameter(Mandatory)][string] $GameBase64
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Decode-PackageText {
    param([Parameter(Mandatory)][string] $Value)
    $text = [Text.UTF8Encoding]::new($false, $true).GetString([Convert]::FromBase64String($Value))
    if ($text.Length -eq 0 -or $text[0] -eq [char]0xfeff) {
        throw [IO.InvalidDataException]::new('Bootstrap package text is empty or has a byte-order mark.')
    }
    return $text
}

$bootstrap = Decode-PackageText $BootstrapBase64
$native = Decode-PackageText $NativeBase64
$pin = Decode-PackageText $PinBase64
$request = Decode-PackageText $RequestBase64
$root = Decode-PackageText $RootBase64
$game = Decode-PackageText $GameBase64
& ([ScriptBlock]::Create($bootstrap)) -Root $root -Game $game -NativeSource $native -PinSource $pin -PinRequestJson $request
