using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Vellum.Hosting;

namespace Vellum.Services;

public sealed class RecentEntry
{
    public string Path { get; set; } = "";
    public DateTimeOffset OpenedAt { get; set; }
    /// <summary>Where you were when you last had it open, so it reopens in the same spot.</summary>
    public int? Page { get; set; }
    public string? ScaleValue { get; set; }
    public string? ViewMode { get; set; }
    /// <summary>Page count when it was last open (shown on the home screen).</summary>
    public int? Pages { get; set; }
}

/// <summary>
/// Recently opened files, kept in %LOCALAPPDATA%\Vellum\recent.json, with a small picture of each
/// file's first page in ...\covers (drawn by the page when the file is open; shown on the home screen).
/// </summary>
public sealed class RecentFiles
{
    private const int MaxEntries = 30;
    private const int MaxCoverBytes = 400_000;

    private readonly string _file;
    private readonly string _covers;
    private readonly object _gate = new();
    private readonly List<RecentEntry> _entries;

    public RecentFiles(string folder)
    {
        _file = System.IO.Path.Combine(folder, "recent.json");
        _covers = System.IO.Path.Combine(folder, "covers");
        _entries = Load();
    }

    public IReadOnlyList<RecentEntry> Entries
    {
        get { lock (_gate) return _entries.ToList(); }
    }

    public RecentEntry? Find(string path)
    {
        lock (_gate) return _entries.FirstOrDefault(e => Same(e.Path, path));
    }

    /// <summary>Moves (or adds) a file to the top of the list.</summary>
    public void Touch(string path)
    {
        List<RecentEntry> dropped;
        lock (_gate)
        {
            var entry = _entries.FirstOrDefault(e => Same(e.Path, path));
            if (entry is not null) _entries.Remove(entry);
            entry ??= new RecentEntry { Path = System.IO.Path.GetFullPath(path) };
            entry.OpenedAt = DateTimeOffset.Now;
            _entries.Insert(0, entry);
            dropped = _entries.Skip(MaxEntries).ToList();
            if (dropped.Count > 0) _entries.RemoveRange(MaxEntries, dropped.Count);
        }
        foreach (var old in dropped) DeleteCover(old.Path);
        Save();
    }

    public void UpdatePosition(string path, int? page, string? scaleValue, string? viewMode)
    {
        lock (_gate)
        {
            var entry = _entries.FirstOrDefault(e => Same(e.Path, path));
            if (entry is null) return;
            entry.Page = page;
            entry.ScaleValue = scaleValue;
            entry.ViewMode = viewMode;
        }
        Save();
    }

    /// <summary>Stores the first-page picture (a JPEG) and page count of a file in the list.</summary>
    public void SetCover(string path, byte[] jpeg, int? pages)
    {
        if (jpeg.Length is 0 or > MaxCoverBytes || jpeg[0] != 0xFF || jpeg[1] != 0xD8)
            throw new ArgumentException("Invalid cover image.");
        lock (_gate)
        {
            var entry = _entries.FirstOrDefault(e => Same(e.Path, path));
            if (entry is null) return;
            if (pages is > 0) entry.Pages = pages;
        }
        try
        {
            Directory.CreateDirectory(_covers);
            var target = CoverPath(path);
            File.WriteAllBytes(target + ".tmp", jpeg);
            File.Move(target + ".tmp", target, overwrite: true);
        }
        catch (IOException) { /* best effort: the home screen shows an icon instead */ }
        catch (UnauthorizedAccessException) { }
        Save();
    }

    /// <summary>The stored first-page picture as a data URL, or null.</summary>
    public string? CoverDataUrl(string path)
    {
        try
        {
            var file = CoverPath(path);
            return File.Exists(file) ? "data:image/jpeg;base64," + Convert.ToBase64String(File.ReadAllBytes(file)) : null;
        }
        catch (IOException) { return null; }
        catch (UnauthorizedAccessException) { return null; }
    }

    public void Remove(string path)
    {
        lock (_gate) _entries.RemoveAll(e => Same(e.Path, path));
        DeleteCover(path);
        Save();
    }

    public void Clear()
    {
        lock (_gate) _entries.Clear();
        try
        {
            if (Directory.Exists(_covers)) Directory.Delete(_covers, recursive: true);
        }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
        Save();
    }

    private static bool Same(string a, string b) => string.Equals(a, b, StringComparison.OrdinalIgnoreCase);

    /// <summary>Covers are named by a hash of the path, so no file name ever comes from the page.</summary>
    private string CoverPath(string path) => System.IO.Path.Combine(_covers,
        Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(path.ToLowerInvariant())))[..32] + ".jpg");

    private void DeleteCover(string path)
    {
        try { File.Delete(CoverPath(path)); }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
    }

    private List<RecentEntry> Load()
    {
        try
        {
            if (!File.Exists(_file)) return [];
            var entries = JsonSerializer.Deserialize<List<RecentEntry?>>(File.ReadAllText(_file), BridgeHost.Json) ?? [];
            // An entry without a path (a hand-edited or damaged list) would show as a nameless card.
            return entries.OfType<RecentEntry>().Where(e => !string.IsNullOrWhiteSpace(e.Path)).ToList();
        }
        catch (Exception)
        {
            return []; // a corrupt list just starts over
        }
    }

    private void Save()
    {
        string json;
        lock (_gate) json = JsonSerializer.Serialize(_entries, BridgeHost.Json);
        try
        {
            Directory.CreateDirectory(System.IO.Path.GetDirectoryName(_file)!);
            var temp = _file + ".tmp";
            File.WriteAllText(temp, json);
            File.Move(temp, _file, overwrite: true);
        }
        catch (IOException) { /* best effort; not worth interrupting reading */ }
        catch (UnauthorizedAccessException) { }
    }
}
