using System.IO;
using System.Text.Json;
using Microsoft.Win32;
using Vellum.Hosting;
using Vellum.Services;

namespace Vellum;

// Export Center V1: the host half of exporting a document to files that are not PDFs (images, Markdown).
// The page decides what to write and what to call it; the host decides where it may be written and hands
// back one write token per file (AppResourceServer /export/{token}, written atomically). Nothing here
// reads, parses or renders a PDF, and the document being exported is never opened for writing.
//
// A folder is allowed only when the person chose it here ("export.folder"), or when it already holds a
// document the page was given to open or save — so an export lands beside the document by default without
// a dialog, and anywhere else only after the person picked it. File names are the page's, cleaned again
// here (Services/ExportTargets.cs): no path separators, no invalid characters, never outside the chosen
// folder, and never a file the page may only read (a batch's source, a history snapshot).
public partial class MainWindow
{
    /// <summary>Folders the person picked in this session's export dialogs.</summary>
    private readonly HashSet<string> _exportFolders = new(StringComparer.OrdinalIgnoreCase);

    private void RegisterExportHandlers(BridgeHost bridge)
    {
        // "Choose folder…": the picked folder becomes writable for exports for the rest of the session.
        bridge.Register("export.folder", request =>
        {
            var current = OptionalString(request, "folder");
            var dialog = new OpenFolderDialog
            {
                Title = "Choose a folder for the exported files",
                InitialDirectory = current is not null && Directory.Exists(current) ? current : LastFolder(),
            };
            if (dialog.ShowDialog(this) != true) return Done(new { folder = (string?)null });
            var folder = Path.GetFullPath(dialog.FolderName);
            _exportFolders.Add(folder);
            return Done(new { folder });
        });

        // The files an export will write. `probe` only reports which names are already taken; otherwise each
        // file gets a write token. overwrite: "replace" writes over what is there, "keepBoth" numbers the name.
        bridge.Register("export.targets", request =>
        {
            var folder = ExportFolder(request);
            var names = StringList(request, "names");
            if (names.Length == 0) throw new ArgumentException("No files to export.");
            var probe = OptionalBool(request, "probe") == true;
            var keepBoth = OptionalString(request, "overwrite") == "keepBoth";
            var taken = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            var files = names.Select(requested =>
            {
                var exists = File.Exists(Path.Combine(folder, ExportTargets.CleanName(requested)));
                var path = ExportTargets.Resolve(folder, requested, keepBoth, taken, _server!.IsReadOnly);
                return new
                {
                    name = Path.GetFileName(path),
                    path,
                    exists,
                    token = probe ? null : _server!.RegisterExportFile(path),
                };
            }).ToArray();
            return Done(new { folder, files });
        });
    }

    /// <summary>The folder an export may write to, or an error saying why it may not.</summary>
    private string ExportFolder(BridgeRequest request)
    {
        var folder = Path.GetFullPath(RequiredString(request, "folder"));
        if (!Directory.Exists(folder)) throw new DirectoryNotFoundException("That folder doesn’t exist any more. Choose another one.");
        if (!_exportFolders.Contains(folder) && !_server!.IsKnownFolder(folder))
            throw new InvalidOperationException("Vellum can only export to a folder you chose, or to the folder the document is in.");
        return folder;
    }

    private static string[] StringList(BridgeRequest request, string key) =>
        request.Payload.ValueKind == JsonValueKind.Object && request.Payload.TryGetProperty(key, out var list) && list.ValueKind == JsonValueKind.Array
            ? list.EnumerateArray().Select(n => n.GetString() ?? "").Where(n => n.Length > 0).ToArray()
            : [];
}
