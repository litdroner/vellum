using System.IO;
using Microsoft.Web.WebView2.Core;
using Microsoft.Win32;
using Vellum.Hosting;

namespace Vellum;

// HTML to PDF V1: the host half of turning a local HTML file into a PDF.
//
// There is no rendering engine here and no second PDF writer. The page is laid out and printed by the
// WebView2 runtime Vellum already runs on — a second, hidden view in the same environment as the
// window's own — through CoreWebView2.PrintToPdfAsync, which is Chromium's own print-to-PDF. So text
// stays text, CSS layout, local images and links are whatever that renderer makes of them, and the
// HTML file itself is only read.
//
// Local-first, and kept local by the view itself rather than by trust: every resource the page asks
// for goes through WebResourceRequested and anything that isn't a file:// URL is refused, so an
// <img src="https://…">, a web font, a tracking pixel or a fetch() reaches nothing. Navigation away
// from the chosen file is cancelled, and new windows are refused. The hidden view is closed again as
// soon as the PDF is written, whether it worked or not.
//
// The person picks both files here, as they do everywhere else in Vellum: the HTML through an Open
// dialog and the PDF through a Save dialog, so the page never names a path the host writes to. The
// PDF is written beside its target and moved into place, so a failure halfway leaves nothing behind.
public partial class MainWindow
{
    /// <summary>How long the page gets to load before the conversion is given up on.</summary>
    private static readonly TimeSpan HtmlRenderTimeout = TimeSpan.FromSeconds(30);

    /// <summary>Page sizes in inches, portrait — the same two the rest of Vellum offers.</summary>
    private static readonly Dictionary<string, (double Width, double Height)> HtmlPageSizes =
        new(StringComparer.Ordinal) { ["a4"] = (8.27, 11.69), ["letter"] = (8.5, 11.0) };

    private void RegisterHtmlToPdfHandlers(BridgeHost bridge)
    {
        // "HTML to PDF…": choose a local .html file, choose where the PDF goes, render and print it.
        bridge.Register("html.toPdf", async request =>
        {
            var size = OptionalString(request, "size") ?? "a4";
            if (!HtmlPageSizes.ContainsKey(size)) throw new ArgumentException("That page size isn’t one Vellum offers.");

            var open = new OpenFileDialog
            {
                Title = "Choose an HTML file",
                Filter = "Web pages (*.html;*.htm)|*.html;*.htm|All files (*.*)|*.*",
                InitialDirectory = LastFolder(),
            };
            if (open.ShowDialog(this) != true) return new { file = (object?)null };
            var source = new FileInfo(open.FileName);
            if (!source.Exists) throw new FileNotFoundException("That HTML file is no longer there.");

            var save = new SaveFileDialog
            {
                Title = "Save the PDF as",
                Filter = "PDF documents (*.pdf)|*.pdf",
                DefaultExt = ".pdf",
                AddExtension = true,
                OverwritePrompt = true,
                FileName = Path.GetFileNameWithoutExtension(source.Name) + ".pdf",
                InitialDirectory = source.DirectoryName,
            };
            if (save.ShowDialog(this) != true) return new { file = (object?)null };

            await RenderHtmlToPdfAsync(source.FullName, save.FileName, size);
            return new { file = DescribeFile(save.FileName) };
        });
    }

    /// <summary>
    /// Renders `htmlPath` in a hidden WebView2 that can reach nothing but local files, and prints it to
    /// `pdfPath`. Throws, with what a person can act on, if the page can't be rendered or printed.
    /// </summary>
    private async Task RenderHtmlToPdfAsync(string htmlPath, string pdfPath, string size)
    {
        var env = _webViewEnvironment ?? throw new InvalidOperationException("Vellum isn’t ready to render a page yet.");
        var controller = await env.CreateCoreWebView2ControllerAsync(Handle);
        var part = pdfPath + ".part";
        try
        {
            controller.IsVisible = false;
            // Big enough for the page to lay out; the printed page's size comes from the print settings.
            controller.Bounds = new System.Drawing.Rectangle(0, 0, 1024, 1400);
            var core = controller.CoreWebView2;
            var settings = core.Settings;
            settings.AreDefaultContextMenusEnabled = false;
            settings.AreDevToolsEnabled = false;
            settings.IsStatusBarEnabled = false;
            settings.IsGeneralAutofillEnabled = false;
            settings.IsPasswordAutosaveEnabled = false;

            var target = new Uri(htmlPath).AbsoluteUri;
            // Nothing but local files: every request the page makes is refused unless it is a file:// URL.
            core.AddWebResourceRequestedFilter("*", CoreWebView2WebResourceContext.All);
            core.WebResourceRequested += (_, e) =>
            {
                if (e.Request.Uri.StartsWith("file:", StringComparison.OrdinalIgnoreCase)) return;
                e.Response = core.Environment.CreateWebResourceResponse(null, 403, "Blocked", "");
            };
            // …and the page stays the file that was chosen: no redirect, no link, no new window.
            core.NavigationStarting += (_, e) =>
            {
                if (!e.Uri.StartsWith("file:", StringComparison.OrdinalIgnoreCase)) e.Cancel = true;
            };
            core.NewWindowRequested += (_, e) => e.Handled = true;

            var loaded = new TaskCompletionSource<CoreWebView2WebErrorStatus?>(TaskCreationOptions.RunContinuationsAsynchronously);
            core.NavigationCompleted += (_, e) => loaded.TrySetResult(e.IsSuccess ? null : e.WebErrorStatus);
            core.ProcessFailed += (_, _) => loaded.TrySetResult(CoreWebView2WebErrorStatus.Unknown);
            core.Navigate(target);

            if (await Task.WhenAny(loaded.Task, Task.Delay(HtmlRenderTimeout)) != loaded.Task)
                throw new TimeoutException("That page took too long to render, so no PDF was written.");
            if (await loaded.Task is { } failure)
                throw new InvalidDataException($"That HTML file couldn’t be rendered ({failure}), so no PDF was written.");

            if (!await core.PrintToPdfAsync(part, HtmlPrintSettings(env, size)))
                throw new IOException("The PDF couldn’t be produced from that page, so nothing was written.");
            File.Move(part, pdfPath, overwrite: true);
        }
        finally
        {
            if (File.Exists(part)) { try { File.Delete(part); } catch (IOException) { } }
            controller.Close();
        }
    }

    /// <summary>The print settings every conversion uses: the same page, margins and scale every time.</summary>
    private static CoreWebView2PrintSettings HtmlPrintSettings(CoreWebView2Environment env, string size)
    {
        var (width, height) = HtmlPageSizes[size];
        var settings = env.CreatePrintSettings();
        settings.Orientation = CoreWebView2PrintOrientation.Portrait;
        settings.PageWidth = width;
        settings.PageHeight = height;
        settings.MarginTop = settings.MarginBottom = settings.MarginLeft = settings.MarginRight = 0.4;
        settings.ScaleFactor = 1.0;
        settings.ShouldPrintBackgrounds = true;
        settings.ShouldPrintSelectionOnly = false;
        settings.ShouldPrintHeaderAndFooter = false;
        return settings;
    }
}
