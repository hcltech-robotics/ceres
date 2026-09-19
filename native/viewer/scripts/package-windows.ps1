[CmdletBinding()]
param(
    [string]$BuildDirectory = "build-native",
    [string]$OutputDirectory = "dist",
    [string]$PackageName,
    [ValidateSet("windows-x64")][string]$Platform = "windows-x64",
    [Parameter(Mandatory = $true)][string]$FfmpegRoot,
    [string]$FfmpegLicences,
    [string]$CudaRoot,
    [string]$MsvcRedistDirectory,
    [string]$MsvcLicences,
    [ValidateSet("Release", "RelWithDebInfo")][string]$Configuration = "Release",
    [switch]$NoArchive,
    [switch]$SkipViewerStartupCheck
)
$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
$viewerRoot = Split-Path -Parent $PSScriptRoot
$releaseVersion = (Get-Content -LiteralPath (Join-Path $viewerRoot '../../package.json') -Raw | ConvertFrom-Json).version
if (!$PackageName) { $PackageName = "ceres-viewer-$releaseVersion-$Platform" }
function Resolve-ViewerPath([string]$Value) {
    if ([IO.Path]::IsPathRooted($Value)) { return [IO.Path]::GetFullPath($Value) }
    return [IO.Path]::GetFullPath((Join-Path $viewerRoot $Value))
}
function Get-Sha256([string]$Path) {
    $digest = [Security.Cryptography.SHA256]::Create()
    $stream = [IO.File]::OpenRead($Path)
    try { return [BitConverter]::ToString($digest.ComputeHash($stream)).Replace("-", "").ToLowerInvariant() }
    finally { $stream.Dispose(); $digest.Dispose() }
}
$buildPath = Resolve-ViewerPath $BuildDirectory
$outputPath = Resolve-ViewerPath $OutputDirectory
if ($PackageName -notmatch '^[a-zA-Z0-9][a-zA-Z0-9._-]+$') { throw "PackageName must be a directory name" }
$packagePath = Join-Path $outputPath $PackageName
$archivePath = Join-Path $outputPath ($PackageName + ".zip")
if (Test-Path -LiteralPath $packagePath) { throw "Package directory already exists: $packagePath" }
if (!$NoArchive -and (Test-Path -LiteralPath $archivePath)) { throw "Archive already exists: $archivePath" }
$cacheText = Get-Content -LiteralPath (Join-Path $buildPath 'CMakeCache.txt') -Raw
$compilerMatch = [regex]::Match($cacheText, '(?m)^CMAKE_CXX_COMPILER:[^=]*=(.+)$')
$compilerPath = $compilerMatch.Groups[1].Value.Trim()
if (!$compilerPath -or ![IO.Path]::IsPathRooted($compilerPath)) {
    $compilerConfigs = @(Get-ChildItem -Path (Join-Path $buildPath 'CMakeFiles/*/CMakeCXXCompiler.cmake') -File | Sort-Object LastWriteTimeUtc -Descending)
    if (!$compilerConfigs.Count) { throw 'The build has no resolved C++ compiler configuration' }
    $compilerConfig = Get-Content -LiteralPath $compilerConfigs[0].FullName -Raw
    $compilerPath = [regex]::Match($compilerConfig, 'set\(CMAKE_CXX_COMPILER "([^"]+)"\)').Groups[1].Value
}
$toolchainMatch = [regex]::Match($compilerPath, '(?i)^(.*)[\\/]VC[\\/]Tools[\\/]MSVC[\\/]([^\\/]+)[\\/]')
if (!$toolchainMatch.Success) { throw 'The build compiler does not identify its Visual Studio installation' }
$visualStudio = $toolchainMatch.Groups[1].Value
$toolsVersion = $toolchainMatch.Groups[2].Value
$redistVersion = (Get-Content -LiteralPath (Join-Path $visualStudio "VC\Auxiliary\Build\Microsoft.VCRedistVersion.default.txt") -Raw).Trim()
$dumpbin = Join-Path (Split-Path -Parent $compilerPath) 'dumpbin.exe'
if (!(Test-Path -LiteralPath $dumpbin)) { throw 'The build compiler has no adjacent dumpbin executable' }
if (!$MsvcRedistDirectory) {
    $runtimeFolders = @(Get-ChildItem -LiteralPath (Join-Path $visualStudio "VC\Redist\MSVC\$redistVersion\x64") -Directory -Filter 'Microsoft.VC*.CRT')
    if ($runtimeFolders.Count -ne 1) { throw "Could not identify one x64 Microsoft CRT directory" }
    $MsvcRedistDirectory = $runtimeFolders[0].FullName
}
if (!$MsvcLicences) {
    $MsvcLicences = Join-Path $buildPath "_package\microsoft-runtime-licences-$redistVersion"
    New-Item -ItemType Directory -Path $MsvcLicences -Force | Out-Null
    $licenceFiles = Get-ChildItem -LiteralPath (Join-Path $visualStudio "Licenses") -File -Recurse -ErrorAction SilentlyContinue
    foreach ($licenceFile in $licenceFiles) {
        Copy-Item -LiteralPath $licenceFile.FullName -Destination (Join-Path $MsvcLicences ($licenceFile.Directory.Name + "-" + $licenceFile.Name))
    }
    $redistList = Join-Path $visualStudio "VC\Redist\MSVC\$redistVersion\Redist.txt"
    if (Test-Path -LiteralPath $redistList) { Copy-Item -LiteralPath $redistList -Destination $MsvcLicences }
    $runtimeInstaller = Join-Path $visualStudio "VC\Redist\MSVC\$redistVersion\vc_redist.x64.exe"
    if (Test-Path -LiteralPath $runtimeInstaller) { Copy-Item -LiteralPath $runtimeInstaller -Destination $MsvcLicences }
    [IO.File]::WriteAllText((Join-Path $MsvcLicences "runtime-origin.txt"),
        "Microsoft Visual C++ runtime $redistVersion`nCompiler toolset $toolsVersion`nThe unmodified publisher redistributable includes its licence terms.`nhttps://visualstudio.microsoft.com/license-terms/`n", [Text.UTF8Encoding]::new($false))
}
New-Item -ItemType Directory -Path $outputPath -Force | Out-Null
$arguments = @(
    "-DVIEWER_BUILD_DIR=$buildPath", "-DPACKAGE_DIR=$packagePath", "-DBUILD_CONFIG=$Configuration",
    "-DFFMPEG_ROOT=$(Resolve-ViewerPath $FfmpegRoot)", "-DMSVC_REDIST_DIR=$MsvcRedistDirectory",
    "-DMSVC_LICENCES=$MsvcLicences", "-DDUMPBIN_EXECUTABLE=$dumpbin", "-DPACKAGE_PLATFORM=$Platform"
)
if ($FfmpegLicences) { $arguments += "-DFFMPEG_LICENCES=$(Resolve-ViewerPath $FfmpegLicences)" }
if ($CudaRoot) { $arguments += "-DCUDA_ROOT=$(Resolve-ViewerPath $CudaRoot)" }
$arguments += @("-P", (Join-Path $PSScriptRoot "package.cmake"))
& cmake @arguments
if ($LASTEXITCODE -ne 0) { throw "Package assembly failed" }
if (!$SkipViewerStartupCheck) {
    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = Join-Path $packagePath "ceres-viewer.exe"
    $startInfo.Arguments = "--help"
    $startInfo.WorkingDirectory = $packagePath
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $startInfo.EnvironmentVariables["PATH"] = "$env:SystemRoot\System32;$env:SystemRoot"
    $startInfo.EnvironmentVariables.Remove("CUDA_PATH")
    $startInfo.EnvironmentVariables.Remove("CUDA_PATH_V12_4")
    $checkProcess = [Diagnostics.Process]::Start($startInfo)
    try {
        if (!$checkProcess.WaitForExit(10000)) {
            $checkProcess.Kill()
            throw "Packaged viewer did not finish its runtime check"
        }
        $checkOutput = $checkProcess.StandardOutput.ReadToEnd()
        $checkError = $checkProcess.StandardError.ReadToEnd()
        if ($checkProcess.ExitCode -ne 0 -or $checkOutput -notmatch 'Ceres viewer') {
            throw "Packaged viewer could not start with the Windows system path: $checkError"
        }
    } finally { $checkProcess.Dispose() }
}
if (!$NoArchive) {
    Add-Type -AssemblyName System.IO.Compression
    $archiveEpoch = if ($env:SOURCE_DATE_EPOCH) { [int64]$env:SOURCE_DATE_EPOCH } else { 946684800L }
    $entryTime = [DateTimeOffset]::FromUnixTimeSeconds($archiveEpoch)
    if ($entryTime.Year -lt 1980 -or $entryTime.Year -gt 2107) { throw "SOURCE_DATE_EPOCH is outside the ZIP timestamp range" }
    $archiveFiles = [string[]]@(Get-ChildItem -LiteralPath $packagePath -Recurse -File | ForEach-Object {
        $_.FullName.Substring($packagePath.Length + 1).Replace('\', '/')
    })
    [Array]::Sort($archiveFiles, [StringComparer]::Ordinal)
    $archiveStream = [IO.File]::Open($archivePath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write)
    $zipArchive = [IO.Compression.ZipArchive]::new($archiveStream, [IO.Compression.ZipArchiveMode]::Create, $false)
    try {
        foreach ($relativeFile in $archiveFiles) {
            $entry = $zipArchive.CreateEntry("$PackageName/$relativeFile", [IO.Compression.CompressionLevel]::Optimal)
            $entry.LastWriteTime = $entryTime
            $entry.ExternalAttributes = 0
            $inputStream = [IO.File]::OpenRead((Join-Path $packagePath $relativeFile))
            $entryStream = $entry.Open()
            try { $inputStream.CopyTo($entryStream) } finally { $entryStream.Dispose(); $inputStream.Dispose() }
        }
    } finally { $zipArchive.Dispose(); $archiveStream.Dispose() }
    $hash = Get-Sha256 $archivePath
    [IO.File]::WriteAllText($archivePath + ".sha256", "$hash  $([IO.Path]::GetFileName($archivePath))`n", [Text.UTF8Encoding]::new($false))
    Copy-Item -LiteralPath (Join-Path $packagePath 'MANIFEST.json') -Destination ($archivePath + '.manifest.json')
    Copy-Item -LiteralPath (Join-Path $packagePath 'SBOM.spdx.json') -Destination ($archivePath + '.spdx.json')
    Write-Output "Archive ready: $archivePath"
}
