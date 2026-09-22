using System.IO;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Vellum.Services;

public sealed class DocumentCollection
{
    public string Id { get; set; } = "";
    public string Name { get; set; } = "";
    public DateTimeOffset CreatedAt { get; set; }
    /// <summary>Full paths of the PDFs in the collection, in the order they were added. The files are never copied.</summary>
    public List<string> Paths { get; set; } = [];
}

/// <summary>
/// Named collections of documents, kept in %LOCALAPPDATA%\Vellum\collections.json. A collection only lists
/// file paths: adding, removing, renaming or deleting never touches a PDF, and a file that is gone stays listed
/// (shown as missing) until it is removed.
/// </summary>
public sealed class DocumentCollections
{
    public const int MaxNameLength = 80;

    private static readonly JsonSerializerOptions Json = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        WriteIndented = true,
    };

    private readonly string _file;
    private readonly object _gate = new();
    private readonly List<DocumentCollection> _collections;

    public DocumentCollections(string folder)
    {
        _file = Path.Combine(folder, "collections.json");
        _collections = Load();
    }

    /// <summary>A copy of every collection, in the order they were made.</summary>
    public IReadOnlyList<DocumentCollection> All
    {
        get
        {
            lock (_gate) return _collections.Select(c => new DocumentCollection { Id = c.Id, Name = c.Name, CreatedAt = c.CreatedAt, Paths = [.. c.Paths] }).ToList();
        }
    }

    /// <summary>True if any collection lists this file.</summary>
    public bool Contains(string path)
    {
        lock (_gate) return _collections.Any(c => c.Paths.Any(p => Same(p, path)));
    }

    public DocumentCollection Create(string name)
    {
        var clean = CleanName(name);
        DocumentCollection created;
        lock (_gate)
        {
            if (_collections.Any(c => Same(c.Name, clean))) throw new InvalidOperationException($"There is already a collection called “{clean}”.");
            created = new DocumentCollection { Id = Guid.NewGuid().ToString("N"), Name = clean, CreatedAt = DateTimeOffset.Now };
            _collections.Add(created);
        }
        Save();
        return created;
    }

    public void Rename(string id, string name)
    {
        var clean = CleanName(name);
        lock (_gate)
        {
            var collection = Get(id);
            if (_collections.Any(c => c != collection && Same(c.Name, clean))) throw new InvalidOperationException($"There is already a collection called “{clean}”.");
            collection.Name = clean;
        }
        Save();
    }

    /// <summary>Deletes the collection only; its documents stay where they are.</summary>
    public void Delete(string id)
    {
        lock (_gate) _collections.Remove(Get(id));
        Save();
    }

    /// <summary>Adds files to a collection. Returns how many were new (a file already in it isn't added twice).</summary>
    public int Add(string id, IEnumerable<string> paths)
    {
        var added = 0;
        lock (_gate)
        {
            var collection = Get(id);
            foreach (var path in paths)
            {
                var full = Path.GetFullPath(path);
                if (collection.Paths.Any(p => Same(p, full))) continue;
                collection.Paths.Add(full);
                added++;
            }
        }
        if (added > 0) Save();
        return added;
    }

    /// <summary>Takes a file out of a collection. The file itself isn't touched.</summary>
    public void Remove(string id, string path)
    {
        lock (_gate) Get(id).Paths.RemoveAll(p => Same(p, path));
        Save();
    }

    private DocumentCollection Get(string id) =>
        _collections.FirstOrDefault(c => c.Id == id) ?? throw new InvalidOperationException("That collection no longer exists.");

    private static string CleanName(string name)
    {
        var clean = string.Join(' ', (name ?? "").Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries));
        if (clean.Length == 0) throw new ArgumentException("A collection needs a name.");
        if (clean.Length > MaxNameLength) throw new ArgumentException($"A collection name can be at most {MaxNameLength} characters.");
        return clean;
    }

    private static bool Same(string a, string b) => string.Equals(a, b, StringComparison.OrdinalIgnoreCase);

    private List<DocumentCollection> Load()
    {
        try
        {
            if (!File.Exists(_file)) return [];
            var loaded = JsonSerializer.Deserialize<List<DocumentCollection?>>(File.ReadAllText(_file), Json) ?? [];
            // A hand-edited or damaged file: nameless collections and empty paths are dropped, duplicates merged.
            return loaded.OfType<DocumentCollection>()
                .Where(c => !string.IsNullOrWhiteSpace(c.Id) && !string.IsNullOrWhiteSpace(c.Name))
                .Select(c =>
                {
                    c.Paths = (c.Paths ?? []).Where(p => !string.IsNullOrWhiteSpace(p)).Distinct(StringComparer.OrdinalIgnoreCase).ToList();
                    return c;
                })
                .ToList();
        }
        catch (Exception)
        {
            // A corrupt file starts over, but is kept beside it so nothing a person made is lost for good.
            try { File.Copy(_file, _file + ".bad", overwrite: true); } catch (Exception) { }
            return [];
        }
    }

    private void Save()
    {
        string json;
        lock (_gate) json = JsonSerializer.Serialize(_collections, Json);
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
