using System.Runtime.InteropServices;

namespace Vellum.Services;

internal static class NativeMethods
{
    public const int ASFW_ANY = -1;
    public const int SHCNE_ASSOCCHANGED = 0x08000000;
    public const uint SHCNF_IDLIST = 0;

    /// <summary>Lets another process (the already-running Vellum) bring its window to the front.</summary>
    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool AllowSetForegroundWindow(int dwProcessId);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    /// <summary>Tells Explorer that file associations changed so icons and "Open with" refresh.</summary>
    [DllImport("shell32.dll")]
    public static extern void SHChangeNotify(int wEventId, uint uFlags, IntPtr dwItem1, IntPtr dwItem2);
}
