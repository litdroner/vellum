using System.IO;
using System.Text.Json;
using Microsoft.Win32;
using Vellum.Hosting;
using Vellum.Services.Conversion;

namespace Vellum;

// Office → PDF: the host half. Word, Excel and PowerPoint documents become PDFs through an Office application
// already on this PC — Microsoft Office first, then LibreOffice — never an engine Vellum ships and never a
// service online (Services/Conversion/OfficeConversion.cs has the providers, the selection and the rules).
//
// office.providers says what this PC has, starting nothing, so the page can decide whether each Office tool
// exists at all (presence `engine.office.word`, `.excel`, `.powerpoint`). office.toPdf is the interactive entry
// behind those tools: the person picks the document and the PDF here, as for HTML to PDF, so the page never
// names a path; the conversion itself is the office.toPdf operation, which Batch and workflows call with their
// own files. `office-converting` tells the page the dialogs are done and the conversion has started, so it can
// show that and offer Cancel; office.cancel stops it. One at a time: a second request is refused, not queued.
public partial class MainWindow
{
    private readonly OfficeConversion _office = OfficeConversion.Create(DataFolder, Environment.ProcessPath ?? "");
    private CancellationTokenSource? _officeRun;

    private void RegisterOfficeConversionHandlers(BridgeHost bridge)
    {
        // Detection reads the registry and files, and PowerPoint's busy check lists processes: off the UI thread,
        // and every list built there (the reply is serialised on the UI thread).
        bridge.Register("office.providers", _ => Task.Run<object?>(() => new
        {
            providers = _office.Report().Select(r => new { r.Id, r.Name, r.Installed, formats = r.Formats.Select(f => f.Key()).ToList(), r.Detail }).ToList(),
            formats = Enum.GetValues<OfficeFormat>().Select(format =>
            {
                var plan = _office.Plan(format);
                return new
                {
                    format = format.Key(),
                    provider = plan.Provider?.Id,
                    providerName = plan.Provider?.Name,
                    status = plan.Refusal is { } refusal ? StatusName(refusal) : "ready",
                    reason = plan.Reason,
                };
            }).ToList(),
        }));

        bridge.Register("office.toPdf", async request =>
        {
            if (_officeRun is not null)
                return Outcome(ConversionStatus.Unavailable, "A document is already being converted. Wait for it to finish, or cancel it, then try again.");

            using var run = new CancellationTokenSource();
            _officeRun = run;
            try { return await ConvertInteractively(request, run.Token); }
            finally { _officeRun = null; }
        });

        bridge.Register("office.cancel", _ =>
        {
            _officeRun?.Cancel();
            return Done();
        });
    }

    /// <summary>
    /// The tool's flow: the format it was asked for can be converted now (else why not, before any dialog), the
    /// document, the check again for the format actually chosen, the PDF, then the operation.
    /// </summary>
    private async Task<object?> ConvertInteractively(BridgeRequest request, CancellationToken cancel)
    {
        var provider = OptionalString(request, "provider");
        var asked = OptionalString(request, "format") is { } key ? OfficeFormats.FromKey(key) : null;
        if (asked is { } expected && _office.Plan(expected, provider) is { Provider: null } refusedFirst)
            return Outcome(refusedFirst.Refusal!.Value, refusedFirst.Reason!);

        var all = string.Join(";", OfficeFormats.Extensions.Select(e => "*" + e));
        var filter = $"Office documents ({all})|{all}";
        if (asked is { } only)
        {
            var own = string.Join(";", OfficeFormats.Extensions.Where(e => OfficeFormats.Of(e) == only).Select(e => "*" + e));
            filter = $"{only.Noun()}s ({own})|{own}|{filter}";
        }
        var open = new OpenFileDialog
        {
            Title = asked is { } noun ? $"Choose a {noun.Noun()}" : "Choose a Word, Excel or PowerPoint document",
            Filter = filter,
            InitialDirectory = LastFolder(),
        };
        if (open.ShowDialog(this) != true) return new { result = (object?)null };
        var source = Path.GetFullPath(open.FileName);

        // Not an Office document (a name typed past the filter), or nothing on this PC can convert what was
        // chosen: say so before asking where the PDF should go.
        if (OfficeFormats.Of(source) is not { } format) return Outcome(ConversionStatus.UnsupportedFormat, OfficeFormats.Unsupported);
        var plan = _office.Plan(format, provider);
        if (plan.Provider is null) return Outcome(plan.Refusal!.Value, plan.Reason!);

        var save = new SaveFileDialog
        {
            Title = "Save the PDF as",
            Filter = "PDF documents (*.pdf)|*.pdf",
            DefaultExt = ".pdf",
            AddExtension = true,
            OverwritePrompt = true,
            FileName = Path.GetFileNameWithoutExtension(source) + ".pdf",
            InitialDirectory = Path.GetDirectoryName(source),
        };
        if (save.ShowDialog(this) != true) return new { result = (object?)null };

        _bridge?.Emit("office-converting", new { name = Path.GetFileName(source), providerName = plan.Provider.Name });
        var result = await _office.ConvertAsync(new OfficeToPdfRequest(source, save.FileName, provider), cancel);
        return new
        {
            result = (object?)new
            {
                status = StatusName(result.Status),
                message = result.Message,
                provider = result.Provider,
                providerName = result.ProviderName,
                elapsedMs = (long)result.Elapsed.TotalMilliseconds,
            },
            file = result.Succeeded ? DescribeFile(result.Output!) : null,
        };
    }

    /// <summary>A result that ended before the operation ran: why, with no provider and no file.</summary>
    private static object Outcome(ConversionStatus status, string message) =>
        new { result = (object?)new { status = StatusName(status), message }, file = (object?)null };

    /// <summary>"converted", "noProvider", "timedOut"…: the status as the page spells it.</summary>
    private static string StatusName(ConversionStatus status) => JsonNamingPolicy.CamelCase.ConvertName(status.ToString());
}
