using System.Diagnostics;
using System.IO;
using Vellum.Hosting;
using Vellum.Services;

namespace Vellum;

// OCR languages: the page lists them, picks the one OCR reads in, and downloads or removes packs; the host
// downloads, verifies and stores them (see Services/OcrLanguages.cs). English is bundled and always there.
public partial class MainWindow
{
    private readonly OcrLanguages _ocrLanguages = new(DataFolder, Path.Combine(AppContext.BaseDirectory, "web", "js", "ocr", "languages.json"));
    /// <summary>The pack being downloaded, one at a time.</summary>
    private (string Code, CancellationTokenSource Cts)? _ocrDownload;

    private void RegisterOcrLanguageHandlers(BridgeHost bridge)
    {
        _ = Task.Run(_ocrLanguages.CleanUp);
        bridge.Register("ocr.languages", _ => Done(OcrLanguageList()));
        bridge.Register("ocr.select", request =>
        {
            var code = RequiredString(request, "code");
            if (code != "eng" && _ocrLanguages.Find(code) is null) throw new InvalidOperationException("Vellum has no OCR language with that code.");
            _settings.OcrLanguage = code;
            _settings.Save();
            return Done(OcrLanguageList());
        });
        // Before OCR runs: is the chosen language usable? A pack is checked in full here.
        bridge.Register("ocr.prepare", request =>
        {
            var code = RequiredString(request, "code");
            if (code == "eng") return Done(new { ready = true });
            if (_ocrLanguages.Find(code) is not { } pack) return Done(new { ready = false, reason = "unknown" });
            var had = File.Exists(_ocrLanguages.PathOf(pack));
            return Done(_ocrLanguages.ReadVerified(pack) is not null
                ? new { ready = true, reason = (string?)null }
                : new { ready = false, reason = (string?)(had ? "damaged" : "missing") });
        });
        bridge.Register("ocr.download", DownloadOcrLanguageAsync);
        bridge.Register("ocr.cancelDownload", _ =>
        {
            _ocrDownload?.Cts.Cancel();
            return Done();
        });
        bridge.Register("ocr.remove", request =>
        {
            var pack = _ocrLanguages.Find(RequiredString(request, "code")) ?? throw new InvalidOperationException("Vellum has no OCR language with that code.");
            _ocrLanguages.Remove(pack);
            return Done(OcrLanguageList());
        });
    }

    private object OcrLanguageList() => new
    {
        selected = _settings.OcrLanguage == "eng" || _ocrLanguages.Find(_settings.OcrLanguage) is not null ? _settings.OcrLanguage : "eng",
        downloading = _ocrDownload?.Code,
        packs = _ocrLanguages.Packs.Select(p => new { code = p.Code, name = p.Name, size = p.Size, installed = _ocrLanguages.IsInstalled(p) }),
    };

    /// <summary>Downloads one pack, sending "ocr-language-progress" events as it goes; resolves with the new list.</summary>
    private async Task<object?> DownloadOcrLanguageAsync(BridgeRequest request)
    {
        var pack = _ocrLanguages.Find(RequiredString(request, "code")) ?? throw new InvalidOperationException("Vellum has no OCR language with that code.");
        if (_ocrDownload is { } running) throw new OcrLanguageException(running.Code == pack.Code ? $"{pack.Name} is already downloading." : "Another language is downloading. Wait for it to finish first.");
        using var cts = new CancellationTokenSource();
        _ocrDownload = (pack.Code, cts);
        var clock = Stopwatch.StartNew();
        var lastReport = -1000L;
        // Created on the UI thread, so reports arrive there (the WebView may only be used from it).
        var progress = new Progress<(long Received, long Total)>(p =>
        {
            if (clock.ElapsedMilliseconds - lastReport < 80 && p.Received < p.Total) return;
            lastReport = clock.ElapsedMilliseconds;
            _bridge?.Emit("ocr-language-progress", new { code = pack.Code, received = p.Received, total = p.Total });
        });
        try
        {
            await _ocrLanguages.InstallAsync(pack, progress, cts.Token,
                () => Dispatcher.BeginInvoke(() => _bridge?.Emit("ocr-language-progress", new { code = pack.Code, verifying = true })));
            _ocrDownload = null;
            return new { installed = true, list = OcrLanguageList() };
        }
        catch (OperationCanceledException) when (cts.IsCancellationRequested)
        {
            _ocrDownload = null;
            return new { cancelled = true, list = OcrLanguageList() };
        }
        finally
        {
            _ocrDownload = null;
        }
    }
}
