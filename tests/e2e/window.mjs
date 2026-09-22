// Puts the app's window wholly on one monitor before a suite starts, so screenshots, native dialogs,
// DPI and coordinates never depend on where Windows happened to open it (it can straddle two screens).
//
// The monitor is found at run time: a landscape 2560×1440 one if there is one, else the largest
// landscape monitor, else the primary. The window keeps its size unless it doesn't fit the work area,
// and is centred in it. Win32 is reached through PowerShell (as the updates suite does), per-monitor
// DPI aware so every rectangle is in physical pixels.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const SOURCE = String.raw`
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Threading;
public static class VellumWindowPlacement {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; }
  public delegate bool EnumWindowsProc(IntPtr h, IntPtr p);
  public delegate bool EnumMonitorsProc(IntPtr m, IntPtr dc, ref RECT r, IntPtr p);
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc f, IntPtr p);
  [DllImport("user32.dll")] static extern bool EnumDisplayMonitors(IntPtr dc, IntPtr clip, EnumMonitorsProc f, IntPtr p);
  [DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr m, ref MONITORINFO info);
  [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr h, uint flags);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int hh, uint flags);

  const uint SWP_NOSIZE = 0x1, SWP_NOZORDER = 0x4, SWP_NOACTIVATE = 0x10;

  static string R(RECT r) { return (r.Right - r.Left) + "x" + (r.Bottom - r.Top) + " at " + r.Left + "," + r.Top; }
  static bool Inside(RECT a, RECT b) { return a.Left >= b.Left && a.Top >= b.Top && a.Right <= b.Right && a.Bottom <= b.Bottom; }

  static IntPtr FindWindow(uint pid) {
    IntPtr found = IntPtr.Zero;
    EnumWindows(delegate (IntPtr h, IntPtr p) {
      uint owner;
      GetWindowThreadProcessId(h, out owner);
      RECT r;
      if (owner == pid && IsWindowVisible(h) && GetWindow(h, 4) == IntPtr.Zero && GetWindowRect(h, out r)
          && r.Right - r.Left > 100 && r.Bottom - r.Top > 100) { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }

  public static string Place(uint pid, int timeoutMs) {
    SetThreadDpiAwarenessContext(new IntPtr(-4)); // per-monitor aware v2: physical pixels throughout
    var monitors = new List<KeyValuePair<IntPtr, MONITORINFO>>();
    EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, delegate (IntPtr m, IntPtr dc, ref RECT r, IntPtr p) {
      var info = new MONITORINFO(); info.cbSize = Marshal.SizeOf(typeof(MONITORINFO));
      if (GetMonitorInfo(m, ref info)) monitors.Add(new KeyValuePair<IntPtr, MONITORINFO>(m, info));
      return true;
    }, IntPtr.Zero);
    var list = new List<string>();
    foreach (var m in monitors) list.Add(R(m.Value.rcMonitor) + ((m.Value.dwFlags & 1) != 0 ? " (primary)" : ""));
    string screens = string.Join("; ", list.ToArray());
    if (monitors.Count == 0) return "FAIL|no monitors found";

    // A landscape 2560x1440 monitor, else the largest landscape one, else the primary.
    int best = -1; long bestScore = -1;
    for (int i = 0; i < monitors.Count; i++) {
      RECT b = monitors[i].Value.rcMonitor;
      long w = b.Right - b.Left, h = b.Bottom - b.Top;
      long score = (monitors[i].Value.dwFlags & 1) != 0 ? 1 : 0;
      if (w > h) score = 10 + w * h;
      if (w == 2560 && h == 1440) score = long.MaxValue;
      if (score > bestScore) { best = i; bestScore = score; }
    }
    IntPtr monitor = monitors[best].Key;
    RECT work = monitors[best].Value.rcWork;
    int workW = work.Right - work.Left, workH = work.Bottom - work.Top;

    IntPtr hwnd = IntPtr.Zero;
    var until = DateTime.UtcNow.AddMilliseconds(timeoutMs);
    while ((hwnd = FindWindow(pid)) == IntPtr.Zero && DateTime.UtcNow < until) Thread.Sleep(100);
    if (hwnd == IntPtr.Zero) return "FAIL|no window for process " + pid + "|" + screens;
    if (IsZoomed(hwnd) || IsIconic(hwnd)) { ShowWindow(hwnd, 9); Thread.Sleep(300); } // SW_RESTORE

    RECT rect;
    GetWindowRect(hwnd, out rect);
    string before = R(rect);
    // First onto the monitor at the current size: a monitor with another DPI makes the app rescale
    // the window, so the size to fit is only known after that.
    SetWindowPos(hwnd, IntPtr.Zero, work.Left, work.Top, 0, 0, SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE);
    Thread.Sleep(400);
    for (int attempt = 0; attempt < 10; attempt++) {
      GetWindowRect(hwnd, out rect);
      int w = Math.Min(rect.Right - rect.Left, workW), h = Math.Min(rect.Bottom - rect.Top, workH);
      int x = work.Left + (workW - w) / 2, y = work.Top + (workH - h) / 2;
      SetWindowPos(hwnd, IntPtr.Zero, x, y, w, h, SWP_NOZORDER | SWP_NOACTIVATE);
      Thread.Sleep(250);
      RECT after;
      GetWindowRect(hwnd, out after);
      if (Inside(after, work) && MonitorFromWindow(hwnd, 0) == monitor
          && after.Left == x && after.Top == y && after.Right - after.Left == w && after.Bottom - after.Top == h)
        return "OK|window " + R(after) + " (was " + before + ")|work area " + R(work) + "|" + screens;
    }
    GetWindowRect(hwnd, out rect);
    return "FAIL|window " + R(rect) + " not inside work area " + R(work) + "|" + screens;
  }
}
`;

/**
 * Moves the process's top-level window wholly into one monitor's work area and checks it stayed there.
 * Throws if that can't be done, so a suite never runs on a straddling window.
 */
export function placeOnOneMonitor(pid, dir, { timeoutMs = 30000 } = {}) {
  const script = path.join(dir, 'place-window.ps1');
  fs.writeFileSync(script, `Add-Type -TypeDefinition @'\n${SOURCE}\n'@\n[VellumWindowPlacement]::Place([uint32]$args[0], [int]$args[1])\n`);
  const out = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, String(pid), String(timeoutMs)],
    { encoding: 'utf8', timeout: timeoutMs + 30000 });
  const line = (out.stdout ?? '').trim().split(/\r?\n/).at(-1) ?? '';
  const [status, ...rest] = line.split('|');
  if (status !== 'OK') throw new Error(`the window couldn’t be placed on one monitor: ${rest.join(' | ') || (out.stderr ?? '').trim().slice(0, 600) || 'no output'}`);
  return rest.join(' | ');
}
