using System.IO;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;

namespace Vellum.Services;

public sealed class SavedResearchItem
{
    public string Id { get; set; } = "";
    public string Name { get; set; } = "";
    public DateTimeOffset CreatedAt { get; set; }
    /// <summary>Full paths of the documents the evidence was quoted from. The files are never copied or opened here.</summary>
    public List<string> Paths { get; set; } = [];
    /// <summary>The result exactly as the page saved it (semantic/saved-research.js). The host never reads inside it.</summary>
    public JsonNode? Result { get; set; }
}

/// <summary>
/// Research results a person chose to keep, in %LOCALAPPDATA%\Vellum\research.json, beside the recent list and
/// the collections. A saved item is the result as the page made it — the question, what was asked of, the
/// ranked evidence and its provenance — kept as it stands and given back unchanged: opening one never runs the
/// research again. The host stores the result whole and only reads the names and the document paths it is told,
/// so the shape of a result stays the page's business.
///
/// No PDF is read, copied or changed: a saved item lists paths, and a file that is gone stays listed (shown as
/// missing) until the item is deleted.
/// </summary>
public sealed class SavedResearch
{
    public const int MaxNameLength = 80;
    /// <summary>A result bigger than this is refused: a saved result is one ranked list, not a document copy.</summary>
    public const int MaxResultLength = 512 * 1024;
    public const int MaxItems = 500;

    private static readonly JsonSerializerOptions Json = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        WriteIndented = true,
    };

    private readonly string _file;
    private readonly object _gate = new();
    private readonly List<SavedResearchItem> _items;

    public SavedResearch(string folder)
    {
        _file = Path.Combine(folder, "research.json");
        _items = Load();
    }

    /// <summary>A copy of every saved research, newest first.</summary>
    public IReadOnlyList<SavedResearchItem> All
    {
        get
        {
            lock (_gate)
            {
                return _items
                    .OrderByDescending(i => i.CreatedAt)
                    .Select(i => new SavedResearchItem { Id = i.Id, Name = i.Name, CreatedAt = i.CreatedAt, Paths = [.. i.Paths], Result = i.Result?.DeepClone() })
                    .ToList();
            }
        }
    }

    /// <summary>True if any saved research quotes this file — what lets the page reopen it at a page.</summary>
    public bool Contains(string path)
    {
        lock (_gate) return _items.Any(i => i.Paths.Any(p => Same(p, path)));
    }

    /// <summary>
    /// Keeps one result under a name. `result` is stored as it is given; `paths` are the documents it quotes,
    /// so a missing file can be shown as missing without looking inside the result.
    /// </summary>
    public SavedResearchItem Save(string name, IEnumerable<string> paths, JsonNode? result)
    {
        var clean = CleanName(name);
        if (result is null) throw new ArgumentException("There is no research result to save.");
        if (result.ToJsonString().Length > MaxResultLength) throw new ArgumentException("That research result is too large to save.");
        var files = (paths ?? []).Where(p => !string.IsNullOrWhiteSpace(p)).Select(Full).Distinct(StringComparer.OrdinalIgnoreCase).ToList();
        SavedResearchItem saved;
        lock (_gate)
        {
            if (_items.Count >= MaxItems) throw new InvalidOperationException($"Vellum keeps at most {MaxItems} saved research results. Delete one first.");
            saved = new SavedResearchItem { Id = Guid.NewGuid().ToString("N"), Name = clean, CreatedAt = DateTimeOffset.Now, Paths = files, Result = result.DeepClone() };
            _items.Add(saved);
        }
        Save();
        return saved;
    }

    /// <summary>Removes that saved research only. Nothing else is touched — no document, no collection, no other item.</summary>
    public void Delete(string id)
    {
        lock (_gate)
        {
            var item = _items.FirstOrDefault(i => i.Id == id) ?? throw new InvalidOperationException("That saved research no longer exists.");
            _items.Remove(item);
        }
        Save();
    }

    private static string Full(string path)
    {
        try { return Path.GetFullPath(path); } catch (Exception) { return path; }
    }

    private static string CleanName(string name)
    {
        var clean = string.Join(' ', (name ?? "").Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries));
        if (clean.Length == 0) throw new ArgumentException("Saved research needs a name.");
        if (clean.Length > MaxNameLength) throw new ArgumentException($"A name can be at most {MaxNameLength} characters.");
        return clean;
    }

    private static bool Same(string a, string b) => string.Equals(a, b, StringComparison.OrdinalIgnoreCase);

    private List<SavedResearchItem> Load()
    {
        try
        {
            if (!File.Exists(_file)) return [];
            var loaded = JsonSerializer.Deserialize<List<SavedResearchItem?>>(File.ReadAllText(_file), Json) ?? [];
            // A hand-edited or damaged file: an item without an id, a name or a result is dropped rather than
            // shown as an empty result, and the ones that are whole still open.
            return loaded.OfType<SavedResearchItem>()
                .Where(i => !string.IsNullOrWhiteSpace(i.Id) && !string.IsNullOrWhiteSpace(i.Name) && i.Result is not null)
                .GroupBy(i => i.Id, StringComparer.Ordinal)
                .Select(g => g.First())
                .Select(i =>
                {
                    i.Paths = (i.Paths ?? []).Where(p => !string.IsNullOrWhiteSpace(p)).Distinct(StringComparer.OrdinalIgnoreCase).ToList();
                    return i;
                })
                .ToList();
        }
        catch (Exception)
        {
            // A corrupt file starts over, but is kept beside it so nothing a person saved is lost for good.
            try { File.Copy(_file, _file + ".bad", overwrite: true); } catch (Exception) { }
            return [];
        }
    }

    private void Save()
    {
        string json;
        lock (_gate) json = JsonSerializer.Serialize(_items, Json);
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(_file)!);
            var temp = _file + ".tmp";
            File.WriteAllText(temp, json);
            File.Move(temp, _file, overwrite: true);
        }
        catch (IOException) { /* best effort; not worth interrupting reading */ }
        catch (UnauthorizedAccessException) { }
    }
}
