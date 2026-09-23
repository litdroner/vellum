using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

namespace Vellum.Services.Conversion;

/// <summary>One program to run: its path and its arguments, each passed as it is (never joined into a command line by hand).</summary>
public sealed record ProcessCall(string FileName, IReadOnlyList<string> Arguments);

/// <summary>
/// How a run ended. ExitCode is null when the program never started (StartError says why) or was stopped,
/// because it ran out of time (TimedOut) or was cancelled (Cancelled). Output and Error are the last few
/// thousand characters of each stream: diagnostics, never words for a person.
/// </summary>
public sealed record ProcessOutcome(int? ExitCode, bool TimedOut, bool Cancelled, string Output, string Error, string? StartError = null)
{
    public string Summary()
    {
        var how = StartError is not null ? $"not started: {StartError}"
            : TimedOut ? "stopped: out of time"
            : Cancelled ? "stopped: cancelled"
            : $"exit {ExitCode}";
        var text = new StringBuilder(how);
        if (Error.Trim() is { Length: > 0 } error) text.Append("; stderr: ").Append(error);
        if (Output.Trim() is { Length: > 0 } output) text.Append("; stdout: ").Append(output);
        return text.ToString();
    }
}

/// <summary>Runs a program to completion within a time limit. The conversion providers' only way to start one.</summary>
public interface IProcessRunner
{
    Task<ProcessOutcome> RunAsync(ProcessCall call, TimeSpan timeout, CancellationToken cancel);
}

/// <summary>
/// The real runner: no shell and no window, arguments passed one by one, stdin closed, both output streams
/// kept (their tails). Every run has a deadline; past it, or when cancelled, the program and every process it
/// started are ended, and the run is waited for only a few seconds more. The program also runs in a Windows
/// job that ends whatever is still in it when the run is over, or when Vellum itself ends, so a converter's
/// helpers (soffice.bin under soffice.exe) can't be left behind; the job also stops a crash in one of them
/// from opening an error dialog.
/// </summary>
public sealed class ProcessRunner : IProcessRunner
{
    private const int KeptChars = 8_000;
    private static readonly TimeSpan KillWait = TimeSpan.FromSeconds(5);

    public async Task<ProcessOutcome> RunAsync(ProcessCall call, TimeSpan timeout, CancellationToken cancel)
    {
        if (cancel.IsCancellationRequested) return new(null, false, true, "", "");
        var start = new ProcessStartInfo(call.FileName)
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            WindowStyle = ProcessWindowStyle.Hidden,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        foreach (var argument in call.Arguments) start.ArgumentList.Add(argument);

        var output = new Tail();
        var error = new Tail();
        using var process = new Process { StartInfo = start };
        process.OutputDataReceived += (_, e) => output.Add(e.Data);
        process.ErrorDataReceived += (_, e) => error.Add(e.Data);
        try
        {
            if (!process.Start()) return new(null, false, false, "", "", "The program didn’t start.");
        }
        catch (Exception ex) when (ex is Win32Exception or InvalidOperationException or IOException or UnauthorizedAccessException)
        {
            return new(null, false, false, "", "", ex.Message);
        }

        using var job = KillOnCloseJob.TryFor(process);
        try { process.StandardInput.Close(); } catch (IOException) { /* it has already gone */ }
        process.BeginOutputReadLine();
        process.BeginErrorReadLine();

        using var limit = CancellationTokenSource.CreateLinkedTokenSource(cancel);
        limit.CancelAfter(timeout);
        try
        {
            await process.WaitForExitAsync(limit.Token).ConfigureAwait(false);
            return new(process.ExitCode, false, false, output.Text, error.Text);
        }
        catch (OperationCanceledException)
        {
            try { process.Kill(entireProcessTree: true); }
            catch (Exception ex) when (ex is InvalidOperationException or Win32Exception or NotSupportedException) { /* already gone */ }
            using var grace = new CancellationTokenSource(KillWait);
            try { await process.WaitForExitAsync(grace.Token).ConfigureAwait(false); }
            catch (OperationCanceledException) { /* the job ends it when disposed */ }
            var cancelled = cancel.IsCancellationRequested;
            return new(null, !cancelled, cancelled, output.Text, error.Text);
        }
    }

    /// <summary>The last KeptChars characters written to one stream, line by line.</summary>
    private sealed class Tail
    {
        private readonly StringBuilder _text = new();

        public void Add(string? line)
        {
            if (line is null) return;
            lock (_text)
            {
                _text.AppendLine(line);
                if (_text.Length > KeptChars * 2) _text.Remove(0, _text.Length - KeptChars);
            }
        }

        public string Text
        {
            get { lock (_text) return _text.Length > KeptChars ? _text.ToString(_text.Length - KeptChars, KeptChars) : _text.ToString(); }
        }
    }

    /// <summary>A job object that ends every process in it when its handle closes. Null if Windows won't make one.</summary>
    private sealed class KillOnCloseJob : IDisposable
    {
        private const uint KillOnJobClose = 0x2000;
        private const uint DieOnUnhandledException = 0x400;
        private const int ExtendedLimitInformation = 9;
        private readonly IntPtr _handle;

        private KillOnCloseJob(IntPtr handle) => _handle = handle;

        public static KillOnCloseJob? TryFor(Process process)
        {
            if (!OperatingSystem.IsWindows()) return null;
            var handle = CreateJobObject(IntPtr.Zero, null);
            if (handle == IntPtr.Zero) return null;
            var info = new ExtendedLimits { Basic = new BasicLimits { LimitFlags = KillOnJobClose | DieOnUnhandledException } };
            try
            {
                if (SetInformationJobObject(handle, ExtendedLimitInformation, ref info, (uint)Marshal.SizeOf<ExtendedLimits>())
                    && AssignProcessToJobObject(handle, process.Handle))
                    return new KillOnCloseJob(handle);
            }
            catch (InvalidOperationException) { /* the process has already ended */ }
            CloseHandle(handle);
            return null;
        }

        public void Dispose() => CloseHandle(_handle);

        [StructLayout(LayoutKind.Sequential)]
        private struct BasicLimits
        {
            public long PerProcessUserTimeLimit;
            public long PerJobUserTimeLimit;
            public uint LimitFlags;
            public UIntPtr MinimumWorkingSetSize;
            public UIntPtr MaximumWorkingSetSize;
            public uint ActiveProcessLimit;
            public UIntPtr Affinity;
            public uint PriorityClass;
            public uint SchedulingClass;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct ExtendedLimits
        {
            public BasicLimits Basic;
            public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
            public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
            public UIntPtr ProcessMemoryLimit;
            public UIntPtr JobMemoryLimit;
            public UIntPtr PeakProcessMemoryUsed;
            public UIntPtr PeakJobMemoryUsed;
        }

        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        private static extern IntPtr CreateJobObject(IntPtr attributes, string? name);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref ExtendedLimits info, uint length);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool CloseHandle(IntPtr handle);
    }
}
