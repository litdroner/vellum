using System.Diagnostics;
using System.IO;
using System.Text;

namespace Vellum.Services.Conversion;

// Office → PDF: Word, Excel and PowerPoint documents turned into PDF by an Office application already on
// this PC. Vellum ships no Office renderer and sends nothing anywhere; a provider is an installed
// application run locally (MicrosoftOfficeProvider, LibreOfficeProvider).
//
// Three questions are kept apart, because a person needs a different answer to each:
//   1. Is the provider installed?            IOfficeProvider.Detect — registry and files only, nothing started
//   2. Can it convert this kind of document? ProviderInstall.Formats (Office without PowerPoint can't)
//   3. Can it convert it right now?          IOfficeProvider.BusyReason (PowerPoint is open)
// Selection is deterministic: providers in their registered order (Microsoft Office, then LibreOffice), the
// first that is installed, can convert the format and isn't busy. A failed conversion is reported, never
// silently retried with the next provider.
//
// The operation is `office.toPdf` (OfficeToPdfRequest → ConversionResult): no dialogs, no tool ids, so the
// Tools UI, and later Batch and Flow, call the same thing. The source is only read — the provider gets a
// private copy under an ASCII name in a work folder of its own — and the PDF is checked, written beside its
// destination and moved into place, so a failure leaves nothing behind and never touches an existing file.

/// <summary>The three kinds of Office document Vellum turns into PDF, named by the application that makes them.</summary>
public enum OfficeFormat { Word, Excel, PowerPoint }

public static class OfficeFormats
{
    private static readonly Dictionary<string, OfficeFormat> ByExtension = new(StringComparer.OrdinalIgnoreCase)
    {
        [".docx"] = OfficeFormat.Word, [".doc"] = OfficeFormat.Word,
        [".xlsx"] = OfficeFormat.Excel, [".xls"] = OfficeFormat.Excel,
        [".pptx"] = OfficeFormat.PowerPoint, [".ppt"] = OfficeFormat.PowerPoint,
    };

    /// <summary>Every extension Vellum converts, with its dot: ".docx", ".doc", …</summary>
    public static IReadOnlyCollection<string> Extensions => ByExtension.Keys;

    /// <summary>The kind of document a path names, by its extension; null for anything else.</summary>
    public static OfficeFormat? Of(string path) => ByExtension.TryGetValue(Path.GetExtension(path), out var format) ? format : null;

    /// <summary>The format's stable name, as the bridge and the Office helper spell it: "word", "excel", "powerpoint".</summary>
    public static string Key(this OfficeFormat format) => format.ToString().ToLowerInvariant();

    public static OfficeFormat? FromKey(string key) => key switch
    {
        "word" => OfficeFormat.Word,
        "excel" => OfficeFormat.Excel,
        "powerpoint" => OfficeFormat.PowerPoint,
        _ => null,
    };

    /// <summary>"Word document", "Excel workbook", "PowerPoint presentation".</summary>
    public static string Noun(this OfficeFormat format) => format switch
    {
        OfficeFormat.Word => "Word document",
        OfficeFormat.Excel => "Excel workbook",
        _ => "PowerPoint presentation",
    };
}

/// <summary>How a conversion ended, or why it didn't start.</summary>
public enum ConversionStatus
{
    Converted,
    /// <summary>Not a Word, Excel or PowerPoint document.</summary>
    UnsupportedFormat,
    /// <summary>The source is missing, empty or not what its name says; or the destination can't be used.</summary>
    InvalidInput,
    /// <summary>The document is protected with a password. Vellum never tries to open it.</summary>
    Protected,
    /// <summary>No provider is installed (or the one asked for doesn't exist).</summary>
    NoProvider,
    /// <summary>Providers are installed, but none can convert this kind of document.</summary>
    NotSupported,
    /// <summary>A provider that can convert it can't run right now.</summary>
    Unavailable,
    Failed,
    TimedOut,
    Cancelled,
}

/// <summary>
/// The office.toPdf operation's parameters. Source and Destination are full paths the caller was allowed to
/// use (a person chose them); Destination is a .pdf and is replaced if it exists. Provider names one provider
/// by id instead of choosing; Timeout replaces the default limit.
/// </summary>
public sealed record OfficeToPdfRequest(string Source, string Destination, string? Provider = null, TimeSpan? Timeout = null);

/// <summary>
/// The structured outcome of office.toPdf. Message is a sentence a person can act on; Provider is the id of
/// the provider that ran (or refused); Output is the PDF written, only when Converted; Diagnostics is for logs.
/// </summary>
public sealed record ConversionResult(
    ConversionStatus Status,
    string Message,
    string? Provider = null,
    string? ProviderName = null,
    string? Output = null,
    string? Diagnostics = null)
{
    public bool Succeeded => Status == ConversionStatus.Converted;
    public TimeSpan Elapsed { get; init; }
}

/// <summary>What detection found, with nothing started: installed at all, which formats it can convert, and a note for diagnostics.</summary>
public sealed record ProviderInstall(bool Installed, IReadOnlySet<OfficeFormat> Formats, string Detail)
{
    public static ProviderInstall Missing(string detail) => new(false, new HashSet<OfficeFormat>(), detail);
}

/// <summary>One provider's detection, as reported to the page.</summary>
public sealed record ProviderReport(string Id, string Name, bool Installed, IReadOnlyList<OfficeFormat> Formats, string Detail);

/// <summary>
/// One conversion handed to a provider: its private copy of the document (Input), the PDF it must write
/// (Output, in a folder of its own), a work folder it may use, and its time limit. The service removes it all.
/// </summary>
public sealed record ProviderJob(OfficeFormat Format, string Input, string Output, string WorkFolder, TimeSpan Timeout);

/// <summary>A provider's report on one job. Converted only means it says it wrote Output: the service checks the file.</summary>
public sealed record ProviderRun(ConversionStatus Status, string? Message = null, string? Diagnostics = null)
{
    public static ProviderRun Ok(string? diagnostics = null) => new(ConversionStatus.Converted, null, diagnostics);
}

/// <summary>An installed application that turns Office documents into PDF, on this PC.</summary>
public interface IOfficeProvider
{
    /// <summary>A stable id: "microsoft-office", "libreoffice".</summary>
    string Id { get; }
    /// <summary>What a person calls it: "Microsoft Office".</summary>
    string Name { get; }
    /// <summary>Whether it is installed and which formats it can convert, from the registry and files only.</summary>
    ProviderInstall Detect();
    /// <summary>Why it can't convert `format` right now, or null when it can. Cheap; starts nothing.</summary>
    string? BusyReason(OfficeFormat format);
    /// <summary>Converts job.Input into job.Output within job.Timeout. Reports failure as a ProviderRun, not an exception.</summary>
    Task<ProviderRun> ConvertAsync(ProviderJob job, CancellationToken cancel);
}

/// <summary>The provider that would convert a format now, or why none can.</summary>
public sealed record ConversionPlan(OfficeFormat Format, IOfficeProvider? Provider, ConversionStatus? Refusal, string? Reason);

/// <summary>Chooses a provider and runs office.toPdf, one conversion at a time.</summary>
public sealed class OfficeConversion
{
    public static readonly TimeSpan DefaultTimeout = TimeSpan.FromMinutes(3);
    private static readonly TimeSpan LongestTimeout = TimeSpan.FromMinutes(30);
    private static readonly byte[] ZipSignature = [0x50, 0x4B, 0x03, 0x04];
    private static readonly byte[] CompoundFileSignature = [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1];
    /// <summary>The stream a password-protected .docx/.xlsx/.pptx keeps its encrypted contents in.</summary>
    private static readonly byte[] EncryptedPackage = Encoding.Unicode.GetBytes("EncryptedPackage");

    private readonly IReadOnlyList<IOfficeProvider> _providers;
    private readonly string _workRoot;
    private readonly SemaphoreSlim _oneAtATime = new(1, 1);

    public OfficeConversion(IReadOnlyList<IOfficeProvider> providers, string workRoot)
    {
        if (providers.Select(p => p.Id).Distinct(StringComparer.Ordinal).Count() != providers.Count)
            throw new ArgumentException("Every provider needs its own id.", nameof(providers));
        _providers = providers;
        _workRoot = workRoot;
    }

    /// <summary>
    /// Vellum's providers in the order they are chosen: Microsoft Office, then LibreOffice. `helper` is the
    /// program Microsoft Office conversions run in (Vellum.exe itself); work folders go under dataFolder.
    /// </summary>
    public static OfficeConversion Create(string dataFolder, string helper)
    {
        var runner = new ProcessRunner();
        var probe = new ProviderProbe();
        return new([new MicrosoftOfficeProvider(helper, runner, probe), new LibreOfficeProvider(runner, probe)],
            Path.Combine(dataFolder, "conversion"));
    }

    public IReadOnlyList<IOfficeProvider> Providers => _providers;

    /// <summary>Each provider's detection, in selection order.</summary>
    public IReadOnlyList<ProviderReport> Report() => _providers.Select(p =>
    {
        var install = Detect(p);
        return new ProviderReport(p.Id, p.Name, install.Installed, [.. install.Formats.Order()], install.Detail);
    }).ToList();

    /// <summary>Which provider would convert `format` now (only `provider`, when one is named), or why none would.</summary>
    public ConversionPlan Plan(OfficeFormat format, string? provider = null)
    {
        var candidates = provider is null ? _providers : _providers.Where(p => p.Id == provider).ToList();
        if (candidates.Count == 0)
            return new(format, null, ConversionStatus.NoProvider, $"Vellum has no conversion provider called “{provider}”.");

        var installed = candidates.Select(p => (Provider: p, Install: Detect(p))).Where(x => x.Install.Installed).ToList();
        if (installed.Count == 0)
            return new(format, null, ConversionStatus.NoProvider, provider is null
                ? $"Converting a {format.Noun()} to PDF needs Microsoft Office or LibreOffice on this PC, and neither was found."
                : $"{candidates[0].Name} isn’t installed on this PC.");

        var capable = installed.Where(x => x.Install.Formats.Contains(format)).Select(x => x.Provider).ToList();
        if (capable.Count == 0)
            return new(format, null, ConversionStatus.NotSupported,
                $"{string.Join(" and ", installed.Select(x => x.Provider.Name))} can’t convert a {format.Noun()} to PDF on this PC.");

        string? firstReason = null;
        foreach (var candidate in capable)
        {
            var busy = candidate.BusyReason(format);
            if (busy is null) return new(format, candidate, null, null);
            firstReason ??= busy;
        }
        return new(format, null, ConversionStatus.Unavailable, firstReason);
    }

    /// <summary>office.toPdf. Always returns a result; an exception here is a bug, not an outcome.</summary>
    public async Task<ConversionResult> ConvertAsync(OfficeToPdfRequest request, CancellationToken cancel = default)
    {
        var clock = Stopwatch.StartNew();
        var result = await RunAsync(request, cancel).ConfigureAwait(false);
        return result with { Elapsed = clock.Elapsed };
    }

    private async Task<ConversionResult> RunAsync(OfficeToPdfRequest request, CancellationToken cancel)
    {
        if (!IsFullPath(request.Source))
            return Refused(ConversionStatus.InvalidInput, "Vellum needs the full path of the document to convert.");
        var source = Path.GetFullPath(request.Source);
        if (OfficeFormats.Of(source) is not { } format)
            return Refused(ConversionStatus.UnsupportedFormat, "Only Word (.docx, .doc), Excel (.xlsx, .xls) and PowerPoint (.pptx, .ppt) documents can be converted to PDF.");
        if (!File.Exists(source))
            return Refused(ConversionStatus.InvalidInput, "That document is no longer there.");
        if (CheckDestination(request.Destination, source) is { } badDestination) return badDestination;
        var destination = Path.GetFullPath(request.Destination);
        var timeout = request.Timeout ?? DefaultTimeout;
        if (timeout <= TimeSpan.Zero || timeout > LongestTimeout)
            return Refused(ConversionStatus.InvalidInput, "A conversion’s time limit must be between a moment and 30 minutes.");
        if (Inspect(source, format) is { } badSource) return badSource;

        var plan = Plan(format, request.Provider);
        if (plan.Provider is not { } provider) return Refused(plan.Refusal!.Value, plan.Reason!);

        try { await _oneAtATime.WaitAsync(cancel).ConfigureAwait(false); }
        catch (OperationCanceledException) { return Refused(ConversionStatus.Cancelled, "The conversion was cancelled; nothing was saved."); }

        var work = Path.Combine(_workRoot, Guid.NewGuid().ToString("N"));
        try
        {
            // The provider only ever sees this copy, under a plain name: the source is never opened by an
            // Office application, gets no lock file beside it, and its name can't confuse a command line.
            var input = Path.Combine(work, "in", "document" + Path.GetExtension(source).ToLowerInvariant());
            var output = Path.Combine(work, "out", "document.pdf");
            Directory.CreateDirectory(Path.GetDirectoryName(input)!);
            Directory.CreateDirectory(Path.GetDirectoryName(output)!);
            try { File.Copy(source, input); }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                return new(ConversionStatus.InvalidInput, $"Vellum can’t read that document: {ex.Message}", provider.Id, provider.Name);
            }

            ProviderRun run;
            try { run = await provider.ConvertAsync(new ProviderJob(format, input, output, work, timeout), cancel).ConfigureAwait(false); }
            catch (OperationCanceledException) { run = new(ConversionStatus.Cancelled); }
            catch (Exception ex) { run = new(ConversionStatus.Failed, null, $"{ex.GetType().Name}: {ex.Message}"); }

            if (run.Status != ConversionStatus.Converted)
                return new(run.Status, run.Message ?? DefaultMessage(run.Status, provider, format), provider.Id, provider.Name, null, run.Diagnostics);
            if (!IsPdf(output))
                return new(ConversionStatus.Failed, $"{provider.Name} finished without writing a PDF, so nothing was saved.", provider.Id, provider.Name, null, run.Diagnostics);

            Place(output, destination);
            return new(ConversionStatus.Converted, $"Converted with {provider.Name}.", provider.Id, provider.Name, destination, run.Diagnostics);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return new(ConversionStatus.Failed, $"The PDF couldn’t be written: {ex.Message}", provider.Id, provider.Name, null, ex.ToString());
        }
        finally
        {
            TryDelete(work);
            _oneAtATime.Release();
        }
    }

    /// <summary>Removes work folders an interrupted conversion left behind. Does nothing while a conversion runs.</summary>
    public void CleanUp()
    {
        if (!_oneAtATime.Wait(0)) return;
        try
        {
            if (Directory.Exists(_workRoot))
                foreach (var folder in Directory.EnumerateDirectories(_workRoot)) TryDelete(folder);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { /* next time */ }
        finally { _oneAtATime.Release(); }
    }

    private static ProviderInstall Detect(IOfficeProvider provider)
    {
        // Detection only reads, but a registry or file-system surprise must mean "not found", never a crash.
        try { return provider.Detect(); }
        catch (Exception ex) { return ProviderInstall.Missing($"{provider.Name} couldn’t be checked: {ex.Message}"); }
    }

    private static ConversionResult Refused(ConversionStatus status, string message) => new(status, message);

    private static string DefaultMessage(ConversionStatus status, IOfficeProvider provider, OfficeFormat format) => status switch
    {
        ConversionStatus.Cancelled => "The conversion was cancelled; nothing was saved.",
        ConversionStatus.TimedOut => $"{provider.Name} took too long, so the conversion was stopped and nothing was saved.",
        ConversionStatus.Protected => $"This {format.Noun()} is protected with a password, so it can’t be converted.",
        _ => $"{provider.Name} couldn’t convert this {format.Noun()}, so nothing was saved.",
    };

    private static bool IsFullPath(string? path) => !string.IsNullOrWhiteSpace(path) && Path.IsPathFullyQualified(path);

    private static ConversionResult? CheckDestination(string? requested, string source)
    {
        if (!IsFullPath(requested))
            return Refused(ConversionStatus.InvalidInput, "Vellum needs the full path of the PDF to write.");
        var destination = Path.GetFullPath(requested!);
        if (!destination.EndsWith(".pdf", StringComparison.OrdinalIgnoreCase))
            return Refused(ConversionStatus.InvalidInput, "The converted document must be saved as a .pdf file.");
        if (string.Equals(destination, source, StringComparison.OrdinalIgnoreCase))
            return Refused(ConversionStatus.InvalidInput, "The PDF can’t replace the document it is made from.");
        if (Directory.Exists(destination))
            return Refused(ConversionStatus.InvalidInput, "That name belongs to a folder.");
        if (!Directory.Exists(Path.GetDirectoryName(destination)))
            return Refused(ConversionStatus.InvalidInput, "The folder for the PDF doesn’t exist any more.");
        return null;
    }

    /// <summary>
    /// Refuses a source that can't be what its name says, before any application is started: an empty file,
    /// a .docx/.xlsx/.pptx that is neither a ZIP package nor an OLE file, and one that is password-protected
    /// (an OLE file carrying an EncryptedPackage stream). The older .doc/.xls/.ppt are left to the application.
    /// </summary>
    internal static ConversionResult? Inspect(string path, OfficeFormat format)
    {
        try { return InspectContent(path, format); }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return Refused(ConversionStatus.InvalidInput, $"Vellum can’t read that {format.Noun()}: {ex.Message}");
        }
    }

    private static ConversionResult? InspectContent(string path, OfficeFormat format)
    {
        using var file = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
        if (file.Length == 0) return Refused(ConversionStatus.InvalidInput, $"That {format.Noun()} is empty.");
        if (!Path.GetExtension(path).EndsWith("x", StringComparison.OrdinalIgnoreCase)) return null;

        var head = new byte[CompoundFileSignature.Length];
        var read = file.ReadAtLeast(head, head.Length, throwOnEndOfStream: false);
        if (head.AsSpan(0, read).StartsWith(ZipSignature)) return null;
        if (read == head.Length && head.AsSpan().SequenceEqual(CompoundFileSignature))
            return Contains(file, EncryptedPackage)
                ? Refused(ConversionStatus.Protected, $"This {format.Noun()} is protected with a password, so Vellum can’t convert it. Remove the password in the application that made it, then try again.")
                : null;
        return Refused(ConversionStatus.InvalidInput, $"This file isn’t a valid {format.Noun()}.");
    }

    /// <summary>Whether `pattern` appears anywhere in the stream, read in blocks.</summary>
    private static bool Contains(Stream stream, byte[] pattern)
    {
        stream.Position = 0;
        var buffer = new byte[64 * 1024 + pattern.Length];
        var carried = 0;
        int read;
        while ((read = stream.Read(buffer, carried, buffer.Length - carried)) > 0)
        {
            var filled = carried + read;
            if (buffer.AsSpan(0, filled).IndexOf(pattern) >= 0) return true;
            carried = Math.Min(pattern.Length - 1, filled);
            Array.Copy(buffer, filled - carried, buffer, 0, carried);
        }
        return false;
    }

    /// <summary>A PDF header within the first kilobyte, as PDF readers accept it.</summary>
    private static bool IsPdf(string path)
    {
        if (!File.Exists(path)) return false;
        using var file = File.OpenRead(path);
        var head = new byte[1024];
        var read = file.ReadAtLeast(head, head.Length, throwOnEndOfStream: false);
        return head.AsSpan(0, read).IndexOf("%PDF-"u8) >= 0;
    }

    /// <summary>Copies the PDF beside its destination and renames it into place, replacing what was there only once it is whole.</summary>
    private static void Place(string pdf, string destination)
    {
        var part = destination + ".part";
        try
        {
            File.Copy(pdf, part, overwrite: true);
            File.Move(part, destination, overwrite: true);
        }
        finally
        {
            if (File.Exists(part)) { try { File.Delete(part); } catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { } }
        }
    }

    private static void TryDelete(string folder)
    {
        try { if (Directory.Exists(folder)) Directory.Delete(folder, recursive: true); }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { /* CleanUp removes it later */ }
    }
}
