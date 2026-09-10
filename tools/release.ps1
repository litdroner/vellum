# Publishes the current version as a GitHub release: builds the installer (tools/publish.ps1), then
# uploads Vellum-Setup.exe and its SHA-256 to a release tagged v<version>. In-app updates find it there.
# usage: tools\release.ps1 -NotesFile notes.md [-Draft] [-SkipBuild]
param(
    [Parameter(Mandatory)][string]$NotesFile,
    [switch]$Draft,
    [switch]$SkipBuild
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
[xml]$csproj = Get-Content (Join-Path $root 'src\Vellum\Vellum.csproj')
$version = $csproj.Project.PropertyGroup.Version | Select-Object -First 1
$tag = "v$version"
if (-not (Test-Path $NotesFile)) { throw "No release notes at $NotesFile" }

# The tag has to point at a pushed commit, so what people download matches the code on GitHub.
$head = git -C $root rev-parse HEAD
git -C $root fetch --quiet origin
if (-not (git -C $root branch -r --contains $head)) { throw "Commit $head isn't on GitHub yet. Push it first." }
if (git -C $root ls-remote --tags origin "refs/tags/$tag") { throw "$tag already exists on GitHub. Bump <Version> in Vellum.csproj first." }

if (-not $SkipBuild) { & (Join-Path $PSScriptRoot 'publish.ps1') }
$setup = Join-Path $root 'dist\Vellum-Setup.exe'
if (-not (Test-Path $setup)) { throw "No installer at $setup" }
$built = (Get-Item $setup).VersionInfo.ProductVersion
if ($built -ne $version) { throw "dist\Vellum-Setup.exe is version $built, not $version. Run without -SkipBuild." }

# GitHub also records a SHA-256 for each upload; the .sha256 file is a fallback the updater reads if not.
$hash = (Get-FileHash $setup -Algorithm SHA256).Hash.ToLowerInvariant()
$sums = "$setup.sha256"
[IO.File]::WriteAllText($sums, "$hash  Vellum-Setup.exe`n")

$ghArgs = @('release', 'create', $tag, $setup, $sums, '--title', "Vellum $version", '--notes-file', $NotesFile, '--target', $head)
if ($Draft) { $ghArgs += '--draft' }
Push-Location $root
try {
    gh @ghArgs
    if ($LASTEXITCODE -ne 0) { throw 'gh release create failed' }
} finally { Pop-Location }
"Released $tag (sha256 $hash)"
