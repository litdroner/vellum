using System.IO;

namespace Vellum.Services.Conversion;

/// <summary>
/// LibreOffice, run headless: soffice --convert-to pdf. Installed means its program (soffice.com, which reports
/// on the console, or soffice.exe) is in a folder the install names or in its default folder. Each kind of
/// document needs its own part of LibreOffice — Writer, Calc, Impress — and an install can leave one out, so
/// a format is offered only when that part's library is there.
///
/// Every conversion gets a LibreOffice profile of its own in the job's work folder, thrown away afterwards: it
/// keeps the conversion apart from a LibreOffice the person has open (which would otherwise take the request
/// over), from their settings and recent documents, and it turns macros off and blocks links to untrusted
/// content, LibreOffice's own settings, set only in that profile.
/// </summary>
public sealed class LibreOfficeProvider(IProcessRunner runner, ProviderProbe probe) : IOfficeProvider
{
    private static readonly (OfficeFormat Format, string Library, string Name)[] Modules =
    [
        (OfficeFormat.Word, "swlo.dll", "Writer"),
        (OfficeFormat.Excel, "sclo.dll", "Calc"),
        (OfficeFormat.PowerPoint, "sdlo.dll", "Impress"),
    ];

    /// <summary>Settings the throwaway profile starts with: no macros, even signed ones; no untrusted links followed.</summary>
    private const string ProfileSettings = """
        <?xml version="1.0" encoding="UTF-8"?>
        <oor:items xmlns:oor="http://openoffice.org/2001/registry" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
        <item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="DisableMacrosExecution" oor:op="fuse"><value>true</value></prop></item>
        <item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop></item>
        <item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="BlockUntrustedRefererLinks" oor:op="fuse"><value>true</value></prop></item>
        </oor:items>
        """;

    public string Id => "libreoffice";
    public string Name => "LibreOffice";

    private sealed record Install(string Program, IReadOnlySet<OfficeFormat> Formats, string Detail);

    private Install? Find()
    {
        foreach (var folder in probe.LibreOfficeFolders())
        {
            var program = new[] { "soffice.com", "soffice.exe" }.Select(name => Path.Combine(folder, name)).FirstOrDefault(probe.FileExists);
            if (program is null) continue;
            var modules = Modules.Where(m => probe.FileExists(Path.Combine(folder, m.Library))).ToList();
            var detail = modules.Count == 0 ? $"no Writer, Calc or Impress in {folder}" : $"{string.Join(", ", modules.Select(m => m.Name))} in {folder}";
            return new Install(program, modules.Select(m => m.Format).ToHashSet(), detail);
        }
        return null;
    }

    public ProviderInstall Detect() => Find() is { } install
        ? new ProviderInstall(true, install.Formats, install.Detail)
        : ProviderInstall.Missing("LibreOffice isn’t installed.");

    // Its own profile makes it its own instance, whatever LibreOffice the person has open.
    public string? BusyReason(OfficeFormat format) => null;

    public async Task<ProviderRun> ConvertAsync(ProviderJob job, CancellationToken cancel)
    {
        if (Find() is not { } install || !install.Formats.Contains(job.Format))
            return new(ConversionStatus.NoProvider, $"LibreOffice can’t convert a {job.Format.Noun()} on this PC any more.");
        var profile = Path.Combine(job.WorkFolder, "profile");
        Directory.CreateDirectory(Path.Combine(profile, "user"));
        File.WriteAllText(Path.Combine(profile, "user", "registrymodifications.xcu"), ProfileSettings);

        var outcome = await runner.RunAsync(new ProcessCall(install.Program, Arguments(job, profile)), job.Timeout, cancel).ConfigureAwait(false);
        var diagnostics = outcome.Summary();
        if (outcome.StartError is not null) return new(ConversionStatus.Failed, "LibreOffice couldn’t be started, so nothing was saved.", diagnostics);
        if (outcome.TimedOut) return new(ConversionStatus.TimedOut, "LibreOffice took too long, so the conversion was stopped and nothing was saved.", diagnostics);
        if (outcome.Cancelled) return new(ConversionStatus.Cancelled, null, diagnostics);

        // LibreOffice names the PDF after the document, in --outdir, and can exit 0 without writing it (a file
        // it can't load): the file is the answer, not the exit code.
        var written = Path.Combine(Path.GetDirectoryName(job.Output)!, Path.GetFileNameWithoutExtension(job.Input) + ".pdf");
        if (outcome.ExitCode != 0 || !File.Exists(written))
            return new(ConversionStatus.Failed, $"LibreOffice couldn’t convert this {job.Format.Noun()}, so nothing was saved.", diagnostics);
        if (!string.Equals(written, job.Output, StringComparison.OrdinalIgnoreCase)) File.Move(written, job.Output, overwrite: true);
        return ProviderRun.Ok(diagnostics);
    }

    /// <summary>The command line, one argument at a time: the profile as a file URL, headless, never restoring or prompting.</summary>
    internal static IReadOnlyList<string> Arguments(ProviderJob job, string profile) =>
    [
        "-env:UserInstallation=" + new Uri(Path.GetFullPath(profile)).AbsoluteUri,
        "--headless",
        "--invisible",
        "--nologo",
        "--nodefault",
        "--norestore",
        "--nolockcheck",
        "--convert-to", "pdf",
        "--outdir", Path.GetDirectoryName(job.Output)!,
        job.Input,
    ];
}
