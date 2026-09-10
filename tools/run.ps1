# Builds and launches Vellum. -Debug exposes the WebView2 DevTools port 9222 for tools/cdp.mjs.
param(
    [string[]]$Files = @(),
    [switch]$Debug,
    [switch]$NoBuild
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$dotnetRoot = Join-Path $env:LOCALAPPDATA 'Microsoft\dotnet'
if (Test-Path (Join-Path $dotnetRoot 'dotnet.exe')) { $env:DOTNET_ROOT = $dotnetRoot; $dotnet = Join-Path $dotnetRoot 'dotnet.exe' } else { $dotnet = 'dotnet' }

$proj = Join-Path $root 'src\Vellum\Vellum.csproj'
if (-not $NoBuild) {
    & $dotnet build $proj -c Debug --nologo -v q
    if ($LASTEXITCODE -ne 0) { throw "Build failed" }
}
if ($Debug) { $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--remote-debugging-port=9222' }
$exe = Join-Path $root 'src\Vellum\bin\Debug\net10.0-windows\Vellum.exe'
if ($Files.Count -gt 0) {
    Start-Process -FilePath $exe -ArgumentList ($Files | ForEach-Object { '"' + $_ + '"' })
} else {
    Start-Process -FilePath $exe
}
