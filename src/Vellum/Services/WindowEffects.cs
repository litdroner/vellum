using System.Runtime.InteropServices;
using System.Windows;

namespace Vellum.Services;

/// <summary>
/// Win32 pieces that make the borderless window behave like a native one:
/// dark/rounded DWM frame, the maximized-overhang fix, and starting a native resize from the page.
/// </summary>
internal static class WindowEffects
{
    private const int DWMWA_USE_IMMERSIVE_DARK_MODE = 20;
    private const int DWMWA_WINDOW_CORNER_PREFERENCE = 33;
    private const int DWMWA_BORDER_COLOR = 34;
    private const int DWMWCP_ROUND = 2;
    private const int SM_CXSIZEFRAME = 32;
    private const int SM_CXPADDEDBORDER = 92;
    private const int WM_NCLBUTTONDOWN = 0x00A1;

    [DllImport("dwmapi.dll")]
    private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int size);

    [DllImport("user32.dll")]
    private static extern int GetSystemMetricsForDpi(int index, uint dpi);

    [DllImport("user32.dll")]
    private static extern uint GetDpiForWindow(IntPtr hwnd);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ReleaseCapture();

    [DllImport("user32.dll")]
    private static extern IntPtr SendMessage(IntPtr hwnd, int msg, IntPtr wParam, IntPtr lParam);

    /// <summary>Dark or light window frame, rounded corners (Windows 11) and a border that matches the app.</summary>
    public static void ApplyTheme(IntPtr hwnd, bool dark)
    {
        if (hwnd == IntPtr.Zero) return;
        var useDark = dark ? 1 : 0;
        DwmSetWindowAttribute(hwnd, DWMWA_USE_IMMERSIVE_DARK_MODE, ref useDark, sizeof(int));
        var corners = DWMWCP_ROUND;
        DwmSetWindowAttribute(hwnd, DWMWA_WINDOW_CORNER_PREFERENCE, ref corners, sizeof(int));
        // COLORREF is 0x00BBGGRR. These calls simply fail (harmlessly) on Windows 10.
        var border = dark ? 0x00201C19 : 0x00C9D0D6;
        DwmSetWindowAttribute(hwnd, DWMWA_BORDER_COLOR, ref border, sizeof(int));
    }

    /// <summary>
    /// A maximized window without a system title bar extends past the screen by its resize frame.
    /// This is how far, in WPF units, so the content can be inset by the same amount.
    /// </summary>
    public static Thickness MaximizedOverhang(IntPtr hwnd)
    {
        var dpi = GetDpiForWindow(hwnd);
        if (dpi == 0) dpi = 96;
        var pixels = GetSystemMetricsForDpi(SM_CXSIZEFRAME, dpi) + GetSystemMetricsForDpi(SM_CXPADDEDBORDER, dpi);
        return new Thickness(pixels * 96.0 / dpi);
    }

    /// <summary>Hands a mouse-down on one of the page's edge strips to Windows' own resize loop.</summary>
    public static void BeginResize(IntPtr hwnd, string edge)
    {
        var hit = edge switch
        {
            "w" => 10, "e" => 11, "n" => 12, "nw" => 13, "ne" => 14, "s" => 15, "sw" => 16, "se" => 17,
            _ => 0,
        };
        if (hit == 0 || hwnd == IntPtr.Zero) return;
        ReleaseCapture();
        SendMessage(hwnd, WM_NCLBUTTONDOWN, hit, IntPtr.Zero);
    }
}
