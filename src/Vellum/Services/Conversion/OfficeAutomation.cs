using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;

namespace Vellum.Services.Conversion;

/// <summary>
/// The helper side of MicrosoftOfficeProvider: Vellum.exe --office-to-pdf &lt;word|excel|powerpoint&gt; &lt;input&gt;
/// &lt;output&gt;, started by the provider with a time limit, no window and no single-instance check. It asks the
/// installed application, through its own automation (late bound: no Office libraries are referenced or
/// shipped), to open the input read-only and save it as PDF, then quits it.
///
/// Rules it keeps: it works only in an application instance it started itself (Word and Excel start a new
/// one for automation; PowerPoint has one per person, so an open PowerPoint means "busy" and nothing is
/// done); it never shows the application, runs no macro (AutomationSecurity: force disable), asks nothing
/// (alerts off; Excel's links to other workbooks not updated) and changes no setting that outlives the
/// instance; a password-protected document fails at once instead of prompting, because a password Vellum
/// doesn't have is given; and it quits the application only when nothing else has been opened in it.
/// Everything it can't foresee (a dialog Office shows anyway, a hang) is the provider's time limit's to end.
/// </summary>
internal static class OfficeAutomation
{
    /// <summary>
    /// Given for every password Office might ask for, so a protected document fails instead of prompting. At
    /// most 15 characters: Excel refuses to open even an unprotected workbook when given a longer one.
    /// </summary>
    private const string NotThePassword = "vellum-no-pass";
    /// <summary>Word's "The password is incorrect" (error 5408).</summary>
    private const int WordWrongPassword = unchecked((int)0x800A1520);

    public static int Run(IReadOnlyList<string> args)
    {
        if (args.Count != 3 || OfficeFormats.FromKey(args[0]) is not { } format
            || !Path.IsPathFullyQualified(args[1]) || !Path.IsPathFullyQualified(args[2]) || !File.Exists(args[1]))
        {
            Console.Error.WriteLine($"usage: {OfficeHelper.Switch} <word|excel|powerpoint> <input> <output>");
            return OfficeHelper.Usage;
        }
        try
        {
            return format switch
            {
                OfficeFormat.Word => Word(args[1], args[2]),
                OfficeFormat.Excel => Excel(args[1], args[2]),
                _ => PowerPoint(args[1], args[2]),
            };
        }
        catch (COMException ex) when (ex.ErrorCode == WordWrongPassword)
        {
            Console.Error.WriteLine("The document is protected with a password.");
            return OfficeHelper.Protected;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"{ex.GetType().Name} 0x{ex.HResult:X8}: {ex.Message}");
            return OfficeHelper.Failed;
        }
        finally
        {
            // Office stays running while any reference to it is held (Excel especially), and a process that just
            // exits leaves them to COM's own timeout, minutes later. Release them now.
            GC.Collect();
            GC.WaitForPendingFinalizers();
            GC.Collect();
            GC.WaitForPendingFinalizers();
        }
    }

    private static int Word(string input, string output)
    {
        if (Start("Word.Application", "WINWORD", out var refusal) is not { } started) return refusal;
        dynamic app = started;
        var quit = false;
        try
        {
            app.Visible = false;
            app.DisplayAlerts = 0;         // wdAlertsNone
            app.AutomationSecurity = 3;    // msoAutomationSecurityForceDisable
            var doc = app.Documents.Open(FileName: input, ConfirmConversions: false, ReadOnly: true, AddToRecentFiles: false,
                PasswordDocument: NotThePassword, PasswordTemplate: NotThePassword, Revert: false,
                WritePasswordDocument: NotThePassword, WritePasswordTemplate: NotThePassword,
                Visible: false, OpenAndRepair: false, NoEncodingDialog: true);
            try
            {
                // wdExportFormatPDF, for print, headings as bookmarks, document properties and structure kept.
                doc.ExportAsFixedFormat(OutputFileName: output, ExportFormat: 17, OpenAfterExport: false, OptimizeFor: 0,
                    IncludeDocProps: true, CreateBookmarks: 1, DocStructureTags: true);
            }
            finally { doc.Close(SaveChanges: 0); }
            return OfficeHelper.Converted;
        }
        finally
        {
            try { quit = (int)app.Documents.Count == 0; } catch (COMException) { }
            Close(started, quit, () => app.Quit(SaveChanges: 0));
        }
    }

    private static int Excel(string input, string output)
    {
        if (Start("Excel.Application", "EXCEL", out var refusal) is not { } started) return refusal;
        dynamic app = started;
        var quit = false;
        try
        {
            app.Visible = false;
            app.DisplayAlerts = false;
            app.ScreenUpdating = false;
            app.EnableEvents = false;
            app.AskToUpdateLinks = false;
            app.AutomationSecurity = 3;    // msoAutomationSecurityForceDisable
            var book = app.Workbooks.Open(Filename: input, UpdateLinks: 0, ReadOnly: true, Password: NotThePassword,
                WriteResPassword: NotThePassword, IgnoreReadOnlyRecommended: true, Notify: false, AddToMru: false);
            try
            {
                // xlTypePDF, standard quality, document properties kept, print areas respected.
                book.ExportAsFixedFormat(Type: 0, Filename: output, Quality: 0, IncludeDocProperties: true,
                    IgnorePrintAreas: false, OpenAfterPublish: false);
            }
            finally { book.Close(SaveChanges: false); }
            return OfficeHelper.Converted;
        }
        finally
        {
            try { quit = (int)app.Workbooks.Count == 0; } catch (COMException) { }
            Close(started, quit, () => app.Quit());
        }
    }

    private static int PowerPoint(string input, string output)
    {
        // One PowerPoint per person: if it is open, automation would join it. Never work inside one someone uses.
        if (Ids("POWERPNT").Count > 0) return OfficeHelper.Busy;
        if (Start("PowerPoint.Application", "POWERPNT", out var refusal) is not { } started) return refusal;
        dynamic app = started;
        var quit = false;
        try
        {
            app.DisplayAlerts = 1;         // ppAlertsNone
            app.AutomationSecurity = 3;    // msoAutomationSecurityForceDisable
            // ReadOnly: msoTrue, Untitled: msoFalse, WithWindow: msoFalse — PowerPoint stays out of sight.
            var show = app.Presentations.Open(FileName: input, ReadOnly: -1, Untitled: 0, WithWindow: 0);
            try { show.SaveAs(FileName: output, FileFormat: 32); }   // ppSaveAsPDF
            finally { show.Close(); }
            return OfficeHelper.Converted;
        }
        finally
        {
            try { quit = (int)app.Presentations.Count == 0; } catch (COMException) { }
            Close(started, quit, () => app.Quit());
        }
    }

    /// <summary>
    /// Starts the application through automation and reports its process on stdout for the provider. Null,
    /// with the exit code to give, when it isn’t registered (CantStart) or it joined an instance already
    /// running (Busy, and "attached" reported, so the provider never ends it).
    /// </summary>
    private static object? Start(string progId, string processName, out int refusal)
    {
        refusal = OfficeHelper.CantStart;
        var type = Type.GetTypeFromProgID(progId, throwOnError: false);
        if (type is null)
        {
            Console.Error.WriteLine($"{progId} isn’t registered.");
            return null;
        }
        var before = Ids(processName);
        var app = Activator.CreateInstance(type)!;
        var started = Ids(processName).Except(before).ToList();
        if (started.Count == 1)
        {
            Console.Out.WriteLine($"{OfficeHelper.ServerLine}{started[0]}");
            return app;
        }
        Console.Out.WriteLine(OfficeHelper.ServerLine + OfficeHelper.Attached);
        Console.Error.WriteLine($"{progId} joined an instance Vellum didn’t start, so it was left alone.");
        Marshal.FinalReleaseComObject(app);
        refusal = OfficeHelper.Busy;
        return null;
    }

    private static void Close(object app, bool quit, Action doQuit)
    {
        try { if (quit) doQuit(); }
        catch (COMException) { /* the provider ends it if it is still there when the time is up */ }
        finally { Marshal.FinalReleaseComObject(app); }
    }

    private static List<int> Ids(string processName)
    {
        var processes = Process.GetProcessesByName(processName);
        var ids = processes.Select(p => p.Id).ToList();
        foreach (var process in processes) process.Dispose();
        return ids;
    }
}
