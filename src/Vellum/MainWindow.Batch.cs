using System.IO;
using Microsoft.Win32;
using Vellum.Hosting;
using Vellum.Services;
using Vellum.Services.Conversion;

namespace Vellum;

// Batch processing: the host half. The page runs a batch (web/js/batch/) one file after another, through the
// operations in web/js/operations/registry.js; the host gives it files to work on and runs the operations that
// are its own. It adds no second way to convert, name or write a file:
//
//   batch.choose   the person picks the files (or a folder of them) in a Windows dialog. Each is registered
//                  read-only: the page may read it (/doc/{token}) and name it by its token, never write it, and
//                  nothing an export or a batch writes may land on it (Services/ExportTargets.cs).
//   batch.office   one item of Office → PDF: the office.toPdf operation (Services/Conversion) on a source chosen
//                  here, into the export destination contract (MainWindow.Export.cs: a folder the person chose
//                  or the source's own, a cleaned name, "replace" or "keepBoth"). One conversion at a time,
//                  shared with the Office tools; office.cancel stops it. Always a structured result. With hold (a
//                  workflow's step in between), the PDF goes to Vellum's own work folder instead and is handed over
//                  read-only by a token, until batch.release (MainWindow.Flow.cs).
//
// Files a batch makes from the page's own operations (Compress) are written through export.targets and the
// /export/{token} route, exactly as the single-document tools write theirs.
public partial class MainWindow
{
    /// <summary>More than anyone batches at once; a folder with more gives the first ones, and says so.</summary>
    private const int MostBatchFiles = 1000;

    /// <summary>The tokens of the files the person chose for a batch in this session.</summary>
    private readonly HashSet<string> _batchSources = new(StringComparer.Ordinal);

    private void RegisterBatchHandlers(BridgeHost bridge)
    {
        // accept: "pdf" or "office" (what the operation takes); folder: true picks a folder and takes the files
        // of that kind directly in it (not its subfolders), in name order. Other files are left out and counted.
        bridge.Register("batch.choose", request =>
        {
            var (noun, extensions) = OptionalString(request, "accept") switch
            {
                "pdf" => ("PDF documents", (IReadOnlyCollection<string>)[".pdf"]),
                "office" => ("Word, Excel and PowerPoint documents", OfficeFormats.Extensions),
                _ => throw new ArgumentException("Vellum doesn’t batch that kind of file."),
            };
            bool Accepted(string path) => extensions.Contains(Path.GetExtension(path), StringComparer.OrdinalIgnoreCase);

            string[] paths;
            var left = 0;
            string? folder = null;
            if (OptionalBool(request, "folder") == true)
            {
                var dialog = new OpenFolderDialog { Title = $"Choose a folder of {noun}", InitialDirectory = LastFolder() };
                if (dialog.ShowDialog(this) != true) return Done(new { files = Array.Empty<object>(), left, more = 0, folder });
                folder = Path.GetFullPath(dialog.FolderName);
                var all = BatchFolderFiles(folder);
                paths = all.Where(Accepted).ToArray();
                left = all.Length - paths.Length;
            }
            else
            {
                var pattern = string.Join(";", extensions.Select(e => "*" + e));
                var dialog = new OpenFileDialog
                {
                    Title = $"Choose {noun}",
                    Filter = $"{noun} ({pattern})|{pattern}|All files (*.*)|*.*",
                    Multiselect = true,
                    InitialDirectory = LastFolder(),
                };
                paths = dialog.ShowDialog(this) == true ? dialog.FileNames.Select(Path.GetFullPath).ToArray() : [];
            }
            var more = Math.Max(0, paths.Length - MostBatchFiles);
            return Done(new { files = paths.Take(MostBatchFiles).Select(BatchFile).ToArray(), left, more, folder });
        });

        bridge.Register("batch.office", async request =>
        {
            string source, destination;
            // hold: a workflow's step in between; the PDF goes to Vellum's own work folder (MainWindow.Flow.cs).
            var hold = OptionalBool(request, "hold") == true;
            try
            {
                source = BatchSource(RequiredString(request, "source"));
                if (hold) destination = HeldPath(RequiredString(request, "name"));
                else
                {
                    var folder = ExportFolder(request);
                    var keepBoth = OptionalString(request, "overwrite") == "keepBoth";
                    destination = ExportTargets.Resolve(folder, RequiredString(request, "name"), keepBoth,
                        new HashSet<string>(StringComparer.OrdinalIgnoreCase), _server!.IsReadOnly);
                }
            }
            catch (Exception ex) when (ex is ArgumentException or InvalidOperationException or IOException)
            {
                return BatchItem(new ConversionResult(ConversionStatus.InvalidInput, ex.Message));
            }
            if (_officeRun is not null)
            {
                if (hold) DeleteHeld(destination);
                return BatchItem(new ConversionResult(ConversionStatus.Unavailable, "A document is already being converted. Wait for it to finish, or cancel it, then try again."));
            }

            // Set before the first await, so an office.cancel sent after this request always finds it.
            using var run = new CancellationTokenSource();
            _officeRun = run;
            try
            {
                var result = await _office.ConvertAsync(new OfficeToPdfRequest(source, destination), run.Token);
                return hold ? HeldItem(result, destination) : BatchItem(result);
            }
            finally { _officeRun = null; }
        });
    }

    /// <summary>What the page is told about a file chosen for a batch; it is registered read-only.</summary>
    private object BatchFile(string path)
    {
        var info = new FileInfo(path);
        var token = _server!.RegisterReadOnlyDocument(info.FullName);
        _batchSources.Add(token);
        return new { token, path = info.FullName, name = info.Name, size = info.Exists ? info.Length : 0, url = $"{AppResourceServer.Origin}/doc/{token}" };
    }

    /// <summary>The full path of a file chosen for a batch, by its token; anything else is refused.</summary>
    private string BatchSource(string token)
    {
        if (!_batchSources.Contains(token) || _server!.ResolveDocument(token) is not { } path)
            throw new InvalidOperationException("Vellum only works on files you chose for this batch.");
        return path;
    }

    /// <summary>
    /// The files directly in `folder`, by name: not hidden or system files, and not the "~$" owner files Office
    /// leaves beside a document that is open.
    /// </summary>
    private static string[] BatchFolderFiles(string folder)
    {
        try
        {
            return new DirectoryInfo(folder).EnumerateFiles("*", new EnumerationOptions { IgnoreInaccessible = true, AttributesToSkip = FileAttributes.Hidden | FileAttributes.System })
                .Where(f => !f.Name.StartsWith("~$", StringComparison.Ordinal))
                .Select(f => f.FullName)
                .Order(StringComparer.OrdinalIgnoreCase)
                .ToArray();
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { return []; }
    }

    /// <summary>
    /// One item's outcome, as the page reads it: the operation's own result, with the PDF when there is one
    /// (or `output`, when given: a held PDF's, with its token).
    /// </summary>
    private static object BatchItem(ConversionResult result, object? output = null) => new
    {
        status = StatusName(result.Status),
        message = result.Message,
        provider = result.Provider,
        providerName = result.ProviderName,
        output = output ?? (result.Succeeded ? new { name = Path.GetFileName(result.Output!), path = result.Output } : null),
        elapsedMs = (long)result.Elapsed.TotalMilliseconds,
        diagnostics = result.Diagnostics,
    };
}
