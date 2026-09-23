using System.IO;

namespace Vellum.Services.Conversion;

/// <summary>
/// How Vellum's Office helper (Vellum.exe --office-to-pdf &lt;word|excel|powerpoint&gt; &lt;input&gt; &lt;output&gt;, in
/// OfficeAutomation) reports back. Its first line on stdout names the Office process it started ("server 1234"),
/// or says it started none ("server attached"); errors go to stderr; the exit code is the outcome.
/// </summary>
public static class OfficeHelper
{
    public const string Switch = "--office-to-pdf";
    public const string ServerLine = "server ";
    public const string Attached = "attached";

    public const int Converted = 0;
    public const int Failed = 1;
    public const int Usage = 2;
    /// <summary>The application is in use (PowerPoint is open), so nothing was done.</summary>
    public const int Busy = 3;
    public const int Protected = 4;
    /// <summary>The application couldn't be started through automation at all.</summary>
    public const int CantStart = 5;
}

/// <summary>
/// Microsoft Office, through its own automation: Word, Excel and PowerPoint each save their documents as PDF.
///
/// Installed means the application's automation server is registered (ProgID → CLSID → LocalServer32), the
/// program it names is really that application (WINWORD.EXE, not whatever else claims the ProgID) and exists,
/// and its version (CurVer) is Office 2010 or later — the first that saves PDF without an add-in. Each of the
/// three is checked on its own, so Office without PowerPoint converts only Word and Excel documents. Nothing is
/// started to find this out.
///
/// A conversion runs in a separate process, Vellum.exe itself in helper mode, so the time limit can end it:
/// when it runs out, the helper's process tree is ended and so is the Office application it started (never one
/// it didn't start, never the person's own). PowerPoint runs one instance per person, so while PowerPoint is
/// open it is busy: Vellum never converts inside a PowerPoint someone is using.
/// </summary>
public sealed class MicrosoftOfficeProvider(string helper, IProcessRunner runner, ProviderProbe probe) : IOfficeProvider
{
    private const int FirstVersionWithPdf = 14;

    private sealed record App(OfficeFormat Format, string ProgId, string Program, string Name)
    {
        public string ProcessName => Path.GetFileNameWithoutExtension(Program);
    }

    private static readonly App[] Apps =
    [
        new(OfficeFormat.Word, "Word.Application", "WINWORD.EXE", "Word"),
        new(OfficeFormat.Excel, "Excel.Application", "EXCEL.EXE", "Excel"),
        new(OfficeFormat.PowerPoint, "PowerPoint.Application", "POWERPNT.EXE", "PowerPoint"),
    ];

    public string Id => "microsoft-office";
    public string Name => "Microsoft Office";

    public ProviderInstall Detect()
    {
        var formats = new HashSet<OfficeFormat>();
        var notes = new List<string>();
        foreach (var app in Apps)
        {
            var (server, curVer) = probe.ComServer(app.ProgId);
            var program = server is null ? null : ServerPath(server);
            if (program is null || !string.Equals(Path.GetFileName(program), app.Program, StringComparison.OrdinalIgnoreCase) || !probe.FileExists(program))
                continue;
            var version = Version(app.ProgId, curVer);
            if (version is null) notes.Add($"{app.Name} (version unknown, so not used)");
            else if (version < FirstVersionWithPdf) notes.Add($"{app.Name} {version} (too old to save PDF)");
            else
            {
                formats.Add(app.Format);
                notes.Add($"{app.Name} {version}");
            }
        }
        return notes.Count == 0
            ? ProviderInstall.Missing("Word, Excel and PowerPoint aren’t installed.")
            : new ProviderInstall(true, formats, string.Join(", ", notes));
    }

    public string? BusyReason(OfficeFormat format) =>
        format == OfficeFormat.PowerPoint && probe.IsRunning(Apps[2].ProcessName)
            ? "PowerPoint is open. Close it and try again: Vellum converts presentations in a PowerPoint of its own, never in one you are using."
            : null;

    public async Task<ProviderRun> ConvertAsync(ProviderJob job, CancellationToken cancel)
    {
        var app = Apps.First(a => a.Format == job.Format);
        var started = DateTime.Now.AddSeconds(-1);
        var outcome = await runner.RunAsync(new ProcessCall(helper, [OfficeHelper.Switch, job.Format.Key(), job.Input, job.Output]), job.Timeout, cancel)
            .ConfigureAwait(false);
        // The helper was stopped: the Office application it started is not its child, so end it too.
        if (outcome.StartError is null && outcome.ExitCode is null && ServerProcess(outcome.Output) is { } server)
            probe.EndServer(server, app.ProcessName, started);

        var diagnostics = outcome.Summary();
        return outcome switch
        {
            { StartError: not null } => new(ConversionStatus.Failed, "Vellum couldn’t start its Office converter, so nothing was saved.", diagnostics),
            { TimedOut: true } => new(ConversionStatus.TimedOut, $"{app.Name} took too long, so the conversion was stopped and nothing was saved.", diagnostics),
            { Cancelled: true } => new(ConversionStatus.Cancelled, null, diagnostics),
            { ExitCode: OfficeHelper.Converted } => ProviderRun.Ok(diagnostics),
            { ExitCode: OfficeHelper.Busy } => new(ConversionStatus.Unavailable,
                BusyReason(job.Format) ?? $"{app.Name} is in use by something else. Close it and try again.", diagnostics),
            { ExitCode: OfficeHelper.Protected } => new(ConversionStatus.Protected, null, diagnostics),
            { ExitCode: OfficeHelper.CantStart } => new(ConversionStatus.Failed, $"{app.Name} couldn’t be started, so nothing was saved.", diagnostics),
            _ => new(ConversionStatus.Failed, $"{app.Name} couldn’t convert this {job.Format.Noun()}, so nothing was saved.", diagnostics),
        };
    }

    /// <summary>
    /// The program in a LocalServer32 command line: `"C:\…\WINWORD.EXE" /Automation`, or unquoted with spaces
    /// (`C:\Program Files\…\WINWORD.EXE /Automation`), environment variables expanded. Null if it names none.
    /// </summary>
    internal static string? ServerPath(string command)
    {
        var text = Environment.ExpandEnvironmentVariables(command).Trim();
        string path;
        if (text.StartsWith('"'))
        {
            var end = text.IndexOf('"', 1);
            if (end < 0) return null;
            path = text[1..end];
        }
        else
        {
            var end = text.IndexOf(".exe", StringComparison.OrdinalIgnoreCase);
            if (end < 0) return null;
            path = text[..(end + 4)];
        }
        return Path.IsPathFullyQualified(path) && path.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) ? path : null;
    }

    /// <summary>16 from "Word.Application.16"; null if CurVer doesn't belong to the ProgID or has no number.</summary>
    internal static int? Version(string progId, string? curVer) =>
        curVer is not null && curVer.StartsWith(progId + ".", StringComparison.OrdinalIgnoreCase)
        && int.TryParse(curVer.AsSpan(progId.Length + 1), out var version) ? version : null;

    /// <summary>The Office process id the helper said it started; null when it started none or said nothing.</summary>
    internal static int? ServerProcess(string output)
    {
        foreach (var line in output.Split('\n', StringSplitOptions.TrimEntries))
            if (line.StartsWith(OfficeHelper.ServerLine, StringComparison.Ordinal))
                return int.TryParse(line.AsSpan(OfficeHelper.ServerLine.Length), out var id) && id > 0 ? id : null;
        return null;
    }
}
