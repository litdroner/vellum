using System.IO;
using System.Text.Json;
using Vellum.Hosting;
using Vellum.Services;
using Vellum.Services.Conversion;

namespace Vellum;

// Workflows (Vellum Flow): the host half. The page composes and runs workflows (web/js/flow/), through the same
// operations and batch runner as batch processing; the host keeps the saved list and hands over the PDF an Office
// step makes in the middle of a workflow:
//
//   flow.load       the saved list (Services/Workflows.cs), as JSON; damaged: the file was kept as .bad
//   flow.save       replaces the saved list (a JSON object with a "workflows" array), atomically
//   batch.release   lets go of a held PDF: batch.office with hold converts into a work folder of Vellum's own
//                   (flow-work, under the data folder) and registers the PDF read-only for the page to read; once
//                   read, it is forgotten and deleted. Anything left behind is removed when Vellum next starts.
public partial class MainWindow
{
    private readonly WorkflowStore _workflows = new(DataFolder);

    /// <summary>
    /// Where held PDFs are converted to: one folder per conversion, removed when released. A property, not a
    /// field: another partial file's static fields (DataFolder) may not be set yet when this one would be.
    /// </summary>
    private static string HeldRoot => Path.Combine(DataFolder, "flow-work");

    /// <summary>The tokens of held PDFs not yet released.</summary>
    private readonly HashSet<string> _heldFiles = new(StringComparer.Ordinal);

    private void RegisterFlowHandlers(BridgeHost bridge)
    {
        bridge.Register("flow.load", async _ =>
        {
            var (json, damaged) = await Task.Run(_workflows.Load);
            JsonElement? data = null;
            if (json is not null)
            {
                using var doc = JsonDocument.Parse(json);
                data = doc.RootElement.Clone();
            }
            return (object?)new { data, damaged };
        });

        bridge.Register("flow.save", async request =>
        {
            if (request.Payload.ValueKind != JsonValueKind.Object || !request.Payload.TryGetProperty("data", out var data))
                throw new ArgumentException("Missing 'data'.");
            var json = data.GetRawText();
            await Task.Run(() => _workflows.Save(json));
            return (object?)new { saved = true };
        });

        bridge.Register("batch.release", request =>
        {
            var token = RequiredString(request, "token");
            if (_heldFiles.Remove(token) && _server!.ResolveDocument(token) is { } path)
            {
                _server.Forget(token);
                DeleteHeld(path);
            }
            return Done(new { released = true });
        });
    }

    /// <summary>A new, empty place for one held PDF, named `name` (cleaned) in a folder of its own.</summary>
    private static string HeldPath(string name)
    {
        var clean = ExportTargets.CleanName(name);
        var folder = Path.Combine(HeldRoot, Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(folder);
        return Path.Combine(folder, clean);
    }

    /// <summary>A held conversion's result: the PDF, registered read-only for the page, or nothing left behind.</summary>
    private object HeldItem(ConversionResult result, string destination)
    {
        if (!result.Succeeded)
        {
            DeleteHeld(destination);
            return BatchItem(result);
        }
        var token = _server!.RegisterReadOnlyDocument(result.Output!);
        _heldFiles.Add(token);
        return BatchItem(result, new { name = Path.GetFileName(result.Output), path = result.Output, token, url = $"{AppResourceServer.Origin}/doc/{token}" });
    }

    /// <summary>Deletes a held PDF and its folder; only ever inside HeldRoot.</summary>
    private static void DeleteHeld(string path)
    {
        try
        {
            var folder = Path.GetDirectoryName(Path.GetFullPath(path));
            if (folder is null || !string.Equals(Path.GetDirectoryName(folder), Path.GetFullPath(HeldRoot), StringComparison.OrdinalIgnoreCase)) return;
            Directory.Delete(folder, recursive: true);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { /* swept at the next start */ }
    }

    /// <summary>Removes held PDFs an interrupted workflow left behind (at startup, before anything can hold one).</summary>
    private static void SweepHeld()
    {
        try
        {
            if (Directory.Exists(HeldRoot)) Directory.Delete(HeldRoot, recursive: true);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { /* next time */ }
    }
}
