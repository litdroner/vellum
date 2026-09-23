using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Security;
using Microsoft.Win32;

namespace Vellum.Services.Conversion;

/// <summary>
/// What the providers learn about this PC, and the one thing they do to it. Reading only: the registry, files
/// and the list of running processes; nothing is started. EndServer ends an Office process, and only one that a
/// timed-out conversion started itself. Tests replace every member.
/// </summary>
public class ProviderProbe
{
    /// <summary>
    /// A COM ProgID's registration, as automation itself resolves it: the class's LocalServer32 command line
    /// (either registry view: 32-bit Office registers there) and the ProgID's CurVer ("Word.Application.16").
    /// </summary>
    public virtual (string? Server, string? CurrentVersion) ComServer(string progId)
    {
        if (!OperatingSystem.IsWindows()) return (null, null);
        try
        {
            using var prog = Registry.ClassesRoot.OpenSubKey(progId);
            if (prog is null) return (null, null);
            using var clsidKey = prog.OpenSubKey("CLSID");
            using var curVerKey = prog.OpenSubKey("CurVer");
            var curVer = curVerKey?.GetValue(null) as string;
            if (clsidKey?.GetValue(null) is not string clsid || clsid.Length == 0) return (null, curVer);
            foreach (var view in new[] { RegistryView.Registry64, RegistryView.Registry32 })
            {
                using var root = RegistryKey.OpenBaseKey(RegistryHive.ClassesRoot, view);
                using var server = root.OpenSubKey($@"CLSID\{clsid}\LocalServer32");
                if (server?.GetValue(null) is string command && command.Trim().Length > 0) return (command, curVer);
            }
            return (null, curVer);
        }
        catch (Exception ex) when (ex is SecurityException or UnauthorizedAccessException or IOException) { return (null, null); }
    }

    /// <summary>
    /// The program folders a LibreOffice install may be in: where it says it is (Software\LibreOffice\UNO\InstallPath,
    /// the key LibreOffice's own UNO bootstrap reads), then its default folders. Existence is checked by the caller.
    /// </summary>
    public virtual IEnumerable<string> LibreOfficeFolders()
    {
        var folders = new List<string>();
        if (OperatingSystem.IsWindows())
        {
            foreach (var hive in new[] { RegistryHive.CurrentUser, RegistryHive.LocalMachine })
                foreach (var view in new[] { RegistryView.Registry64, RegistryView.Registry32 })
                {
                    try
                    {
                        using var root = RegistryKey.OpenBaseKey(hive, view);
                        using var key = root.OpenSubKey(@"Software\LibreOffice\UNO\InstallPath");
                        if (key?.GetValue(null) is string path && Path.IsPathFullyQualified(path)) folders.Add(path);
                    }
                    catch (Exception ex) when (ex is SecurityException or UnauthorizedAccessException or IOException) { }
                }
        }
        foreach (var programs in new[] { Environment.SpecialFolder.ProgramFiles, Environment.SpecialFolder.ProgramFilesX86 })
        {
            var root = Environment.GetFolderPath(programs);
            if (root.Length > 0) folders.Add(Path.Combine(root, "LibreOffice", "program"));
        }
        return folders.Select(f => Path.TrimEndingDirectorySeparator(f)).Distinct(StringComparer.OrdinalIgnoreCase);
    }

    public virtual bool FileExists(string path) => File.Exists(path);

    /// <summary>Whether a process with this name (no ".exe") is running for anyone on this PC.</summary>
    public virtual bool IsRunning(string processName)
    {
        var processes = Process.GetProcessesByName(processName);
        foreach (var process in processes) process.Dispose();
        return processes.Length > 0;
    }

    /// <summary>
    /// Ends the Office application a stopped conversion started: only if process `id` is still `processName`
    /// and started after `startedAfter`, so a reused id or a person's own Office is never touched.
    /// </summary>
    public virtual void EndServer(int id, string processName, DateTime startedAfter)
    {
        try
        {
            using var process = Process.GetProcessById(id);
            if (!string.Equals(process.ProcessName, processName, StringComparison.OrdinalIgnoreCase)) return;
            if (process.StartTime < startedAfter) return;
            process.Kill();
        }
        catch (Exception ex) when (ex is ArgumentException or InvalidOperationException or Win32Exception or NotSupportedException) { /* gone already */ }
    }
}
