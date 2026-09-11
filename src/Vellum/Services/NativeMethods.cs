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

    public const int NameDisplay = 3;

    /// <summary>The signed-in user's display name (e.g. "Pankaj Manhas"); fails for accounts without one.</summary>
    [DllImport("secur32.dll", CharSet = CharSet.Unicode, EntryPoint = "GetUserNameExW")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool GetUserNameEx(int nameFormat, System.Text.StringBuilder nameBuffer, ref uint size);

    /// <summary>Tells Explorer that file associations changed so icons and "Open with" refresh.</summary>
    [DllImport("shell32.dll")]
    public static extern void SHChangeNotify(int wEventId, uint uFlags, IntPtr dwItem1, IntPtr dwItem2);
}
