param([switch]$CheckOnly, [switch]$Restore, [ValidateSet('Debug','Release')][string]$Configuration = 'Debug', [string]$SigningThumbprint)
$ErrorActionPreference = 'Stop'
$taskRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$output = Join-Path $taskRoot 'release\console-receiver\windows'
$checks = [ordered]@{ windows = [Environment]::OSVersion.Platform -eq 'Win32NT'; webBundle = Test-Path (Join-Path $taskRoot 'release\console-receiver\web\index.html'); assets = Test-Path (Join-Path $taskRoot 'release\console-receiver\assets\Logo150.png') }
if (-not $checks.windows) { [ordered]@{ schemaVersion = 1; checks = $checks; status = 'unavailable'; compiled = $false; installed = $false; xboxQualified = $false } | ConvertTo-Json -Depth 5; throw 'Windows UWP compilation requires Windows. No package was compiled or installed.' }
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
$msbuild = $null
if ($checks.windows -and (Test-Path $vswhere)) { $msbuild = & $vswhere -latest -products '*' -find 'MSBuild\**\Bin\MSBuild.exe' | Select-Object -First 1 }
$checks.msbuild = [bool]$msbuild
$sdkRoot = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10'
$checks.windowsSdk22000 = Test-Path (Join-Path $sdkRoot 'Platforms\UAP\10.0.22000.0\Platform.xml')
$checks.uwpXamlTargets = $false
if ($msbuild) { $install = & $vswhere -latest -products '*' -property installationPath; $checks.uwpXamlTargets = @(Get-ChildItem (Join-Path $install 'MSBuild\Microsoft\WindowsXaml') -Filter 'Microsoft.Windows.UI.Xaml.CSharp.targets' -Recurse -ErrorAction SilentlyContinue).Count -gt 0 }
$node = Get-Command node -CommandType Application -ErrorAction SilentlyContinue
$checks.node = [bool]$node
$verifier = Join-Path $taskRoot 'apps\console-receiver\verify-bundle.mjs'
function Get-VerifiedBundle {
    $verified = & $node.Source $verifier $taskRoot
    if ($LASTEXITCODE -ne 0) { throw 'Current bundle manifest, source or artifact verification failed. Rebuild the local receiver.' }
    $pin = ($verified -join "`n") | ConvertFrom-Json
    if ($pin.status -ne 'verified') { throw 'Bundle verifier returned no verified input pin.' }
    return $pin
}
$inputPin = $null
$checks.bundleVerified = $false
if ($node) {
    try { $inputPin = Get-VerifiedBundle; $checks.bundleVerified = $true }
    catch { Write-Warning $_.Exception.Message }
}
$ready = -not ($checks.Values -contains $false)
$report = [ordered]@{ schemaVersion = 1; checks = $checks; status = $(if ($ready) {'prerequisites-present'} else {'unavailable'}); inputPin = $inputPin; compiled = $false; installed = $false; xboxQualified = $false }
$report | ConvertTo-Json -Depth 5
if (-not $ready) { throw 'Build prerequisites are missing. No package was compiled or installed.' }
if ($CheckOnly) { exit 0 }
if (Test-Path $output) {
    if ((Get-Item -LiteralPath $output -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Native output parent must not be a symbolic link or junction.' }
} else { New-Item -ItemType Directory -Path $output | Out-Null }
$invocationId = [Guid]::NewGuid().ToString('N')
$invocation = Join-Path $output $invocationId
# No -Force: this build must own a new output tree, never a previous package directory.
New-Item -ItemType Directory -Path $invocation | Out-Null
$packagesRoot = Join-Path $invocation 'packages'
New-Item -ItemType Directory -Path $packagesRoot | Out-Null
$arguments = @((Join-Path $PSScriptRoot 'Receiver.csproj'), '/t:Build', '/p:Platform=x64', "/p:Configuration=$Configuration", '/p:GenerateAppxPackageOnBuild=true',
    "/p:ReceiverInvocationRoot=$invocation", "/p:BaseIntermediateOutputPath=$invocation\obj\", "/p:IntermediateOutputPath=$invocation\obj\x64\$Configuration\",
    "/p:MSBuildProjectExtensionsPath=$invocation\obj\", "/p:OutputPath=$invocation\bin\", "/p:AppxPackageDir=$packagesRoot\", '/p:UapAppxPackageBuildMode=SideloadOnly')
if ($Restore) { $arguments += '/restore' }
if ($SigningThumbprint) { $arguments += '/p:AppxPackageSigningEnabled=true'; $arguments += "/p:PackageCertificateThumbprint=$SigningThumbprint" }
$beforeBuild = Get-VerifiedBundle
$startedAt = [DateTime]::UtcNow.ToString('o')
& $msbuild @arguments
if ($LASTEXITCODE -ne 0) { throw "UWP build failed ($LASTEXITCODE). No successful compile receipt exists." }
$afterBuild = Get-VerifiedBundle
if ($beforeBuild.manifest.sha256 -ne $afterBuild.manifest.sha256 -or $beforeBuild.sourceSetSha256 -ne $afterBuild.sourceSetSha256 -or $beforeBuild.artifactSetSha256 -ne $afterBuild.artifactSetSha256) { throw 'Receiver inputs changed during MSBuild. No compile receipt can be issued.' }
foreach ($directory in @($output, $invocation, $packagesRoot)) {
    $entry = Get-Item -LiteralPath $directory -Force
    if (-not $entry.PSIsContainer -or ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Native invocation directories must be real directories without symbolic links or junctions.' }
}
$entries = @(Get-ChildItem -LiteralPath $invocation -Recurse -Force)
if (@($entries | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }).Count -gt 0) { throw 'Native output contains a symbolic link or junction. No compile receipt can be issued.' }
$packages = @(Get-ChildItem -LiteralPath $packagesRoot -Recurse -File | Where-Object { $_.Extension -in '.appx','.msix','.appxbundle','.msixbundle' })
if ($packages.Count -eq 0) { throw 'MSBuild returned without a package. Build remains unverified.' }
$report.status = 'compiled'; $report.compiled = $true
$report.invocation = [ordered]@{ id = $invocationId; directory = $invocation; startedAt = $startedAt; completedAt = [DateTime]::UtcNow.ToString('o') }
$report.inputPin = $beforeBuild; $report.inputReadback = $afterBuild
$report.packages = @($packages | ForEach-Object { [ordered]@{ path = $_.FullName.Substring($taskRoot.Length + 1).Replace('\','/'); sha256 = (Get-FileHash $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant() } })
$report | ConvertTo-Json -Depth 8 | Set-Content (Join-Path $invocation 'build-receipt.json') -Encoding utf8
$report | ConvertTo-Json -Depth 8
