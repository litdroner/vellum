using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Vellum.Services;

/// <summary>An update problem worth showing to the user as-is.</summary>
public sealed class UpdateException(string message) : Exception(message);

/// <summary>
/// In-app updates. New versions are published as GitHub releases of litdroner/vellum; a release is an
/// update when its tag (v1.2.3) is newer than this build. Its Vellum-Setup.exe is downloaded into
/// %LOCALAPPDATA%\Vellum\updates, checked against the SHA-256 GitHub records for the file, and run
/// silently: Setup waits for Vellum to close, installs over it and starts it again.
/// </summary>
public sealed partial class Updater
{
    private const string Owner = "litdroner";
    private const string Repo = "vellum";
    private const string AssetName = "Vellum-Setup.exe";
    private const string RelaunchFileName = "relaunch.json";

    /// <summary>
    /// Test hook: a loopback URL (http://127.0.0.1:…) serving a release in GitHub's JSON shape, so the whole
    /// update path can be exercised without publishing anything. Any other value is ignored.
    /// </summary>
    private static readonly Uri? TestFeed = Loopback(Environment.GetEnvironmentVariable("VELLUM_UPDATE_FEED"));

    public static Version Current { get; } = ThreeParts(typeof(Updater).Assembly.GetName().Version ?? new Version(0, 0, 0));

    private static readonly HttpClient Http = CreateClient();

    private readonly string _folder;

    public Updater(string dataFolder) => _folder = Path.Combine(dataFolder, "updates");

    /// <summary>A published version. <see cref="Sha256"/> is null when GitHub gave no checksum (it then can't be installed from here).</summary>
    public sealed record Release(Version Version, string Name, string Notes, string PageUrl, string DownloadUrl, long Size, string? Sha256, DateTimeOffset? PublishedAt);

    /// <summary>The newest published release, or null if there is none yet.</summary>
    public async Task<Release?> GetLatestAsync(CancellationToken ct = default)
    {
        var url = TestFeed ?? new Uri($"https://api.github.com/repos/{Owner}/{Repo}/releases/latest");
        using var json = await GetJsonAsync(url, ct).ConfigureAwait(false);
        return json is null ? null : await ParseReleaseAsync(json.RootElement, ct).ConfigureAwait(false);
    }

    /// <summary>The release for one version (its notes are shown as "What's new" after updating).</summary>
    public async Task<Release?> GetReleaseAsync(Version version, CancellationToken ct = default)
    {
        var url = TestFeed ?? new Uri($"https://api.github.com/repos/{Owner}/{Repo}/releases/tags/v{version.ToString(3)}");
        using var json = await GetJsonAsync(url, ct).ConfigureAwait(false);
        var release = json is null ? null : await ParseReleaseAsync(json.RootElement, ct).ConfigureAwait(false);
        return release?.Version == version ? release : null;
    }

    /// <summary>Downloads and verifies a release's installer; returns its path. Reuses an earlier, verified download.</summary>
    public async Task<string> DownloadAsync(Release release, IProgress<(long Received, long Total)> progress, CancellationToken ct)
    {
        if (release.Sha256 is null)
            throw new UpdateException("This update has no published checksum, so Vellum can’t verify it and won’t install it. You can download it from the release page instead.");
        Directory.CreateDirectory(_folder);
        var target = Path.Combine(_folder, $"Vellum-Setup-{release.Version.ToString(3)}.exe");
        if (File.Exists(target) && await HashAsync(target, ct).ConfigureAwait(false) == release.Sha256)
        {
            progress.Report((release.Size, release.Size));
            return target;
        }
        CleanUp();

        var part = target + ".part";
        try
        {
            // A stalled connection is abandoned after 30 s without data; the user can also cancel.
            using var stall = CancellationTokenSource.CreateLinkedTokenSource(ct);
            stall.CancelAfter(TimeSpan.FromSeconds(30));
            using var response = await Http.GetAsync(release.DownloadUrl, HttpCompletionOption.ResponseHeadersRead, stall.Token).ConfigureAwait(false);
            if (!response.IsSuccessStatusCode) throw new UpdateException($"The download failed (GitHub answered {(int)response.StatusCode}). Try again later.");
            var total = response.Content.Headers.ContentLength ?? release.Size;
            await using (var source = await response.Content.ReadAsStreamAsync(stall.Token).ConfigureAwait(false))
            await using (var file = new FileStream(part, FileMode.Create, FileAccess.Write, FileShare.None, 1 << 16, useAsync: true))
            {
                var buffer = new byte[1 << 16];
                long received = 0;
                int read;
                while ((read = await source.ReadAsync(buffer, stall.Token).ConfigureAwait(false)) > 0)
                {
                    await file.WriteAsync(buffer.AsMemory(0, read), stall.Token).ConfigureAwait(false);
                    received += read;
                    stall.CancelAfter(TimeSpan.FromSeconds(30));
                    progress.Report((received, total));
                }
            }
            if (await HashAsync(part, ct).ConfigureAwait(false) != release.Sha256)
                throw new UpdateException("The downloaded update didn’t match its published checksum, so it was thrown away. Try again later.");
            File.Move(part, target, overwrite: true);
            return target;
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            throw new UpdateException("The download stopped responding. Check your connection and try again.");
        }
        catch (HttpRequestException)
        {
            throw new UpdateException("The download was interrupted. Check your connection and try again.");
        }
        finally
        {
            TryDelete(part);
        }
    }

    /// <summary>
    /// Runs a downloaded installer silently. It waits for Vellum to exit (see SingleInstance), installs,
    /// then starts Vellum again (the installer's "relaunch" option).
    /// </summary>
    public async Task StartInstallerAsync(string installer, string sha256)
    {
        // Checked again: the file sat on disk between download and now.
        if (await HashAsync(installer, CancellationToken.None).ConfigureAwait(false) != sha256)
            throw new UpdateException("The downloaded update changed on disk, so it won’t be run. Download it again.");
        var log = Path.Combine(_folder, "install.log");
        Process.Start(new ProcessStartInfo(installer)
        {
            UseShellExecute = false,
            WorkingDirectory = _folder,
            Arguments = $"/SILENT /SUPPRESSMSGBOXES /NORESTART /CLOSEAPPLICATIONS /relaunch=1 \"/LOG={log}\"",
        });
    }

    /// <summary>Deletes old downloads (the install log is kept a while, for troubleshooting).</summary>
    public void CleanUp()
    {
        try
        {
            if (!Directory.Exists(_folder)) return;
            foreach (var file in Directory.EnumerateFiles(_folder))
            {
                if (file.EndsWith(".log", StringComparison.OrdinalIgnoreCase) && File.GetLastWriteTime(file) > DateTime.Now.AddDays(-14)) continue;
                TryDelete(file);
            }
        }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
    }

    // ---- reopening documents after an update -------------------------------------------------

    /// <summary>Remembers which documents were open, so the updated Vellum reopens them.</summary>
    public static void SaveRelaunchFiles(string dataFolder, IEnumerable<string> files)
    {
        try
        {
            Directory.CreateDirectory(dataFolder);
            File.WriteAllText(Path.Combine(dataFolder, RelaunchFileName),
                JsonSerializer.Serialize(new RelaunchState(files.Where(File.Exists).ToArray(), DateTimeOffset.Now)));
        }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
    }

    /// <summary>The documents to reopen after an update (read once, then forgotten).</summary>
    public static string[] TakeRelaunchFiles(string dataFolder)
    {
        var path = Path.Combine(dataFolder, RelaunchFileName);
        try
        {
            if (!File.Exists(path)) return [];
            var state = JsonSerializer.Deserialize<RelaunchState>(File.ReadAllText(path));
            File.Delete(path);
            // A leftover from an update that never finished shouldn't reopen files days later.
            if (state?.Files is null || state.At < DateTimeOffset.Now.AddMinutes(-30)) return [];
            return state.Files.Where(File.Exists).Select(Path.GetFullPath).ToArray();
        }
        catch (Exception)
        {
            TryDelete(path);
            return [];
        }
    }

    private sealed record RelaunchState(string[] Files, DateTimeOffset At);

    // ---- helpers -----------------------------------------------------------------------------

    public static bool TryParseVersion(string? tag, out Version version)
    {
        version = new Version(0, 0, 0);
        if (string.IsNullOrWhiteSpace(tag)) return false;
        var text = tag.Trim().TrimStart('v', 'V');
        var cut = text.IndexOfAny(['-', '+', ' ']);
        if (cut >= 0) text = text[..cut];
        if (!text.Contains('.')) text += ".0";
        if (!Version.TryParse(text, out var parsed)) return false;
        version = ThreeParts(parsed);
        return true;
    }

    private static Version ThreeParts(Version v) => new(v.Major, v.Minor, Math.Max(0, v.Build));

    private static async Task<Release?> ParseReleaseAsync(JsonElement root, CancellationToken ct)
    {
        if (Bool(root, "draft") || Bool(root, "prerelease")) return null;
        if (!TryParseVersion(Text(root, "tag_name"), out var version)) return null;

        var download = "";
        long size = 0;
        string? sha = null;
        string? checksumUrl = null;
        if (root.TryGetProperty("assets", out var assets) && assets.ValueKind == JsonValueKind.Array)
        {
            foreach (var asset in assets.EnumerateArray())
            {
                var name = Text(asset, "name");
                var url = Text(asset, "browser_download_url");
                if (url is null || !IsTrustedDownload(url)) continue;
                if (string.Equals(name, AssetName, StringComparison.OrdinalIgnoreCase))
                {
                    download = url;
                    size = asset.TryGetProperty("size", out var s) && s.TryGetInt64(out var bytes) ? bytes : 0;
                    // GitHub records a SHA-256 for every uploaded file ("sha256:…").
                    var digest = Text(asset, "digest");
                    if (digest?.StartsWith("sha256:", StringComparison.OrdinalIgnoreCase) == true) sha = digest[7..];
                }
                else if (string.Equals(name, AssetName + ".sha256", StringComparison.OrdinalIgnoreCase))
                {
                    checksumUrl = url;
                }
            }
        }
        if (sha is null && checksumUrl is not null && download.Length > 0) sha = await GetChecksumAsync(checksumUrl, ct).ConfigureAwait(false);
        sha = sha?.Trim().ToLowerInvariant();
        if (sha is not null && !Sha256Hex().IsMatch(sha)) sha = null;

        var page = Text(root, "html_url");
        return new Release(
            version,
            Text(root, "name") is { Length: > 0 } title ? title : $"Vellum {version.ToString(3)}",
            Text(root, "body") ?? "",
            page is not null && Uri.TryCreate(page, UriKind.Absolute, out var p) && p.Scheme == Uri.UriSchemeHttps ? page : $"https://github.com/{Owner}/{Repo}/releases",
            download,
            size,
            sha,
            root.TryGetProperty("published_at", out var at) && at.TryGetDateTimeOffset(out var published) ? published : null);
    }

    private static async Task<string?> GetChecksumAsync(string url, CancellationToken ct)
    {
        try
        {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
            timeout.CancelAfter(TimeSpan.FromSeconds(20));
            var text = await Http.GetStringAsync(url, timeout.Token).ConfigureAwait(false);
            return text.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries).FirstOrDefault();
        }
        catch (Exception) when (!ct.IsCancellationRequested)
        {
            return null;
        }
    }

    private static async Task<JsonDocument?> GetJsonAsync(Uri url, CancellationToken ct)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(TimeSpan.FromSeconds(20));
        using var request = new HttpRequestMessage(HttpMethod.Get, url);
        request.Headers.Accept.ParseAdd("application/vnd.github+json");
        try
        {
            using var response = await Http.SendAsync(request, timeout.Token).ConfigureAwait(false);
            if (response.StatusCode == HttpStatusCode.NotFound) return null;
            if (response.StatusCode is HttpStatusCode.Forbidden or HttpStatusCode.TooManyRequests)
                throw new UpdateException("GitHub is limiting update checks from this network right now. Try again in an hour.");
            if (!response.IsSuccessStatusCode)
                throw new UpdateException($"GitHub answered with an error ({(int)response.StatusCode}). Try again later.");
            await using var stream = await response.Content.ReadAsStreamAsync(timeout.Token).ConfigureAwait(false);
            return await JsonDocument.ParseAsync(stream, cancellationToken: timeout.Token).ConfigureAwait(false);
        }
        catch (HttpRequestException)
        {
            throw new UpdateException("Couldn’t reach GitHub to check for updates. Check your internet connection and try again.");
        }
        catch (JsonException)
        {
            throw new UpdateException("GitHub sent an answer Vellum couldn’t read. Try again later.");
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            throw new UpdateException("GitHub took too long to answer. Try again in a moment.");
        }
    }

    /// <summary>Only the project's own release downloads are accepted (or the loopback test feed).</summary>
    private static bool IsTrustedDownload(string url)
    {
        if (!Uri.TryCreate(url, UriKind.Absolute, out var u)) return false;
        if (TestFeed is not null) return u.Scheme == Uri.UriSchemeHttp && u.IsLoopback;
        return u.Scheme == Uri.UriSchemeHttps
            && u.Host.Equals("github.com", StringComparison.OrdinalIgnoreCase)
            && u.AbsolutePath.StartsWith($"/{Owner}/{Repo}/releases/download/", StringComparison.OrdinalIgnoreCase);
    }

    private static Uri? Loopback(string? url) =>
        Uri.TryCreate(url, UriKind.Absolute, out var u) && u.Scheme == Uri.UriSchemeHttp && u.IsLoopback ? u : null;

    private static async Task<string> HashAsync(string path, CancellationToken ct)
    {
        await using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read, 1 << 16, useAsync: true);
        return Convert.ToHexStringLower(await SHA256.HashDataAsync(stream, ct).ConfigureAwait(false));
    }

    private static HttpClient CreateClient()
    {
        var http = new HttpClient(new SocketsHttpHandler
        {
            AutomaticDecompression = DecompressionMethods.All,
            PooledConnectionLifetime = TimeSpan.FromMinutes(5),
        })
        { Timeout = Timeout.InfiniteTimeSpan }; // per-call timeouts above; downloads can take a while
        http.DefaultRequestHeaders.UserAgent.Add(new ProductInfoHeaderValue("Vellum", Current.ToString(3)));
        http.DefaultRequestHeaders.Add("X-GitHub-Api-Version", "2022-11-28");
        return http;
    }

    private static string? Text(JsonElement e, string name) =>
        e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

    private static bool Bool(JsonElement e, string name) =>
        e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.True;

    private static void TryDelete(string path)
    {
        try { File.Delete(path); }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
    }

    [GeneratedRegex("^[0-9a-f]{64}$")]
    private static partial Regex Sha256Hex();
}
