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

/// <summary>One document's history as kept on this PC, for Settings: which document, how much, how recent.</summary>
public sealed class StoredHistory
{
    /// <summary>The history folder's name in Vellum's data folder; it stands for the document in requests.</summary>
    public string Key { get; set; } = "";
    /// <summary>The document's full path when its snapshots were taken; empty when the index can't be read.</summary>
    public string Path { get; set; } = "";
    public string Name { get; set; } = "";
    public int Count { get; set; }
    /// <summary>What the history folder takes up on disk.</summary>
    public long Size { get; set; }
    public DateTimeOffset? LastSnapshot { get; set; }
    /// <summary>Nothing is at the document's path any more (or it isn't known): the history can only be removed.</summary>
    public bool Missing { get; set; }
}

/// <summary>What became of a document's history when it moved to a new path.</summary>
public enum HistoryMove
{
    /// <summary>The document had no history to move.</summary>
    None,
    Moved,
    /// <summary>The new path has history of its own: neither history was changed.</summary>
    Conflict,
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
    private static readonly Regex HistoryKey = new("^[0-9A-F]{32}$", RegexOptions.Compiled);

    private readonly string _root;
    private readonly object _gate = new();

    public DocumentHistory(string dataFolder) => _root = Path.Combine(dataFolder, "history");

    public IReadOnlyList<Snapshot> List(string documentPath)
    {
        lock (_gate)
        {
            var folder = FolderFor(documentPath);
            var list = Load(folder);
            // The size on disk is what the snapshot takes up; the size kept in the index stands in if the file is gone.
            foreach (var snapshot in list)
            {
                var file = new FileInfo(Path.Combine(folder, snapshot.Id + ".pdf"));
                if (file.Exists) snapshot.Size = file.Length;
            }
            return list.OrderByDescending(s => s.CreatedAt).ToList();
        }
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

    /// <summary>
    /// Removes every snapshot of the document: its history folder in Vellum's data folder goes, nothing else.
    /// The document itself is never touched. Returns how many snapshots were removed.
    /// </summary>
    public int Clear(string documentPath)
    {
        lock (_gate) return RemoveFolder(FolderFor(documentPath));
    }

    /// <summary>
    /// The document now lives at <paramref name="to"/> (Save As): its history goes with it, snapshots as they
    /// are (same files, names, times and sizes), and the old path keeps none. Nothing moves when the document
    /// has no history, and nothing is merged: when <paramref name="to"/> already has history of its own, both
    /// stay as they are and <see cref="HistoryMove.Conflict"/> is returned. Documents themselves are never touched.
    /// </summary>
    public HistoryMove Move(string from, string to)
    {
        var fromFull = Path.GetFullPath(from);
        var toFull = Path.GetFullPath(to);
        lock (_gate)
        {
            var source = FolderFor(fromFull);
            var target = FolderFor(toFull);
            if (string.Equals(source, target, StringComparison.OrdinalIgnoreCase) || !Directory.Exists(source)) return HistoryMove.None;
            // Only this document's own history moves: the folder's index must name the path it was taken for.
            var index = ReadIndex(source);
            if (index is null || index.Path.Length == 0 || !string.Equals(FolderFor(index.Path), source, StringComparison.OrdinalIgnoreCase))
                return HistoryMove.None;
            if (Directory.Exists(target)) return HistoryMove.Conflict;
            Directory.Move(source, target);
            try
            {
                Save(target, toFull, index.Snapshots);
            }
            catch
            {
                Directory.Move(target, source);
                throw;
            }
            return HistoryMove.Moved;
        }
    }

    /// <summary>
    /// Every document with history on this PC, newest snapshot first, read from Vellum's own data folder only.
    /// A document counts as missing when nothing is at its path any more.
    /// </summary>
    public IReadOnlyList<StoredHistory> Stored()
    {
        lock (_gate)
        {
            if (!Directory.Exists(_root)) return [];
            var list = new List<StoredHistory>();
            foreach (var folder in Directory.EnumerateDirectories(_root))
            {
                var key = Path.GetFileName(folder);
                if (!HistoryKey.IsMatch(key)) continue;
                var files = new DirectoryInfo(folder).GetFiles();
                var path = "";
                var snapshots = new List<Snapshot>();
                try
                {
                    var index = ReadIndex(folder);
                    path = index?.Path ?? "";
                    snapshots = index?.Snapshots ?? [];
                }
                catch (Exception e) when (e is IOException or JsonException or UnauthorizedAccessException)
                {
                    // An index that can't be read: its snapshot files still count, the document isn't known.
                }
                var pdfs = files.Count(f => f.Extension.Equals(".pdf", StringComparison.OrdinalIgnoreCase));
                list.Add(new StoredHistory
                {
                    Key = key,
                    Path = path,
                    Name = path.Length > 0 ? Path.GetFileName(path) : "Unknown document",
                    Count = snapshots.Count > 0 ? snapshots.Count : pdfs,
                    Size = files.Sum(f => f.Length),
                    LastSnapshot = snapshots.Count > 0 ? snapshots.Max(s => s.CreatedAt)
                        : files.Length > 0 ? files.Max(f => new DateTimeOffset(f.LastWriteTime)) : null,
                    Missing = path.Length == 0 || !File.Exists(path),
                });
            }
            return list.OrderByDescending(s => s.LastSnapshot ?? DateTimeOffset.MinValue).ToList();
        }
    }

    /// <summary>The document a stored history belongs to, when it is still on disk: to open its history dialog.</summary>
    public string DocumentFor(string key)
    {
        lock (_gate)
        {
            var folder = KeyFolder(key);
            var path = ReadIndex(folder)?.Path ?? "";
            // The index must be this folder's own: the folder is named after the document's path.
            if (path.Length == 0 || !string.Equals(FolderFor(path), folder, StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("This history doesn’t say which document it belongs to.");
            if (!File.Exists(path)) throw new FileNotFoundException("The document is no longer there. Its history can only be removed.");
            return path;
        }
    }

    /// <summary>
    /// Removes one document's history by its key: that history folder goes, nothing else, never the document.
    /// With <paramref name="onlyIfMissing"/>, only while its document is gone. Returns how many snapshots went.
    /// </summary>
    public int RemoveStored(string key, bool onlyIfMissing = false)
    {
        lock (_gate)
        {
            var folder = KeyFolder(key);
            return onlyIfMissing && !IsMissing(folder) ? 0 : RemoveFolder(folder);
        }
    }

    /// <summary>Removes the history of every document no longer on disk. Returns how many histories went.</summary>
    public int RemoveMissing()
    {
        lock (_gate)
        {
            if (!Directory.Exists(_root)) return 0;
            var removed = 0;
            foreach (var folder in Directory.EnumerateDirectories(_root))
            {
                if (!HistoryKey.IsMatch(Path.GetFileName(folder)) || !IsMissing(folder)) continue;
                RemoveFolder(folder);
                removed++;
            }
            return removed;
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

    private string KeyFolder(string key)
    {
        if (!HistoryKey.IsMatch(key ?? "")) throw new ArgumentException("Invalid history.");
        return Path.Combine(_root, key!);
    }

    private static bool IsMissing(string folder)
    {
        try
        {
            var path = ReadIndex(folder)?.Path ?? "";
            return path.Length == 0 || !File.Exists(path);
        }
        catch (Exception e) when (e is IOException or JsonException or UnauthorizedAccessException)
        {
            return true;
        }
    }

    /// <summary>Deletes one history folder, and only ever a folder directly inside Vellum's history folder.</summary>
    private int RemoveFolder(string folder)
    {
        var full = Path.GetFullPath(folder);
        if (!string.Equals(Path.GetDirectoryName(full), Path.GetFullPath(_root), StringComparison.OrdinalIgnoreCase)
            || !HistoryKey.IsMatch(Path.GetFileName(full)))
            throw new InvalidOperationException("That isn’t a history folder.");
        if (!Directory.Exists(full)) return 0;
        int count;
        try { count = Load(full).Count; }
        catch (Exception e) when (e is IOException or JsonException) { count = Directory.GetFiles(full, "*.pdf").Length; }
        Directory.Delete(full, recursive: true);
        return count;
    }

    private sealed class Index
    {
        public int Version { get; set; } = 1;
        public string Path { get; set; } = "";
        public List<Snapshot> Snapshots { get; set; } = [];
    }

    private static List<Snapshot> Load(string folder) => ReadIndex(folder)?.Snapshots ?? [];

    private static Index? ReadIndex(string folder)
    {
        var file = Path.Combine(folder, "index.json");
        return File.Exists(file) ? JsonSerializer.Deserialize<Index>(File.ReadAllText(file), BridgeHost.Json) : null;
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
