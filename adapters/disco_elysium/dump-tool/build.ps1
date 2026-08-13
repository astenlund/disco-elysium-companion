# Builds dedump.exe. Setup action, never invoked by the pipeline (spec 5.3).
$ErrorActionPreference = 'Stop'
Push-Location $PSScriptRoot
try {
    go build -o dedump.exe .
    if ($LASTEXITCODE -ne 0) { throw "go build failed with exit code $LASTEXITCODE" }
    Write-Host "built $PSScriptRoot\dedump.exe"
} finally {
    Pop-Location
}
