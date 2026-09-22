// OCR language packs on the host (src/Vellum/Services/OcrLanguages.cs): a pack becomes usable only once its
// size and SHA-256 match; a failed, cut short or cancelled download leaves nothing behind; an installed pack
// that changed on disk is refused and removed; packs can be removed. Downloads come from a fake handler.
// Recent files (src/Vellum/Services/RecentFiles.cs): each file remembers its reading layout across restarts.

using System.Net;
using System.Security.Cryptography;
using Vellum.Services;

var failures = 0;
void Check(string name, bool ok, string? detail = null)
{
    Console.WriteLine($"{(ok ? "ok  " : "FAIL")} {name}{(ok || detail is null ? "" : $" — {detail}")}");
    if (!ok) failures++;
}
async Task<Exception?> Throws(Func<Task> run)
{
    try { await run(); return null; } catch (Exception ex) { return ex; }
}

var root = Path.Combine(Path.GetTempPath(), "vellum-ocr-lang-tests-" + Guid.NewGuid().ToString("N"));
Directory.CreateDirectory(root);
var good = RandomNumberGenerator.GetBytes(200_000);
var sha = Convert.ToHexStringLower(SHA256.HashData(good));
var manifest = Path.Combine(root, "languages.json");
File.WriteAllText(manifest, $$"""
{ "source": "https://example.com/elsewhere/",
  "packs": [
    { "code": "tst", "name": "Testish", "size": {{good.Length}}, "sha256": "{{sha}}" },
    { "code": "eng", "name": "Not English", "size": 5, "sha256": "{{sha}}" },
    { "code": "bad", "name": "No checksum", "size": 5, "sha256": "nope" },
    { "code": "tst", "name": "Duplicate", "size": 5, "sha256": "{{sha}}" } ] }
""");
var source = new Uri("http://127.0.0.1:9/");
var served = good;
var status = HttpStatusCode.OK;
var requested = new List<string>();
var http = new HttpClient(new Fake(req =>
{
    requested.Add(req.RequestUri!.AbsoluteUri);
    return new HttpResponseMessage(status) { Content = new ByteArrayContent(served) };
}));
var data = Path.Combine(root, "data");
var langs = new OcrLanguages(data, manifest, http, source);
var pack = langs.Find("tst")!;
var progress = new Progress<(long, long)>(_ => { });

Check("only valid, distinct, non-English packs are listed", langs.Packs.Count == 1 && pack?.Name == "Testish", string.Join(",", langs.Packs.Select(p => p.Code)));
Check("packs are stored outside the install, in the data folder", langs.Folder == Path.Combine(data, "ocr-languages"));
Check("an untrusted source in the list means no downloads", await Throws(() => new OcrLanguages(data, manifest, http).InstallAsync(pack!, progress, default)) is OcrLanguageException);
Check("nothing is installed to begin with", !langs.IsInstalled(pack!) && langs.ReadVerified(pack!) is null);

// Checksum failure: right size, wrong bytes.
served = RandomNumberGenerator.GetBytes(good.Length);
var ex = await Throws(() => langs.InstallAsync(pack!, progress, default));
Check("a download that doesn't match its checksum is refused", ex is OcrLanguageException && ex.Message.Contains("checksum"), ex?.Message);
Check("… and leaves nothing usable or partial behind", !langs.IsInstalled(pack!) && !Directory.EnumerateFiles(langs.Folder).Any());

served = good[..^10];
ex = await Throws(() => langs.InstallAsync(pack!, progress, default));
Check("a download cut short is refused", ex is OcrLanguageException && !langs.IsInstalled(pack!) && !Directory.EnumerateFiles(langs.Folder).Any(), ex?.Message);

served = [.. good, 1, 2, 3];
ex = await Throws(() => langs.InstallAsync(pack!, progress, default));
Check("a download larger than published is refused", ex is OcrLanguageException && !Directory.EnumerateFiles(langs.Folder).Any(), ex?.Message);

served = good;
status = HttpStatusCode.NotFound;
ex = await Throws(() => langs.InstallAsync(pack!, progress, default));
Check("a failed request is explained", ex is OcrLanguageException && ex.Message.Contains("404") && !Directory.EnumerateFiles(langs.Folder).Any(), ex?.Message);
status = HttpStatusCode.OK;

using (var cancel = new CancellationTokenSource())
{
    cancel.Cancel();
    ex = await Throws(() => langs.InstallAsync(pack!, progress, cancel.Token));
    Check("a cancelled download leaves nothing", ex is OperationCanceledException && !langs.IsInstalled(pack!) && !Directory.EnumerateFiles(langs.Folder).Any(), ex?.GetType().Name);
}

// Install.
requested.Clear();
var verifying = false;
long lastReported = 0;
await langs.InstallAsync(pack!, new Progress<(long Received, long Total)>(p => lastReported = p.Received), default, () => verifying = true);
Check("a verified download installs", langs.IsInstalled(pack!) && langs.ReadVerified(pack!) is { } bytes && bytes.SequenceEqual(good));
Check("it was fetched by its code from the source", requested.SingleOrDefault() == "http://127.0.0.1:9/tst.traineddata.gz", string.Join(",", requested));
Check("it was checked before activation", verifying);
Check("only the pack file is kept", Directory.EnumerateFiles(langs.Folder).Select(Path.GetFileName).SequenceEqual(["tst.traineddata.gz"]));

// Changed on disk after install: same size, different content.
var onDisk = File.ReadAllBytes(langs.PathOf(pack!));
onDisk[1234] ^= 0xFF;
File.WriteAllBytes(langs.PathOf(pack!), onDisk);
Check("a pack changed on disk looks installed by size…", langs.IsInstalled(pack!));
Check("… but is refused when OCR loads it, and removed", langs.ReadVerified(pack!) is null && !File.Exists(langs.PathOf(pack!)) && !langs.IsInstalled(pack!));

// Remove.
await langs.InstallAsync(pack!, progress, default);
langs.Remove(pack!);
Check("a pack can be removed", !langs.IsInstalled(pack!) && langs.ReadVerified(pack!) is null);
langs.Remove(pack!);
Check("removing it again is harmless", true);

File.WriteAllBytes(Path.Combine(langs.Folder, "tst.traineddata.gz.part"), [1, 2, 3]);
langs.CleanUp();
Check("leftovers of an interrupted download are cleaned up", !Directory.EnumerateFiles(langs.Folder).Any());

// The real list shipped with Vellum.
var real = new OcrLanguages(data, Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "..", "src", "Vellum", "web", "js", "ocr", "languages.json"), http);
Check("the shipped list loads every pack", real.Packs.Count == 10, real.Packs.Count.ToString());
Check("the shipped list's GitHub source is trusted", await Throws(() => real.InstallAsync(real.Packs[0], progress, new CancellationToken(true))) is OperationCanceledException);

// Each file remembers its layout (single page / continuous, two-page spread), kept across restarts.
var recentFolder = Path.Combine(root, "recent");
var recent = new RecentFiles(recentFolder);
string A = Path.Combine(root, "a.pdf"), B = Path.Combine(root, "b.pdf"), C = Path.Combine(root, "c.pdf");
recent.Touch(A); recent.Touch(B); recent.Touch(C);
recent.UpdatePosition(A, 3, "page-width", "continuous", true);
recent.UpdatePosition(B, 1, "auto", "single", false);
Check("a new file has no remembered layout (the default applies)", recent.Find(C) is { ViewMode: null, Spread: null });
Check("spread is remembered", recent.Find(A) is { Spread: true, ViewMode: "continuous", Page: 3 });
Check("single page is remembered", recent.Find(B) is { Spread: false, ViewMode: "single" });
var reopened = new RecentFiles(recentFolder);
Check("spread survives closing and reopening", reopened.Find(A) is { Spread: true, ViewMode: "continuous", ScaleValue: "page-width" });
Check("single page survives closing and reopening", reopened.Find(B) is { Spread: false, ViewMode: "single" });
Check("the new file still has no layout after reopening", reopened.Find(C) is { ViewMode: null, Spread: null });
reopened.UpdatePosition(A, 3, "page-width", "single", false);
Check("changing the layout replaces the remembered one", new RecentFiles(recentFolder).Find(A) is { Spread: false, ViewMode: "single" });
File.WriteAllText(Path.Combine(recentFolder, "recent.json"), $"[{{\"path\":{System.Text.Json.JsonSerializer.Serialize(A)},\"page\":2,\"viewMode\":\"continuous\"}}]");
Check("a list saved before spreads were remembered loads with spread unset", new RecentFiles(recentFolder).Find(A) is { Spread: null, ViewMode: "continuous", Page: 2 });

try { Directory.Delete(root, true); } catch (IOException) { }
Console.WriteLine(failures == 0 ? "all passed" : $"{failures} failed");
return failures == 0 ? 0 : 1;

sealed class Fake(Func<HttpRequestMessage, HttpResponseMessage> answer) : HttpMessageHandler
{
    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        return Task.FromResult(answer(request));
    }
}
