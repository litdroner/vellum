using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Vellum.Hosting;

namespace Vellum.Services;

public sealed class Snapshot
{
    public string Id { get; set; } = "";
    /// <summary>What the person called it; empty when they gave no name.</summary>
    public string Name { get; set; } = "";
    public DateTimeOffset CreatedAt { get; set; }
    public long Size { get; set; }
}

/// <summary>
/// Document history: snapshots a person takes of a PDF, kept on this PC only, in
/// %LOCALAPPDATA%\Vellum\history\{key}\ (key = a hash of the document's full path). Each snapshot is an
/// exact copy of the file as saved on disk ({id}.pdf) listed in index.json. Snapshots are never written
/// again once taken: restoring one writes a copy of it into the document, deleting one removes it.
/// Nothing here runs by itself; every snapshot is made because the person asked for it.
/// </summary>
public sealed class DocumentHistory
{
    private const int MaxNameLength = 80;
    private static readonly Regex SnapshotId = new("^[0-9]{8}-[0-9]{9}-[0-9a-f]{6}$", RegexOptions.Compiled);

    private readonly string _root;
    private readonly object _gate = new();

    public DocumentHistory(string dataFolder) => _root = Path.Combine(dataFolder, "history");

    public IReadOnlyList<Snapshot> List(string documentPath)
    {
        lock (_gate) return Load(FolderFor(documentPath)).OrderByDescending(s => s.CreatedAt).ToList();
    }

    /// <summary>Copies the document as it is on disk into a new snapshot.</summary>
    public Snapshot Create(string documentPath, string? name)
    {
        var full = Path.GetFullPath(documentPath);
        if (!File.Exists(full)) throw new FileNotFoundException("The document isn’t on disk, so there’s nothing to keep yet. Save it first.");
        var bytes = ReadShared(full);
        var clean = CleanName(name);
        lock (_gate)
        {
            var folder = FolderFor(full);
            Directory.CreateDirectory(folder);
            var now = DateTimeOffset.Now;
            var snapshot = new Snapshot
            {
                Id = $"{now:yyyyMMdd}-{now:HHmmssfff}-{RandomNumberGenerator.GetHexString(6, lowercase: true)}",
                Name = clean,
                CreatedAt = now,
                Size = bytes.Length,
            };
            var file = Path.Combine(folder, snapshot.Id + ".pdf");
            using (var stream = new FileStream(file, FileMode.CreateNew, FileAccess.Write, FileShare.None))
            {
                stream.Write(bytes);
                stream.Flush(flushToDisk: true);
            }
            try
            {
                var list = Load(folder);
                list.Add(snapshot);
                Save(folder, full, list);
            }
            catch
            {
                File.Delete(file);
                throw;
            }
            return snapshot;
        }
    }

    /// <summary>The snapshot's file, for opening read-only, comparing or restoring from.</summary>
    public (Snapshot Snapshot, string File) Get(string documentPath, string id)
    {
        if (!SnapshotId.IsMatch(id)) throw new ArgumentException("Invalid snapshot.");
        lock (_gate)
        {
            var folder = FolderFor(documentPath);
            var snapshot = Load(folder).FirstOrDefault(s => s.Id == id) ?? throw new FileNotFoundException("That snapshot is no longer in this document’s history.");
            var file = Path.Combine(folder, id + ".pdf");
            if (!File.Exists(file)) throw new FileNotFoundException("That snapshot’s file is missing.");
            return (snapshot, file);
        }
    }

    public void Delete(string documentPath, string id)
    {
        if (!SnapshotId.IsMatch(id)) throw new ArgumentException("Invalid snapshot.");
        lock (_gate)
        {
            var full = Path.GetFullPath(documentPath);
            var folder = FolderFor(full);
            var list = Load(folder);
            if (list.RemoveAll(s => s.Id == id) == 0) return;
            Save(folder, full, list);
            var file = Path.Combine(folder, id + ".pdf");
            if (File.Exists(file)) File.Delete(file);
            if (list.Count == 0) Directory.Delete(folder, recursive: true);
        }
    }

    public static string CleanName(string? name)
    {
        var text = new string((name ?? "").Where(c => !char.IsControl(c)).ToArray()).Trim();
        return text.Length > MaxNameLength ? text[..MaxNameLength].TrimEnd() : text;
    }

    private string FolderFor(string documentPath)
    {
        var key = SHA256.HashData(Encoding.UTF8.GetBytes(Path.GetFullPath(documentPath).ToUpperInvariant()));
        return Path.Combine(_root, Convert.ToHexString(key)[..32]);
    }

    private sealed class Index
    {
        public int Version { get; set; } = 1;
        public string Path { get; set; } = "";
        public List<Snapshot> Snapshots { get; set; } = [];
    }

    private static List<Snapshot> Load(string folder)
    {
        var file = Path.Combine(folder, "index.json");
        if (!File.Exists(file)) return [];
        var index = JsonSerializer.Deserialize<Index>(File.ReadAllText(file), BridgeHost.Json);
        return index?.Snapshots ?? [];
    }

    private static void Save(string folder, string documentPath, List<Snapshot> list)
    {
        var file = Path.Combine(folder, "index.json");
        var temp = file + ".tmp";
        File.WriteAllText(temp, JsonSerializer.Serialize(new Index { Path = documentPath, Snapshots = list }, BridgeHost.Json));
        File.Move(temp, file, overwrite: true);
    }

    private static byte[] ReadShared(string path)
    {
        using var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
        using var ms = new MemoryStream();
        fs.CopyTo(ms);
        return ms.ToArray();
    }
}
