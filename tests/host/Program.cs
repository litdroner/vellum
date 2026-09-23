// OCR language packs on the host (src/Vellum/Services/OcrLanguages.cs): a pack becomes usable only once its
// size and SHA-256 match; a failed, cut short or cancelled download leaves nothing behind; an installed pack
// that changed on disk is refused and removed; packs can be removed. Downloads come from a fake handler.
// Recent files (src/Vellum/Services/RecentFiles.cs): each file remembers its reading layout across restarts.
// Document history (src/Vellum/Services/DocumentHistory.cs): Save As moves a document's history to its new path.
// Document collections (src/Vellum/Services/DocumentCollections.cs): named lists of paths that persist; PDFs untouched.
// Saved research (src/Vellum/Services/SavedResearch.cs): a result kept as the page made it, given back unchanged, deleted one at a time.
// Office → PDF providers (src/Vellum/Services/Conversion): see OfficeConversionTests.cs.

using System.Net;
using System.Security.Cryptography;
using Vellum.Services;

// Run again by the process-runner tests: prints each argument it was given, escaped, one per line.
if (args is ["--echo-args", .. var echo])
{
    foreach (var arg in echo) Console.WriteLine($"<{Uri.EscapeDataString(arg)}>");
    return 0;
}

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
Check("the shipped list loads every pack", real.Packs.Count == 12, real.Packs.Count.ToString());
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

// Document collections: named lists of file paths, kept across restarts; the PDFs themselves are never touched.
var collFolder = Path.Combine(root, "collections-data");
var collDocs = Path.Combine(root, "collection-docs");
Directory.CreateDirectory(collDocs);
string P1 = Path.Combine(collDocs, "one.pdf"), P2 = Path.Combine(collDocs, "two.pdf"), Gone = Path.Combine(collDocs, "gone.pdf");
File.WriteAllBytes(P1, [0x25, 0x50, 0x44, 0x46, 1]); File.WriteAllBytes(P2, [0x25, 0x50, 0x44, 0x46, 2]); File.WriteAllBytes(Gone, [0x25, 0x50, 0x44, 0x46, 3]);
var colls = new DocumentCollections(collFolder);
var work = colls.Create("  Work   papers ");
Check("a collection is created with a clean name", colls.All is [{ Name: "Work papers" }] && work.Id.Length > 0);
Check("a second collection with the same name is refused", Throws(() => { colls.Create("work PAPERS"); return Task.CompletedTask; }).Result is InvalidOperationException);
Check("an empty name is refused", Throws(() => { colls.Create("   "); return Task.CompletedTask; }).Result is ArgumentException);
Check("files are added", colls.Add(work.Id, [P1, P2, Gone]) == 3 && colls.All[0].Paths.SequenceEqual([P1, P2, Gone]));
Check("a file already in the collection isn't added twice (any case)", colls.Add(work.Id, [P1.ToUpperInvariant(), P2]) == 0 && colls.All[0].Paths.Count == 3);
Check("membership is looked up by path", colls.Contains(P2.ToUpperInvariant()) && !colls.Contains(Path.Combine(collDocs, "other.pdf")));
colls.Remove(work.Id, P2);
Check("a file is removed from the collection", colls.All[0].Paths.SequenceEqual([P1, Gone]) && !colls.Contains(P2));
Check("… and the file itself is still there, unchanged", File.Exists(P2) && File.ReadAllBytes(P2)[4] == 2);
File.Delete(Gone);
var reloaded = new DocumentCollections(collFolder);
Check("collections and membership survive a restart", reloaded.All is [{ Name: "Work papers" } c] && c.Id == work.Id && c.Paths.SequenceEqual([P1, Gone]));
Check("a file that's gone stays listed (shown as missing), not silently removed", reloaded.Contains(Gone) && !File.Exists(Gone));
var reading = reloaded.Create("Reading");
reloaded.Add(reading.Id, [P1]);
Check("one file can be in several collections", reloaded.All.Count(x => x.Paths.Contains(P1)) == 2);
reloaded.Rename(work.Id, "Archive");
Check("renaming keeps the documents", new DocumentCollections(collFolder).All.First(x => x.Id == work.Id) is { Name: "Archive" } r && r.Paths.SequenceEqual([P1, Gone]));
Check("renaming to another collection's name is refused", Throws(() => { reloaded.Rename(work.Id, "reading"); return Task.CompletedTask; }).Result is InvalidOperationException);
reloaded.Delete(work.Id);
var afterDelete = new DocumentCollections(collFolder);
Check("deleting a collection removes only that collection", afterDelete.All is [{ Name: "Reading" } left] && left.Paths.SequenceEqual([P1]));
Check("… and leaves every PDF where it was, unchanged", File.ReadAllBytes(P1)[4] == 1 && File.ReadAllBytes(P2)[4] == 2 && Directory.GetFiles(collDocs).Length == 2);
Check("a change to a deleted collection is refused", Throws(() => { afterDelete.Add(work.Id, [P2]); return Task.CompletedTask; }).Result is InvalidOperationException);
File.WriteAllText(Path.Combine(collFolder, "collections.json"), "{ not json");
Check("a damaged file loads as no collections and is kept aside", new DocumentCollections(collFolder).All.Count == 0 && File.Exists(Path.Combine(collFolder, "collections.json.bad")));

// Document history follows the document to a new path (Save As), unchanged; conflicts are refused.
var docs = Path.Combine(root, "docs");
Directory.CreateDirectory(Path.Combine(docs, "moved"));
var history = new DocumentHistory(Path.Combine(root, "history-data"));
string Doc(string name, int seed) { var p = Path.Combine(docs, name); File.WriteAllBytes(p, [.. Enumerable.Range(0, 1000 + seed).Select(i => (byte)(i * seed))]); return p; }
string Summary(IEnumerable<Snapshot> list) => string.Join("|", list.Select(s => $"{s.Id},{s.Name},{s.CreatedAt:O},{s.Size}"));
string Bytes(string document, string id) => Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(history.Get(document, id).File)));
var original = Doc("report.pdf", 3);
history.Create(original, "First draft");
File.AppendAllText(original, "more");
history.Create(original, "");
var before = Summary(history.List(original));
var beforeBytes = history.List(original).Select(s => Bytes(original, s.Id)).ToList();
var renamed = Path.Combine(docs, "report-final.pdf");
File.Copy(original, renamed);
Check("a rename moves the history", history.Move(original, renamed) == HistoryMove.Moved);
Check("… with the same snapshots, names, times and sizes", Summary(history.List(renamed)) == before, Summary(history.List(renamed)));
Check("… and the same snapshot files", history.List(renamed).Select(s => Bytes(renamed, s.Id)).SequenceEqual(beforeBytes));
Check("… and the old path keeps none", history.List(original).Count == 0);
Check("… both documents stay on disk as they were", File.Exists(original) && File.Exists(renamed));
File.Delete(original);
var stored = history.Stored();
Check("Settings lists it once, under the new path, not missing",
    stored.Count == 1 && stored[0].Path == renamed && !stored[0].Missing && stored[0].Count == 2, string.Join(",", stored.Select(s => $"{s.Path}:{s.Missing}")));
Check("its stored history opens the new document", history.DocumentFor(stored[0].Key) == renamed);
var moved = Path.Combine(docs, "moved", "report-final.pdf");
File.Copy(renamed, moved);
Check("a move to another folder moves the history", history.Move(renamed, moved) == HistoryMove.Moved && Summary(history.List(moved)) == before);
Check("a restore source is still there after moving", File.Exists(history.Get(moved, history.List(moved)[0].Id).File));
Check("moving to the same path (any case) changes nothing", history.Move(moved, moved.ToUpperInvariant()) == HistoryMove.None && Summary(history.List(moved)) == before);
var plain = Doc("plain.pdf", 5);
Check("a document without history moves nothing", history.Move(plain, Path.Combine(docs, "plain-2.pdf")) == HistoryMove.None && history.Stored().Count == 1);
var other = Doc("other.pdf", 7);
history.Create(other, "Other's own");
var otherBefore = Summary(history.List(other));
Check("a target with history of its own is refused", history.Move(moved, other) == HistoryMove.Conflict);
Check("… the document's history is left as it was", Summary(history.List(moved)) == before);
Check("… and so is the target's, nothing merged", Summary(history.List(other)) == otherBefore && history.Stored().Count == 2);
Check("… and neither document was touched", File.ReadAllBytes(other).Length == 1007 && File.Exists(moved));
var otherFolder = Path.Combine(root, "history-data", "history", history.Stored().First(s => s.Path == other).Key);
var foreign = Path.Combine(docs, "foreign.pdf");
var foreignKey = Convert.ToHexString(SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(foreign.ToUpperInvariant())))[..32];
Directory.CreateDirectory(Path.Combine(root, "history-data", "history", foreignKey));
File.Copy(Path.Combine(otherFolder, "index.json"), Path.Combine(root, "history-data", "history", foreignKey, "index.json"));
Check("a history folder whose index names another document never moves", history.Move(foreign, Path.Combine(docs, "x.pdf")) == HistoryMove.None
    && Directory.Exists(Path.Combine(root, "history-data", "history", foreignKey)) && Summary(history.List(other)) == otherBefore);

static bool Refused(Action run)
{
    try { run(); return false; } catch (Exception) { return true; }
}

// ---- saved research: a result kept whole, given back as it was saved, and deleted one at a time ----

var researchFolder = Path.Combine(root, "research-data");
Directory.CreateDirectory(researchFolder);
var researchFile = Path.Combine(researchFolder, "research.json");
var reportA = Doc("report-a.pdf", 3);
var reportB = Doc("report-b.pdf", 4);
var result = System.Text.Json.Nodes.JsonNode.Parse("""
{ "v": 1, "question": "Where are the samples collected weekly?", "source": "collection-research",
  "collection": { "id": "c1", "name": "Reports" }, "summary": "2 passages in 2 documents.", "sufficient": true,
  "evidence": [ { "id": "p2:run:7", "kind": "run", "page": 2, "text": "Samples were collected weekly",
                  "matched": ["samples", "collected", "weekly"], "box": [72.0, 700.0, 300.0, 712.0],
                  "provenance": { "v": 1, "source": "collection-research", "page": 2,
                                  "document": { "name": "report-a.pdf", "path": "X", "contentKey": "ABC", "reference": "content" },
                                  "object": { "id": "p2:run:7", "kind": "run", "blockId": "p2:block:1", "runIds": null } } } ] }
""")!;

var research = new SavedResearch(researchFolder);
var first = research.Save("  Weekly   samples  ", [reportA, reportB, reportA.ToUpperInvariant()], result);
Check("a saved result gets an id, its name cleaned and a time", first.Id.Length == 32 && first.Name == "Weekly samples" && first.CreatedAt > DateTimeOffset.Now.AddMinutes(-1));
Check("… and lists each document it quotes once", first.Paths.Count == 2);
Check("… the documents themselves are untouched", File.Exists(reportA) && File.Exists(reportB) && new FileInfo(reportA).Length == 1003);
research.Save("Second", [reportB], result);
Check("saving is refused without a name", Refused(() => research.Save(" ", [reportA], result)));
Check("saving is refused without a result", Refused(() => research.Save("No result", [reportA], null)));

var reread = new SavedResearch(researchFolder);
var items = reread.All;
Check("both survive a restart, newest first", items.Count == 2 && items[0].Name == "Second" && items[1].Name == "Weekly samples");
var kept = items[1].Result!.ToJsonString();
Check("the result comes back exactly as it was saved", kept == result.ToJsonString());
Check("… with its question, provenance and evidence inside it",
    kept.Contains("collected weekly") && kept.Contains("\"contentKey\":\"ABC\"") && kept.Contains("p2:block:1"), kept[..Math.Min(80, kept.Length)]);
Check("a document a saved result quotes can be reopened", reread.Contains(reportA) && reread.Contains(reportB.ToUpperInvariant()));
Check("… and one nothing quotes can't", !reread.Contains(Path.Combine(docs, "elsewhere.pdf")));

reread.Delete(items[0].Id);
Check("delete removes that one saved result only", reread.All.Count == 1 && reread.All[0].Name == "Weekly samples");
Check("… and the documents it quoted are still there", File.Exists(reportB));
Check("deleting one that is gone is refused", Refused(() => reread.Delete("nope")));
Check("the deletion survives a restart", new SavedResearch(researchFolder).All.Count == 1);

// A hand-edited or damaged file: whole items still open, broken ones are dropped, and a file that can't be
// read at all starts over with the old one kept beside it.
File.WriteAllText(researchFile, """
[ { "id": "a1", "name": "Whole", "createdAt": "2026-09-23T10:00:00+00:00", "paths": ["C:\\a.pdf", ""], "result": { "v": 1, "question": "q" } },
  { "id": "", "name": "No id", "result": { "v": 1 } },
  { "id": "a3", "name": "", "result": { "v": 1 } },
  { "id": "a4", "name": "No result" },
  { "id": "a1", "name": "Duplicate id", "result": { "v": 1 } } ]
""");
var damaged = new SavedResearch(researchFolder);
Check("a damaged file keeps the items that are whole and drops the rest", damaged.All.Count == 1 && damaged.All[0].Name == "Whole", string.Join(",", damaged.All.Select(i => i.Name)));
Check("… and empty paths inside one are dropped", damaged.All.Count == 1 && damaged.All[0].Paths.Count == 1);

File.WriteAllText(researchFile, "{ not json at all");
var broken = new SavedResearch(researchFolder);
Check("a file that can't be read at all starts over", broken.All.Count == 0);
Check("… and is kept beside it, so nothing a person saved is lost for good", File.Exists(researchFile + ".bad"));
broken.Save("After the damage", [reportA], result);
Check("saving again works and rewrites the file", new SavedResearch(researchFolder).All.Count == 1);

await OfficeConversionTests.Run(Check, root);

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
