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
// office.providers says what this PC has, starting nothing, so the page can decide whether an Office tool
// exists at all (presence `engine.office`). office.toPdf is the interactive entry: the person picks the
// document and the PDF here, as for HTML to PDF, so the page never names a path; the conversion itself is the
// office.toPdf operation, which Batch and Flow will call with their own files. office.cancel stops it.
public partial class MainWindow
{
    private readonly OfficeConversion _office = OfficeConversion.Create(DataFolder, Environment.ProcessPath ?? "");
    private CancellationTokenSource? _officeRun;

    private void RegisterOfficeConversionHandlers(BridgeHost bridge)
    {
        bridge.Register("office.providers", _ => Done(new
        {
            providers = _office.Report().Select(r => new { r.Id, r.Name, r.Installed, formats = r.Formats.Select(f => f.Key()), r.Detail }),
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
            }),
        }));

        bridge.Register("office.toPdf", async request =>
        {
            var provider = OptionalString(request, "provider");
            var extensions = string.Join(";", OfficeFormats.Extensions.Select(e => "*" + e));
            var open = new OpenFileDialog
            {
                Title = "Choose a Word, Excel or PowerPoint document",
                Filter = $"Office documents ({extensions})|{extensions}",
                InitialDirectory = LastFolder(),
            };
            if (open.ShowDialog(this) != true) return new { result = (object?)null };
            var source = Path.GetFullPath(open.FileName);

            // Nothing on this PC can convert it: say so before asking where the PDF should go.
            if (OfficeFormats.Of(source) is { } format && _office.Plan(format, provider) is { Provider: null } plan)
                return new { result = (object?)new { status = StatusName(plan.Refusal!.Value), message = plan.Reason } };

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

            using var run = new CancellationTokenSource();
            _officeRun = run;
            ConversionResult result;
            try { result = await _office.ConvertAsync(new OfficeToPdfRequest(source, save.FileName, provider), run.Token); }
            finally { _officeRun = null; }
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
        });

        bridge.Register("office.cancel", _ =>
        {
            _officeRun?.Cancel();
            return Done();
        });
    }

    /// <summary>"converted", "noProvider", "timedOut"…: the status as the page spells it.</summary>
    private static string StatusName(ConversionStatus status) => JsonNamingPolicy.CamelCase.ConvertName(status.ToString());
}
