using System.IO;
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
}

/// <summary>Recently opened files, kept in %LOCALAPPDATA%\Vellum\recent.json.</summary>
public sealed class RecentFiles
{
    private const int MaxEntries = 30;

    private readonly string _file;
    private readonly object _gate = new();
    private readonly List<RecentEntry> _entries;

    public RecentFiles(string folder)
    {
        _file = System.IO.Path.Combine(folder, "recent.json");
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
        lock (_gate)
        {
            var entry = _entries.FirstOrDefault(e => Same(e.Path, path));
            if (entry is not null) _entries.Remove(entry);
            entry ??= new RecentEntry { Path = System.IO.Path.GetFullPath(path) };
            entry.OpenedAt = DateTimeOffset.Now;
            _entries.Insert(0, entry);
            if (_entries.Count > MaxEntries) _entries.RemoveRange(MaxEntries, _entries.Count - MaxEntries);
        }
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

    public void Remove(string path)
    {
        lock (_gate) _entries.RemoveAll(e => Same(e.Path, path));
        Save();
    }

    public void Clear()
    {
        lock (_gate) _entries.Clear();
        Save();
    }

    private static bool Same(string a, string b) => string.Equals(a, b, StringComparison.OrdinalIgnoreCase);

    private List<RecentEntry> Load()
    {
        try
        {
            return File.Exists(_file)
                ? JsonSerializer.Deserialize<List<RecentEntry>>(File.ReadAllText(_file), BridgeHost.Json) ?? []
                : [];
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
