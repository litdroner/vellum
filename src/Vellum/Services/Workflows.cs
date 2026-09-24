using System.IO;
using System.Text.Json;

namespace Vellum.Services;

/// <summary>
/// Saved workflows (Vellum Flow), kept in %LOCALAPPDATA%\Vellum\workflows.json. What a workflow is, and whether
/// each one can run, is the page's (web/js/flow/model.js reads and checks the list, forgivingly); the host keeps
/// the file whole: it takes only a JSON object holding a "workflows" list, at most <see cref="MaxBytes"/>, and
/// writes it atomically. A file that isn't one (damaged, or edited by hand) is kept beside it as
/// workflows.json.bad before a new list may replace it, so nothing a person made is lost for good.
/// A workflow names operations and their settings only: no document content and no file paths.
/// </summary>
public sealed class WorkflowStore
{
    /// <summary>Far more than a hundred workflows of a dozen steps take.</summary>
    public const int MaxBytes = 512 * 1024;

    private readonly string _file;
    private readonly object _gate = new();

    public WorkflowStore(string folder) => _file = Path.Combine(folder, "workflows.json");

    public string FilePath => _file;

    /// <summary>
    /// The saved list as JSON text (null when nothing is saved), and whether the file was damaged — then it has
    /// been copied to workflows.json.bad and the list reads as empty. A file that can't be read at all (locked)
    /// throws, so the page never writes over something it didn't see.
    /// </summary>
    public (string? Json, bool Damaged) Load()
    {
        lock (_gate)
        {
            if (!File.Exists(_file)) return (null, false);
            var text = File.ReadAllText(_file);
            if (IsWorkflowList(text)) return (text, false);
            try { File.Copy(_file, _file + ".bad", overwrite: true); } catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { }
            return (null, true);
        }
    }

    /// <summary>Replaces the saved list with `json`, which must be a workflow list; atomically (a temp file, then a move).</summary>
    public void Save(string json)
    {
        if (json.Length > MaxBytes) throw new ArgumentException("That’s more workflows than Vellum keeps.");
        if (!IsWorkflowList(json)) throw new ArgumentException("That isn’t a list of workflows.");
        lock (_gate)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(_file)!);
            var temp = _file + ".tmp";
            File.WriteAllText(temp, json);
            File.Move(temp, _file, overwrite: true);
        }
    }

    /// <summary>A JSON object with a "workflows" array: the one shape the file may have.</summary>
    public static bool IsWorkflowList(string text)
    {
        try
        {
            using var doc = JsonDocument.Parse(text);
            return doc.RootElement.ValueKind == JsonValueKind.Object
                && doc.RootElement.TryGetProperty("workflows", out var list) && list.ValueKind == JsonValueKind.Array;
        }
        catch (JsonException) { return false; }
    }
}
