# Builds a self-contained Release copy of Vellum in dist\Vellum (runs without .NET installed),
# then compiles dist\Vellum-Setup.exe with Inno Setup if it's installed.
param([switch]$NoInstaller)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$dotnetRoot = Join-Path $env:LOCALAPPDATA 'Microsoft\dotnet'
$dotnet = if (Test-Path (Join-Path $dotnetRoot 'dotnet.exe')) { Join-Path $dotnetRoot 'dotnet.exe' } else { 'dotnet' }

$project = Join-Path $root 'src\Vellum\Vellum.csproj'
$out = Join-Path $root 'dist\Vellum'
if (Test-Path $out) { Remove-Item $out -Recurse -Force }

# ReadyToRun precompiles the .NET code, so double-clicking a PDF opens faster.
& $dotnet publish $project -c Release -r win-x64 --self-contained true -o $out --nologo -v q `
    -p:PublishReadyToRun=true -p:DebugType=none -p:DebugSymbols=false
if ($LASTEXITCODE -ne 0) { throw 'Publish failed' }
[xml]$csproj = Get-Content $project
$version = $csproj.Project.PropertyGroup.Version | Select-Object -First 1
"Published Vellum $version to $out"

if ($NoInstaller) { return }
$iscc = @(
    (Join-Path $env:LOCALAPPDATA 'Programs\Inno Setup 6\ISCC.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'Inno Setup 6\ISCC.exe'),
    (Join-Path $env:ProgramFiles 'Inno Setup 6\ISCC.exe')
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $iscc) { Write-Warning 'Inno Setup not found; skipped building the installer.'; return }
& $iscc /Q "/DAppVersion=$version" (Join-Path $root 'installer\Vellum.iss')
if ($LASTEXITCODE -ne 0) { throw 'Installer build failed' }
"Installer: $(Join-Path $root 'dist\Vellum-Setup.exe')"
