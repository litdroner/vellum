using System.Diagnostics;
using Microsoft.Win32;

namespace Vellum.Services;

/// <summary>
/// Registers Vellum as a PDF handler for the current user (HKCU, no admin rights needed).
/// Windows 10/11 deliberately don't let apps silently make themselves the default: after registering,
/// we open Settings on Vellum's page so the user confirms the choice with one click.
/// </summary>
public static class FileAssociation
{
    public const string ProgId = "Vellum.PDF";
    private const string AppName = "Vellum";
    private const string CapabilitiesKey = @"Software\Vellum\Capabilities";

    private static string ExePath => Environment.ProcessPath!;

    public static bool IsRegistered()
    {
        using var key = Registry.CurrentUser.OpenSubKey($@"Software\Classes\{ProgId}\shell\open\command");
        return key?.GetValue(null) is string command && command.Contains(ExePath, StringComparison.OrdinalIgnoreCase);
    }

    public static void Register()
    {
        var exe = ExePath;
        var command = $"\"{exe}\" \"%1\"";

        using (var progId = Registry.CurrentUser.CreateSubKey($@"Software\Classes\{ProgId}"))
        {
            progId.SetValue(null, "PDF Document");
            progId.SetValue("FriendlyTypeName", "PDF Document");
            using (var icon = progId.CreateSubKey("DefaultIcon")) icon.SetValue(null, $"\"{exe}\",0");
            using (var open = progId.CreateSubKey(@"shell\open\command")) open.SetValue(null, command);
        }
        using (var openWith = Registry.CurrentUser.CreateSubKey(@"Software\Classes\.pdf\OpenWithProgids"))
        {
            openWith.SetValue(ProgId, Array.Empty<byte>(), RegistryValueKind.None);
        }
        using (var app = Registry.CurrentUser.CreateSubKey(@"Software\Classes\Applications\Vellum.exe"))
        {
            app.SetValue("FriendlyAppName", AppName);
            using (var types = app.CreateSubKey("SupportedTypes")) types.SetValue(".pdf", "");
            using (var open = app.CreateSubKey(@"shell\open\command")) open.SetValue(null, command);
        }
        using (var caps = Registry.CurrentUser.CreateSubKey(CapabilitiesKey))
        {
            caps.SetValue("ApplicationName", AppName);
            caps.SetValue("ApplicationDescription", "A calm, fast PDF reader.");
            using (var assoc = caps.CreateSubKey("FileAssociations")) assoc.SetValue(".pdf", ProgId);
        }
        using (var registered = Registry.CurrentUser.CreateSubKey(@"Software\RegisteredApplications"))
        {
            registered.SetValue(AppName, CapabilitiesKey);
        }
        NotifyShell();
    }

    public static void Unregister()
    {
        Registry.CurrentUser.DeleteSubKeyTree($@"Software\Classes\{ProgId}", throwOnMissingSubKey: false);
        Registry.CurrentUser.DeleteSubKeyTree(@"Software\Classes\Applications\Vellum.exe", throwOnMissingSubKey: false);
        Registry.CurrentUser.DeleteSubKeyTree(@"Software\Vellum\Capabilities", throwOnMissingSubKey: false);
        using (var openWith = Registry.CurrentUser.OpenSubKey(@"Software\Classes\.pdf\OpenWithProgids", writable: true))
        {
            openWith?.DeleteValue(ProgId, throwOnMissingValue: false);
        }
        using (var registered = Registry.CurrentUser.OpenSubKey(@"Software\RegisteredApplications", writable: true))
        {
            registered?.DeleteValue(AppName, throwOnMissingValue: false);
        }
        NotifyShell();
    }

    /// <summary>Opens Settings → Default apps directly on Vellum's entry.</summary>
    public static void OpenDefaultAppsSettings()
    {
        Process.Start(new ProcessStartInfo($"ms-settings:defaultapps?registeredAppUser={AppName}") { UseShellExecute = true });
    }

    private static void NotifyShell() =>
        NativeMethods.SHChangeNotify(NativeMethods.SHCNE_ASSOCCHANGED, NativeMethods.SHCNF_IDLIST, IntPtr.Zero, IntPtr.Zero);
}
