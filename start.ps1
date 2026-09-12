$ErrorActionPreference = "Stop"
Push-Location -LiteralPath $PSScriptRoot
try {
    & node (Join-Path $PSScriptRoot "dist-server/ceres-server.cjs")
    exit $LASTEXITCODE
} finally {
    Pop-Location
}
