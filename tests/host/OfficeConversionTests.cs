// Office → PDF providers (src/Vellum/Services/Conversion): detection through a fake probe (no registry, no Office),
// deterministic selection, the structured results and the source and destination rules, both providers' command
// lines and exit codes through a fake runner, and the real process runner's time limit, cancellation and
// process-tree cleanup. Needs neither Microsoft Office nor LibreOffice. VELLUM_OFFICE_SMOKE=1 adds a real
// conversion with whatever this PC has (Vellum's Debug build as the Office helper, or VELLUM_EXE), skipped when
// there is no provider, and bounded by the conversion's own time limit.

using System.Diagnostics;
using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using Vellum.Services.Conversion;
using static Vellum.Services.Conversion.OfficeFormat;

static class OfficeConversionTests
{
    public static async Task Run(Action<string, bool, string?> check, string root)
    {
        void Check(string name, bool ok, string? detail = null) => check(name, ok, detail);
        static string Hash(string path) => Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(path)));
        static bool IsPdf(string path) => File.Exists(path) && File.ReadAllText(path).StartsWith("%PDF-", StringComparison.Ordinal);

        // ---- formats ----
        Check("extensions name their application, in any case",
            OfficeFormats.Of(@"C:\a.DOCX") == Word && OfficeFormats.Of("b.doc") == Word && OfficeFormats.Of("c.xlsx") == Excel
            && OfficeFormats.Of("d.XLS") == Excel && OfficeFormats.Of("e.pptx") == PowerPoint && OfficeFormats.Of("f.ppt") == PowerPoint);
        Check("anything else isn't an Office document here",
            OfficeFormats.Of("a.pdf") is null && OfficeFormats.Of("a.docm") is null && OfficeFormats.Of("a.odt") is null && OfficeFormats.Of("noext") is null);
        Check("format keys are stable and round-trip",
            Enum.GetValues<OfficeFormat>().All(f => OfficeFormats.FromKey(f.Key()) == f) && Word.Key() == "word" && OfficeFormats.FromKey("Word") is null);

        // ---- Microsoft Office: detection ----
        const string Helper = @"C:\Vellum\Vellum.exe";
        var runner = new FakeRunner();
        var probe = new FakeProbe();
        var office = new MicrosoftOfficeProvider(Helper, runner, probe);
        Check("no Office registered: not installed, nothing claimed", office.Detect() is { Installed: false, Formats.Count: 0 });
        probe.Office("Word.Application", "WINWORD.EXE");
        probe.Office("Excel.Application", "EXCEL.EXE");
        Check("Word and Excel registered: Word and Excel documents only",
            office.Detect() is { Installed: true } both && both.Formats.SetEquals([Word, Excel]), office.Detect().Detail);
        probe.Com["PowerPoint.Application"] = (@"C:\Program Files\Microsoft Office\root\Office16\POWERPNT.EXE /AUTOMATION", "PowerPoint.Application.16");
        Check("a registration whose program isn't on disk claims nothing", !office.Detect().Formats.Contains(PowerPoint));
        probe.Com["PowerPoint.Application"] = (@"C:\Other Suite\wpp.exe /Automation", "PowerPoint.Application.16");
        probe.Files.Add(@"C:\Other Suite\wpp.exe");
        Check("a ProgID taken over by another program claims nothing", !office.Detect().Formats.Contains(PowerPoint));

        var oldProbe = new FakeProbe();
        oldProbe.Office("Word.Application", "WINWORD.EXE", version: 12);
        var old = new MicrosoftOfficeProvider(Helper, runner, oldProbe).Detect();
        Check("Office 2007 is installed but can't save PDF by itself", old is { Installed: true, Formats.Count: 0 } && old.Detail.Contains("too old"), old.Detail);
        oldProbe.Com["Word.Application"] = (oldProbe.Com["Word.Application"].Server, null);
        Check("an application whose version can't be read isn't used", new MicrosoftOfficeProvider(Helper, runner, oldProbe).Detect() is { Installed: true, Formats.Count: 0 });
        var quotedProbe = new FakeProbe();
        quotedProbe.Com["Word.Application"] = ("\"C:\\Program Files (x86)\\Microsoft Office\\Office14\\WINWORD.EXE\" /Automation", "Word.Application.14");
        quotedProbe.Files.Add(@"C:\Program Files (x86)\Microsoft Office\Office14\WINWORD.EXE");
        Check("a quoted 32-bit Office 2010 server is found", new MicrosoftOfficeProvider(Helper, runner, quotedProbe).Detect().Formats.SetEquals([Word]));

        Check("server command: quoted", MicrosoftOfficeProvider.ServerPath("\"C:\\A B\\WINWORD.EXE\" /Automation") == @"C:\A B\WINWORD.EXE");
        Check("server command: unquoted with spaces and a switch",
            MicrosoftOfficeProvider.ServerPath(@"C:\Program Files\Microsoft Office\Root\Office16\EXCEL.EXE /automation") == @"C:\Program Files\Microsoft Office\Root\Office16\EXCEL.EXE");
        Check("server command: environment variables expanded",
            MicrosoftOfficeProvider.ServerPath(@"%SystemRoot%\x\WINWORD.EXE /Automation") == Path.Combine(Environment.GetEnvironmentVariable("SystemRoot") ?? "", "x", "WINWORD.EXE"));
        Check("server command: relative, empty, unterminated or not a program is nothing",
            MicrosoftOfficeProvider.ServerPath("WINWORD.EXE /Automation") is null && MicrosoftOfficeProvider.ServerPath("") is null
            && MicrosoftOfficeProvider.ServerPath("\"C:\\A\\WINWORD.EXE") is null && MicrosoftOfficeProvider.ServerPath(@"C:\A\word.dll") is null);
        Check("version comes from the ProgID's own CurVer",
            MicrosoftOfficeProvider.Version("Word.Application", "Word.Application.16") == 16
            && MicrosoftOfficeProvider.Version("Word.Application", "Excel.Application.16") is null
            && MicrosoftOfficeProvider.Version("Word.Application", "Word.Application") is null);
        Check("the helper's server line is read, and 'attached' names no process",
            MicrosoftOfficeProvider.ServerProcess("server 4242\r\n") == 4242 && MicrosoftOfficeProvider.ServerProcess("noise\nserver 17\n") == 17
            && MicrosoftOfficeProvider.ServerProcess("server attached\n") is null && MicrosoftOfficeProvider.ServerProcess("") is null);

        // ---- LibreOffice: detection ----
        var loProbe = new FakeProbe();
        var libre = new LibreOfficeProvider(runner, loProbe);
        Check("no LibreOffice: not installed", libre.Detect() is { Installed: false, Formats.Count: 0 });
        loProbe.LibreOffice(@"C:\Stale\LibreOffice\program", "swlo.dll");
        loProbe.LibreOffice(@"C:\Program Files\LibreOffice\program", "soffice.exe", "soffice.com", "swlo.dll", "sdlo.dll");
        Check("LibreOffice is the first folder with its program, offering the parts it has (no Calc here)",
            libre.Detect() is { Installed: true } lo && lo.Formats.SetEquals([Word, PowerPoint]) && lo.Detail.Contains(@"C:\Program Files\LibreOffice\program"), libre.Detect().Detail);
        var bare = new FakeProbe();
        bare.LibreOffice(@"C:\LO\program", "soffice.exe");
        Check("LibreOffice without Writer, Calc or Impress converts nothing", new LibreOfficeProvider(runner, bare).Detect() is { Installed: true, Formats.Count: 0 });

        // ---- selection ----
        var work = Path.Combine(root, "work folder ✓");
        var both2 = new FakeProbe();
        both2.Office("Word.Application", "WINWORD.EXE");
        both2.Office("Excel.Application", "EXCEL.EXE");
        both2.LibreOffice(@"C:\LO\program", "soffice.com", "swlo.dll", "sclo.dll", "sdlo.dll");
        var officeB = new MicrosoftOfficeProvider(Helper, runner, both2);
        var libreB = new LibreOfficeProvider(runner, both2);
        var service = new OfficeConversion([officeB, libreB], work);
        Check("Microsoft Office is chosen first when it can convert the format", service.Plan(Word).Provider == officeB);
        Check("LibreOffice is chosen when Office can't (no PowerPoint)", service.Plan(PowerPoint).Provider == libreB);
        Check("the same PC state always chooses the same provider", Enumerable.Range(0, 5).All(_ => service.Plan(Excel).Provider == officeB));
        Check("a named provider is the only one considered", service.Plan(Word, "libreoffice").Provider == libreB);
        Check("an unknown provider name is refused", service.Plan(Word, "cloud") is { Provider: null, Refusal: ConversionStatus.NoProvider });
        Check("providers are reported in selection order, with their formats",
            service.Report() is [{ Id: "microsoft-office", Installed: true } r1, { Id: "libreoffice", Installed: true } r2]
            && r1.Formats.SequenceEqual([Word, Excel]) && r2.Formats.SequenceEqual([Word, Excel, PowerPoint]));
        both2.Office("PowerPoint.Application", "POWERPNT.EXE");
        both2.Running.Add("POWERPNT");
        Check("PowerPoint open: Office is busy for presentations, so LibreOffice converts them", service.Plan(PowerPoint).Provider == libreB);
        Check("… while Office still converts Word documents", service.Plan(Word).Provider == officeB);
        var officeOnly = new OfficeConversion([officeB], work);
        Check("PowerPoint open and no other provider: unavailable, with the reason",
            officeOnly.Plan(PowerPoint) is { Provider: null, Refusal: ConversionStatus.Unavailable, Reason: { } busy } && busy.Contains("PowerPoint is open"));
        var nothing = new OfficeConversion([new MicrosoftOfficeProvider(Helper, runner, new FakeProbe()), new LibreOfficeProvider(runner, new FakeProbe())], work);
        Check("nothing installed: no provider, and the message says what would help",
            nothing.Plan(Word) is { Provider: null, Refusal: ConversionStatus.NoProvider, Reason: { } none } && none.Contains("Microsoft Office or LibreOffice"));
        var wordOnly = new FakeProbe();
        wordOnly.Office("Word.Application", "WINWORD.EXE");
        Check("installed but unable to convert the format: not supported",
            new OfficeConversion([new MicrosoftOfficeProvider(Helper, runner, wordOnly)], work).Plan(Excel) is { Provider: null, Refusal: ConversionStatus.NotSupported });
        Check("a provider whose detection fails counts as not installed",
            new OfficeConversion([new FakeProvider("broken", Word) { DetectFails = true }], work).Plan(Word).Refusal == ConversionStatus.NoProvider);
        var busyFirst = new FakeProvider("first", Word) { Busy = "In use." };
        var free = new FakeProvider("second", Word);
        Check("a busy provider is passed over for the next one that can convert", new OfficeConversion([busyFirst, free], work).Plan(Word).Provider == free);
        Check("… and when every capable provider is busy, the first one's reason is given",
            new OfficeConversion([busyFirst, new FakeProvider("third", Word) { Busy = "Also in use." }], work).Plan(Word) is { Refusal: ConversionStatus.Unavailable, Reason: "In use." });
        Check("two providers can't share an id", Throws(() => new OfficeConversion([new FakeProvider("x", Word), new FakeProvider("x", Excel)], work)));

        // ---- the operation: office.toPdf with a fake provider, on real files ----
        var docs = Path.Combine(root, "office docs ünï ✓");
        Directory.CreateDirectory(docs);
        string Doc(string name, byte[] bytes) { var p = Path.Combine(docs, name); File.WriteAllBytes(p, bytes); return p; }
        var zipLike = (byte[])[0x50, 0x4B, 0x03, 0x04, .. RandomNumberGenerator.GetBytes(500)];
        var source = Doc("Quarterly report – draft ✓.docx", zipLike);
        var sourceHash = Hash(source);
        var destination = Path.Combine(docs, "Quarterly report – draft ✓.pdf");
        var fake = new FakeProvider("fake", Word, Excel, PowerPoint);
        var ops = new OfficeConversion([fake], work);

        var result = await ops.ConvertAsync(new OfficeToPdfRequest(source, destination));
        var job = fake.Jobs.Single();
        Check("a conversion writes the PDF where it was asked", result is { Status: ConversionStatus.Converted, Succeeded: true } && result.Output == destination && IsPdf(destination), $"{result.Status}: {result.Message}");
        Check("… says which provider did it", result.Provider == "fake" && result.Message == "Converted with Fake fake.", result.Message);
        Check("… hands the provider a private copy under a plain name, never the source",
            job.Input != source && Path.GetFileName(job.Input) == "document.docx" && job.Input.StartsWith(work, StringComparison.OrdinalIgnoreCase) && job.Format == Word);
        Check("… with the default time limit", job.Timeout == OfficeConversion.DefaultTimeout);
        Check("… leaves the source exactly as it was", Hash(source) == sourceHash);
        Check("… and leaves no work folder or partial file behind",
            !Directory.EnumerateFileSystemEntries(work).Any() && !File.Exists(destination + ".part"));
        Check("… and reports how long it took", result.Elapsed > TimeSpan.Zero);

        async Task<ConversionResult> Refusal(string src, string dest, TimeSpan? timeout = null)
        {
            var calls = fake.Jobs.Count;
            var r = await ops.ConvertAsync(new OfficeToPdfRequest(src, dest, Timeout: timeout));
            return fake.Jobs.Count == calls ? r : r with { Message = "PROVIDER WAS CALLED: " + r.Message };
        }
        var pdfOut = Path.Combine(docs, "out.pdf");
        Check("a relative source is refused", (await Refusal("report.docx", pdfOut)).Status == ConversionStatus.InvalidInput);
        Check("a file that isn't an Office document is refused",
            (await Refusal(Doc("notes.txt", [1, 2, 3]), pdfOut)) is { Status: ConversionStatus.UnsupportedFormat } u && u.Message.Contains(".docx"));
        Check("a missing document is refused", (await Refusal(Path.Combine(docs, "gone.docx"), pdfOut)).Status == ConversionStatus.InvalidInput);
        Check("an empty document is refused", (await Refusal(Doc("empty.doc", []), pdfOut)) is { Status: ConversionStatus.InvalidInput } e && e.Message.Contains("empty"));
        Check("a .docx that isn't a package is refused",
            (await Refusal(Doc("fake.docx", "hello, not a document"u8.ToArray()), pdfOut)) is { Status: ConversionStatus.InvalidInput } f && f.Message.Contains("isn’t a valid Word document"));
        // A password-protected .pptx: an OLE file with an EncryptedPackage stream, here straddling the reader's 64 KB blocks.
        var encrypted = new byte[80_000];
        byte[] ole = [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1];
        ole.CopyTo(encrypted, 0);
        Encoding.Unicode.GetBytes("EncryptedPackage").CopyTo(encrypted, 64 * 1024 - 9);
        var protectedResult = await Refusal(Doc("locked.pptx", encrypted), pdfOut);
        Check("a password-protected document is refused before any application starts",
            protectedResult is { Status: ConversionStatus.Protected } && protectedResult.Message.Contains("password"), protectedResult.Message);
        encrypted.AsSpan(64 * 1024 - 9, 32).Clear();
        Check("an OLE file without an encrypted package goes on to the provider (an older document renamed)",
            (await ops.ConvertAsync(new OfficeToPdfRequest(Doc("renamed.xlsx", encrypted), pdfOut))).Succeeded);
        Check("an older .ppt is left to the application to read", (await ops.ConvertAsync(new OfficeToPdfRequest(Doc("old deck.ppt", [1, 2, 3]), pdfOut))).Succeeded);
        Check("a destination that isn't a .pdf is refused", (await Refusal(source, Path.Combine(docs, "out.docx"))).Status == ConversionStatus.InvalidInput);
        Check("a relative destination is refused", (await Refusal(source, "out.pdf")).Status == ConversionStatus.InvalidInput);
        Check("a destination in a missing folder is refused", (await Refusal(source, Path.Combine(docs, "nowhere", "out.pdf"))).Status == ConversionStatus.InvalidInput);
        Directory.CreateDirectory(Path.Combine(docs, "folder.pdf"));
        Check("a destination that is a folder is refused", (await Refusal(source, Path.Combine(docs, "folder.pdf"))).Status == ConversionStatus.InvalidInput);
        Check("a time limit of nothing, or over 30 minutes, is refused",
            (await Refusal(source, pdfOut, TimeSpan.Zero)).Status == ConversionStatus.InvalidInput
            && (await Refusal(source, pdfOut, TimeSpan.FromHours(1))).Status == ConversionStatus.InvalidInput);
        Check("no provider installed: refused with that reason, nothing written",
            (await new OfficeConversion([new FakeProvider("gone", Word) { Installed = false }], work).ConvertAsync(new(source, Path.Combine(docs, "never.pdf"))))
                is { Status: ConversionStatus.NoProvider } && !File.Exists(Path.Combine(docs, "never.pdf")));

        // Failures: the destination is never touched, whatever went wrong.
        var kept = Path.Combine(docs, "kept.pdf");
        File.WriteAllText(kept, "%PDF-1.4 the person's own earlier file");
        async Task<ConversionResult> Failing(Func<ProviderJob, CancellationToken, Task<ProviderRun>> convert, CancellationToken cancel = default)
        {
            fake.Convert = convert;
            try { return await ops.ConvertAsync(new OfficeToPdfRequest(source, kept), cancel); }
            finally { fake.Convert = FakeProvider.WritePdf; }
        }
        bool Untouched() => File.ReadAllText(kept) == "%PDF-1.4 the person's own earlier file" && !File.Exists(kept + ".part") && !Directory.EnumerateFileSystemEntries(work).Any();
        var notPdf = await Failing((j, _) => { File.WriteAllText(j.Output, "<html>not a pdf</html>"); return Task.FromResult(ProviderRun.Ok()); });
        Check("a provider that writes something other than a PDF has failed", notPdf is { Status: ConversionStatus.Failed, Output: null } && notPdf.Message.Contains("without writing a PDF") && Untouched(), notPdf.Message);
        var failed = await Failing((_, _) => Task.FromResult(new ProviderRun(ConversionStatus.Failed, null, "exit 1; stderr: it broke")));
        Check("a provider's failure is reported with its diagnostics", failed is { Status: ConversionStatus.Failed, Provider: "fake", Diagnostics: "exit 1; stderr: it broke" } && Untouched(), failed.Message);
        var threw = await Failing((_, _) => throw new InvalidOperationException("surprise"));
        Check("a provider that throws has failed, and says how", threw is { Status: ConversionStatus.Failed } && threw.Diagnostics!.Contains("InvalidOperationException") && Untouched());
        var slow = await Failing((_, _) => Task.FromResult(new ProviderRun(ConversionStatus.TimedOut)));
        Check("a provider out of time reports it", slow is { Status: ConversionStatus.TimedOut } && slow.Message.Contains("took too long") && Untouched(), slow.Message);
        using (var cancel = new CancellationTokenSource(TimeSpan.FromMilliseconds(150)))
        {
            var stopped = await Failing(async (_, c) => { await Task.Delay(Timeout.Infinite, c); return ProviderRun.Ok(); }, cancel.Token);
            Check("a cancelled conversion stops, saves nothing and cleans up", stopped is { Status: ConversionStatus.Cancelled } && Untouched(), stopped.Status.ToString());
        }
        var running = 0;
        var most = 0;
        fake.Convert = async (j, _) =>
        {
            most = Math.Max(most, Interlocked.Increment(ref running));
            await Task.Delay(80);
            Interlocked.Decrement(ref running);
            return await FakeProvider.WritePdf(j, default);
        };
        var together = await Task.WhenAll(ops.ConvertAsync(new(source, Path.Combine(docs, "one.pdf"))), ops.ConvertAsync(new(source, Path.Combine(docs, "two.pdf"))));
        fake.Convert = FakeProvider.WritePdf;
        Check("conversions run one at a time", together.All(r => r.Succeeded) && most == 1, $"most at once: {most}");

        // ---- Microsoft Office: running the helper (a fake runner stands in for the process) ----
        var jobFolder = Path.Combine(root, "office job");
        Directory.CreateDirectory(Path.Combine(jobFolder, "out"));
        var officeJob = new ProviderJob(Word, Path.Combine(jobFolder, "in", "document.docx"), Path.Combine(jobFolder, "out", "document.pdf"), jobFolder, TimeSpan.FromSeconds(60));
        async Task<ProviderRun> RunHelper(ProcessOutcome outcome, FakeProbe? p = null)
        {
            runner.Calls.Clear();
            runner.Answer = _ => outcome;
            return await new MicrosoftOfficeProvider(Helper, runner, p ?? probe).ConvertAsync(officeJob, default);
        }
        var ok = await RunHelper(new(0, false, false, "server 4242\n", ""));
        Check("Office conversions run in Vellum's helper, one argument at a time",
            runner.Calls.Single() is { FileName: Helper } call && call.Arguments.SequenceEqual(["--office-to-pdf", "word", officeJob.Input, officeJob.Output]));
        Check("… exit 0 is converted, and a helper that finished ends nothing", ok.Status == ConversionStatus.Converted && probe.Ended.Count == 0);
        Check("… exit 3 is busy", (await RunHelper(new(3, false, false, "", ""))).Status == ConversionStatus.Unavailable);
        Check("… exit 4 is password-protected", (await RunHelper(new(4, false, false, "", ""))).Status == ConversionStatus.Protected);
        var comFailure = await RunHelper(new(1, false, false, "server 12\n", "COMException 0x800A175D: Word could not open the document"));
        Check("… any other exit has failed, with the helper's own words as diagnostics",
            comFailure is { Status: ConversionStatus.Failed } && comFailure.Diagnostics!.Contains("0x800A175D") && comFailure.Message?.Contains("Word") == true, comFailure.Diagnostics);
        Check("… exit 5 says Word couldn't be started", (await RunHelper(new(5, false, false, "", ""))).Message!.Contains("couldn’t be started"));
        var timedOut = await RunHelper(new(null, true, false, "server 4242\n", ""));
        Check("out of time: timed out, and the Word the helper started is ended too",
            timedOut.Status == ConversionStatus.TimedOut && probe.Ended.SequenceEqual([(4242, "WINWORD")]), string.Join(",", probe.Ended));
        probe.Ended.Clear();
        await RunHelper(new(null, true, false, "server attached\n", ""));
        Check("… but never an Office the helper didn't start", probe.Ended.Count == 0);
        var cancelled = await RunHelper(new(null, false, true, "server 99\n", ""));
        Check("cancelled: the Word it started is ended as well", cancelled.Status == ConversionStatus.Cancelled && probe.Ended.SequenceEqual([(99, "WINWORD")]));
        probe.Ended.Clear();
        var noHelper = await RunHelper(new(null, false, false, "", "", "The system cannot find the file specified."));
        Check("a helper that can't start has failed, and ends nothing", noHelper is { Status: ConversionStatus.Failed } && noHelper.Diagnostics!.Contains("cannot find") && probe.Ended.Count == 0);

        runner.Answer = call => { File.WriteAllText(call.Arguments[3], "%PDF-1.7 from the helper"); return new(0, false, false, "server 7\n", ""); };
        var viaOffice = await service.ConvertAsync(new(source, Path.Combine(docs, "via office.pdf")));
        Check("through the operation, a Word document is converted with Microsoft Office",
            viaOffice is { Status: ConversionStatus.Converted, Provider: "microsoft-office", Message: "Converted with Microsoft Office." } && IsPdf(Path.Combine(docs, "via office.pdf")), viaOffice.Message);

        // ---- LibreOffice: running soffice (fake runner) ----
        var profileSeen = false;
        runner.Calls.Clear();
        runner.Answer = call =>
        {
            var args = call.Arguments;
            var outdir = args[args.ToList().IndexOf("--outdir") + 1];
            var profileUrl = args[0]["-env:UserInstallation=".Length..];
            profileSeen = File.Exists(Path.Combine(new Uri(profileUrl).LocalPath, "user", "registrymodifications.xcu"));
            File.WriteAllText(Path.Combine(outdir, Path.GetFileNameWithoutExtension(args[^1]) + ".pdf"), "%PDF-1.7 from soffice");
            return new(0, false, false, "convert document.pptx -> document.pdf using filter : impress_pdf_Export", "");
        };
        var deck = Doc("Board deck ✓.pptx", zipLike);
        var viaLibre = await service.ConvertAsync(new(deck, Path.Combine(docs, "Board deck ✓.pdf")));
        var soffice = runner.Calls.Single();
        Check("through the operation, a presentation is converted with LibreOffice while PowerPoint is open",
            viaLibre is { Status: ConversionStatus.Converted, Provider: "libreoffice", Message: "Converted with LibreOffice." }, $"{viaLibre.Status}: {viaLibre.Message}");
        Check("… running soffice.com from the install, headless, one argument at a time",
            soffice.FileName == @"C:\LO\program\soffice.com" && soffice.Arguments.Contains("--headless") && soffice.Arguments.Contains("--norestore")
            && soffice.Arguments.SkipWhile(a => a != "--convert-to").Skip(1).FirstOrDefault() == "pdf" && soffice.Arguments[^1].EndsWith("document.pptx"),
            string.Join(" | ", soffice.Arguments));
        Check("… in a profile of its own, given as an escaped file URL, set up before it starts",
            soffice.Arguments[0].StartsWith("-env:UserInstallation=file:///") && !soffice.Arguments[0].Contains(' ') && profileSeen, soffice.Arguments[0]);
        Check("… and the profile is thrown away afterwards", !Directory.EnumerateFileSystemEntries(work).Any());
        runner.Answer = _ => new(0, false, false, "", "Error: source file could not be loaded");
        var unloaded = await service.ConvertAsync(new(deck, Path.Combine(docs, "unloaded.pdf")));
        Check("LibreOffice exiting 0 without a PDF has failed, with its error as diagnostics",
            unloaded is { Status: ConversionStatus.Failed, Provider: "libreoffice" } && unloaded.Diagnostics!.Contains("could not be loaded") && !File.Exists(Path.Combine(docs, "unloaded.pdf")));
        runner.Answer = _ => new(81, false, false, "", "");
        Check("LibreOffice exiting with an error has failed", (await service.ConvertAsync(new(deck, Path.Combine(docs, "x.pdf")))).Status == ConversionStatus.Failed);
        runner.Answer = _ => new(null, true, false, "", "");
        Check("LibreOffice out of time has timed out", (await service.ConvertAsync(new(deck, Path.Combine(docs, "x.pdf")))).Status == ConversionStatus.TimedOut);

        // ---- the real process runner ----
        var real = new ProcessRunner();
        var cmd = Environment.GetEnvironmentVariable("ComSpec") ?? @"C:\Windows\System32\cmd.exe";
        string[] awkward = ["two words", "quote \" inside", @"trailing\", @"C:\Path With Spaces\file name.docx", "ünïcode ✓", "", "a&b|c>d"];
        var echoed = await real.RunAsync(Self(["--echo-args", .. awkward]), TimeSpan.FromSeconds(30), default);
        var back = echoed.Output.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).Select(line => Uri.UnescapeDataString(line[1..^1])).ToArray();
        Check("arguments reach the program exactly, spaces, quotes, unicode and shell characters included",
            echoed.ExitCode == 0 && back.SequenceEqual(awkward), echoed.Summary());
        var exit = await real.RunAsync(new ProcessCall(cmd, ["/d", "/c", "exit", "7"]), TimeSpan.FromSeconds(30), default);
        Check("the exit code is reported", exit is { ExitCode: 7, TimedOut: false, Cancelled: false }, exit.Summary());
        var missing = await real.RunAsync(new ProcessCall(Path.Combine(root, "no such program.exe"), []), TimeSpan.FromSeconds(5), default);
        Check("a program that isn't there is reported, not thrown", missing is { ExitCode: null, StartError: not null }, missing.Summary());
        var clock = Stopwatch.StartNew();
        var runStart = DateTime.Now.AddSeconds(-1);
        var late = await real.RunAsync(new ProcessCall(cmd, ["/d", "/c", "ping", "-n", "30", "127.0.0.1"]), TimeSpan.FromSeconds(1), default);
        Check("a program past its time limit is stopped, promptly", late is { TimedOut: true, ExitCode: null, Cancelled: false } && clock.Elapsed < TimeSpan.FromSeconds(10), $"{late.Summary()} after {clock.Elapsed}");
        Check("… with every process it started (cmd's ping included)", StartedSince("PING", runStart) == 0);
        using (var cancel = new CancellationTokenSource(TimeSpan.FromMilliseconds(300)))
        {
            var stopped = await real.RunAsync(new ProcessCall(cmd, ["/d", "/c", "ping", "-n", "30", "127.0.0.1"]), TimeSpan.FromSeconds(30), cancel.Token);
            Check("a cancelled program is stopped and reported as cancelled", stopped is { Cancelled: true, TimedOut: false, ExitCode: null }, stopped.Summary());
        }
        Check("an already-cancelled run starts nothing", (await real.RunAsync(new ProcessCall(cmd, ["/d", "/c", "exit", "0"]), TimeSpan.FromSeconds(5), new CancellationToken(true))) is { Cancelled: true, ExitCode: null });

        // ---- one real conversion, only when asked for ----
        if (Environment.GetEnvironmentVariable("VELLUM_OFFICE_SMOKE") != "1")
        {
            Console.WriteLine("skip real Office conversion (VELLUM_OFFICE_SMOKE=1 runs one with whatever this PC has)");
            return;
        }
        var vellum = Environment.GetEnvironmentVariable("VELLUM_EXE")
            ?? Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "..", "src", "Vellum", "bin", "Debug", "net10.0-windows", "Vellum.exe"));
        var smoke = OfficeConversion.Create(Path.Combine(root, "smoke data ✓"), vellum);
        foreach (var (format, name, bytes, process) in new[] { (Word, "Smoke test ✓.docx", Docx(), "WINWORD"), (Excel, "Smoke sheet ✓.xlsx", Xlsx(), "EXCEL") })
        {
            var plan = smoke.Plan(format);
            if (plan.Provider is null) { Console.WriteLine($"skip real {format} conversion: {plan.Reason}"); continue; }
            if (plan.Provider.Id == "microsoft-office" && !File.Exists(vellum)) { Console.WriteLine($"skip real {format} conversion: build Vellum first ({vellum})"); continue; }
            var started = DateTime.Now.AddSeconds(-1);
            var real1 = await smoke.ConvertAsync(new(Doc(name, bytes), Path.Combine(docs, Path.ChangeExtension(name, ".pdf")), Timeout: TimeSpan.FromSeconds(90)));
            Check($"real: {name} converts with {plan.Provider.Name}", real1.Succeeded && IsPdf(real1.Output!), $"{real1.Status}: {real1.Message} [{real1.Diagnostics}]");
            // Office takes a moment to exit after quitting: wait for it, a bounded 15 s.
            var gone = Stopwatch.StartNew();
            while (plan.Provider.Id == "microsoft-office" && StartedSince(process, started) > 0 && gone.Elapsed < TimeSpan.FromSeconds(15)) await Task.Delay(250);
            Check($"real: no {process} started by the conversion is left running", StartedSince(process, started) == 0);
            Console.WriteLine($"     {plan.Provider.Name}, {real1.Elapsed.TotalSeconds:0.0} s");
        }
    }

    static bool Throws(Action run)
    {
        try { run(); return false; } catch (Exception) { return true; }
    }

    /// <summary>This test program, run again with `args` (through dotnet when that is how it runs).</summary>
    static ProcessCall Self(string[] args)
    {
        var exe = Environment.ProcessPath!;
        return Path.GetFileNameWithoutExtension(exe).Equals("dotnet", StringComparison.OrdinalIgnoreCase)
            ? new ProcessCall(exe, [typeof(OfficeConversionTests).Assembly.Location, .. args])
            : new ProcessCall(exe, args);
    }

    static int StartedSince(string processName, DateTime since)
    {
        var count = 0;
        foreach (var process in Process.GetProcessesByName(processName))
        {
            try { if (process.StartTime >= since) count++; } catch (Exception) { /* exited while looking */ }
            process.Dispose();
        }
        return count;
    }

    static byte[] Package(params (string Name, string Xml)[] parts)
    {
        using var memory = new MemoryStream();
        using (var zip = new ZipArchive(memory, ZipArchiveMode.Create))
            foreach (var (name, xml) in parts)
            {
                using var writer = new StreamWriter(zip.CreateEntry(name).Open(), new UTF8Encoding(false));
                writer.Write(xml);
            }
        return memory.ToArray();
    }

    const string Xml = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>""";

    static byte[] Docx() => Package(
        ("[Content_Types].xml", Xml + """<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>"""),
        ("_rels/.rels", Xml + """<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>"""),
        ("word/document.xml", Xml + """<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Vellum smoke test ✓</w:t></w:r></w:p></w:body></w:document>"""));

    static byte[] Xlsx() => Package(
        ("[Content_Types].xml", Xml + """<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>"""),
        ("_rels/.rels", Xml + """<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>"""),
        ("xl/workbook.xml", Xml + """<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>"""),
        ("xl/_rels/workbook.xml.rels", Xml + """<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>"""),
        ("xl/worksheets/sheet1.xml", Xml + """<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Vellum smoke test ✓</t></is></c><c r="B1"><v>42</v></c></row></sheetData></worksheet>"""));
}

/// <summary>This PC as the providers see it, made up: COM registrations, files, running processes; what EndServer was asked to end.</summary>
sealed class FakeProbe : ProviderProbe
{
    public readonly Dictionary<string, (string? Server, string? CurVer)> Com = [];
    public readonly HashSet<string> Files = new(StringComparer.OrdinalIgnoreCase);
    public readonly List<string> Folders = [];
    public readonly HashSet<string> Running = new(StringComparer.OrdinalIgnoreCase);
    public readonly List<(int Id, string Name)> Ended = [];

    public override (string? Server, string? CurrentVersion) ComServer(string progId) => Com.TryGetValue(progId, out var c) ? c : (null, null);
    public override IEnumerable<string> LibreOfficeFolders() => Folders;
    public override bool FileExists(string path) => Files.Contains(path);
    public override bool IsRunning(string processName) => Running.Contains(processName);
    public override void EndServer(int id, string processName, DateTime startedAfter) => Ended.Add((id, processName));

    /// <summary>A Click-to-Run style registration: unquoted path with spaces, then the automation switch.</summary>
    public void Office(string progId, string program, int version = 16)
    {
        var path = $@"C:\Program Files\Microsoft Office\root\Office16\{program}";
        Com[progId] = ($"{path} /Automation", $"{progId}.{version}");
        Files.Add(path);
    }

    public void LibreOffice(string folder, params string[] files)
    {
        Folders.Add(folder);
        foreach (var file in files) Files.Add(Path.Combine(folder, file));
    }
}

sealed class FakeRunner : IProcessRunner
{
    public readonly List<ProcessCall> Calls = [];
    public Func<ProcessCall, ProcessOutcome> Answer = _ => new(0, false, false, "", "");

    public Task<ProcessOutcome> RunAsync(ProcessCall call, TimeSpan timeout, CancellationToken cancel)
    {
        Calls.Add(call);
        return Task.FromResult(Answer(call));
    }
}

sealed class FakeProvider(string id, params OfficeFormat[] formats) : IOfficeProvider
{
    public static readonly Func<ProviderJob, CancellationToken, Task<ProviderRun>> WritePdf = (job, _) =>
    {
        File.WriteAllText(job.Output, "%PDF-1.7\n% made by a fake provider\n");
        return Task.FromResult(ProviderRun.Ok());
    };

    public bool Installed = true;
    public bool DetectFails;
    public string? Busy;
    public readonly List<ProviderJob> Jobs = [];
    public Func<ProviderJob, CancellationToken, Task<ProviderRun>> Convert = WritePdf;

    public string Id => id;
    public string Name => "Fake " + id;
    public ProviderInstall Detect() => DetectFails ? throw new IOException("registry gone")
        : Installed ? new ProviderInstall(true, formats.ToHashSet(), "fake") : ProviderInstall.Missing("fake, not installed");
    public string? BusyReason(OfficeFormat format) => Busy;
    public Task<ProviderRun> ConvertAsync(ProviderJob job, CancellationToken cancel)
    {
        Jobs.Add(job);
        return Convert(job, cancel);
    }
}
