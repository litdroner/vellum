using System.IO;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Vellum.Services;

/// <summary>An OCR language problem worth showing to the user as-is.</summary>
public sealed class OcrLanguageException(string message) : Exception(message);

/// <summary>
/// OCR language packs. English is bundled with the app (web/vendor/tesseract); the others are listed in
/// web/js/ocr/languages.json and downloaded only when the user asks, into %LOCALAPPDATA%\Vellum\ocr-languages,
/// never into the install folder. A download is written to a .part file and becomes {code}.traineddata.gz
/// only once its size and SHA-256 match the list; a file is checked again every time OCR loads it, and one
/// that no longer matches is deleted. The page reads a pack through AppResourceServer (/ocr-lang/…).
/// </summary>
public sealed partial class OcrLanguages
{
    public sealed record Pack(string Code, string Name, long Size, string Sha256);

    private sealed record Manifest(string? Source, Pack[]? Packs);

    /// <summary>Test hook, like Updater's: a loopback URL (http://127.0.0.1:…/) to download packs from.</summary>
    private static readonly Uri? TestSource = Loopback(Environment.GetEnvironmentVariable("VELLUM_OCR_LANGUAGE_SOURCE"));

    private readonly string _folder;
    private readonly Uri? _source;
    private readonly HttpClient _http;

    public IReadOnlyList<Pack> Packs { get; }

    public string Folder => _folder;

    public OcrLanguages(string dataFolder, string manifestPath, HttpClient? http = null, Uri? source = null)
    {
        _folder = Path.Combine(dataFolder, "ocr-languages");
        _http = http ?? Updater.Http;
        Manifest? manifest = null;
        try { manifest = JsonSerializer.Deserialize<Manifest>(File.ReadAllText(manifestPath), new JsonSerializerOptions(JsonSerializerDefaults.Web)); }
        catch (Exception) { /* no list: English only */ }
        Packs = (manifest?.Packs ?? [])
            .Where(p => p.Code is not null && LanguageCode().IsMatch(p.Code) && p.Code != "eng" && p.Size > 0 && Sha256Hex().IsMatch(p.Sha256 ?? ""))
            .DistinctBy(p => p.Code)
            .ToArray();
        _source = source ?? TestSource ?? Trusted(manifest?.Source);
    }

    public Pack? Find(string? code) => Packs.FirstOrDefault(p => p.Code == code);

    public string PathOf(Pack pack) => Path.Combine(_folder, pack.Code + ".traineddata.gz");

    /// <summary>A quick check for listing (the file is there with the right size); <see cref="ReadVerified"/> checks its content.</summary>
    public bool IsInstalled(Pack pack)
    {
        var file = new FileInfo(PathOf(pack));
        return file.Exists && file.Length == pack.Size;
    }

    /// <summary>
    /// The pack's bytes if it is installed and still matches its checksum, else null. A file that doesn't
    /// match (damaged or changed on disk) is deleted, so it shows as not installed.
    /// </summary>
    public byte[]? ReadVerified(Pack pack)
    {
        var path = PathOf(pack);
        byte[] bytes;
        try { bytes = File.ReadAllBytes(path); }
        catch (Exception) when (!File.Exists(path)) { return null; }
        catch (IOException) { return null; }
        catch (UnauthorizedAccessException) { return null; }
        if (bytes.Length == pack.Size && Convert.ToHexStringLower(SHA256.HashData(bytes)) == pack.Sha256) return bytes;
        TryDelete(path);
        return null;
    }

    /// <summary>Downloads a pack and makes it usable only once it is verified. Nothing is left behind if it fails or is cancelled.</summary>
    public async Task InstallAsync(Pack pack, IProgress<(long Received, long Total)> progress, CancellationToken ct, Action? verifying = null)
    {
        if (_source is null) throw new OcrLanguageException("Language downloads aren’t available in this build.");
        Directory.CreateDirectory(_folder);
        var target = PathOf(pack);
        var part = target + ".part";
        try
        {
            // A stalled connection is abandoned after 30 s without data; the user can also cancel.
            using var stall = CancellationTokenSource.CreateLinkedTokenSource(ct);
            stall.CancelAfter(TimeSpan.FromSeconds(30));
            using var response = await _http.GetAsync(new Uri(_source, pack.Code + ".traineddata.gz"), HttpCompletionOption.ResponseHeadersRead, stall.Token).ConfigureAwait(false);
            if (!response.IsSuccessStatusCode) throw new OcrLanguageException($"The download failed (the server answered {(int)response.StatusCode}). Try again later.");
            long received = 0;
            await using (var source = await response.Content.ReadAsStreamAsync(stall.Token).ConfigureAwait(false))
            await using (var file = new FileStream(part, FileMode.Create, FileAccess.Write, FileShare.None, 1 << 16, useAsync: true))
            {
                var buffer = new byte[1 << 16];
                int read;
                while ((read = await source.ReadAsync(buffer, stall.Token).ConfigureAwait(false)) > 0)
                {
                    received += read;
                    if (received > pack.Size) throw Mismatch(pack);
                    await file.WriteAsync(buffer.AsMemory(0, read), stall.Token).ConfigureAwait(false);
                    stall.CancelAfter(TimeSpan.FromSeconds(30));
                    progress.Report((received, pack.Size));
                }
            }
            verifying?.Invoke();
            if (received != pack.Size || await Updater.HashAsync(part, ct).ConfigureAwait(false) != pack.Sha256) throw Mismatch(pack);
            File.Move(part, target, overwrite: true);
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            throw new OcrLanguageException("The download stopped responding. Check your connection and try again.");
        }
        catch (HttpRequestException)
        {
            throw new OcrLanguageException("The download was interrupted. Check your connection and try again.");
        }
        finally
        {
            TryDelete(part);
        }
    }

    public void Remove(Pack pack)
    {
        try { File.Delete(PathOf(pack)); }
        catch (IOException) { throw new OcrLanguageException($"The {pack.Name} language data is in use. Try again in a moment."); }
        catch (UnauthorizedAccessException) { throw new OcrLanguageException($"The {pack.Name} language data couldn’t be removed."); }
    }

    /// <summary>Removes downloads that never finished (Vellum closed while one was running).</summary>
    public void CleanUp()
    {
        try
        {
            if (!Directory.Exists(_folder)) return;
            foreach (var file in Directory.EnumerateFiles(_folder, "*.part")) TryDelete(file);
        }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
    }

    private static OcrLanguageException Mismatch(Pack pack) =>
        new($"The downloaded {pack.Name} language data didn’t match its published checksum, so it was thrown away. Try again later.");

    /// <summary>Only the pinned tessdata source on GitHub (or the loopback test source).</summary>
    private static Uri? Trusted(string? url) =>
        Uri.TryCreate(url, UriKind.Absolute, out var u) && u.Scheme == Uri.UriSchemeHttps
            && u.Host.Equals("raw.githubusercontent.com", StringComparison.OrdinalIgnoreCase)
            && u.AbsolutePath.StartsWith("/naptha/tessdata/", StringComparison.Ordinal) && u.AbsolutePath.EndsWith('/')
            ? u : null;

    private static Uri? Loopback(string? url) =>
        Uri.TryCreate(url, UriKind.Absolute, out var u) && u.Scheme == Uri.UriSchemeHttp && u.IsLoopback
            ? new Uri(u.AbsoluteUri.EndsWith('/') ? u.AbsoluteUri : u.AbsoluteUri + "/") : null;

    private static void TryDelete(string path)
    {
        try { File.Delete(path); }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
    }

    [GeneratedRegex("^[a-z]{3}$")]
    private static partial Regex LanguageCode();

    [GeneratedRegex("^[0-9a-f]{64}$")]
    private static partial Regex Sha256Hex();
}
