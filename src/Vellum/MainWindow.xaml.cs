using System.Diagnostics;
using System.IO;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Windows;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Shell;
using Microsoft.Web.WebView2.Core;
using Microsoft.Win32;
using Vellum.Hosting;
using Vellum.Services;

namespace Vellum;

public partial class MainWindow : Window
{
    private static readonly string DataFolder = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Vellum");

    private readonly List<string> _pendingFiles;
    private readonly RecentFiles _recent = new(DataFolder);
    private readonly AppSettings _settings = AppSettings.Load(DataFolder);
    private AppResourceServer? _server;
    private BridgeHost? _bridge;
    private bool _pageReady;
    /// <summary>Set once the page has confirmed nothing is left unsaved (or can't answer).</summary>
    private bool _allowClose;

    public MainWindow(string[] startupFiles)
    {
        InitializeComponent();
        _pendingFiles = [.. startupFiles];
        RestorePlacement();
        ApplyThemeColors();

        SourceInitialized += (_, _) =>
        {
            WindowEffects.ApplyTheme(Handle, IsDark);
            if (WindowState == WindowState.Maximized) OnWindowStateChanged();
        };
        StateChanged += (_, _) => OnWindowStateChanged();
        Activated += (_, _) =>
        {
            // Windows activates the WPF window, not the page inside it; pass keyboard focus on,
            // or shortcuts would do nothing until the user clicks into the document.
            if (Web.CoreWebView2 is not null) Web.Focus();
            _bridge?.Emit("window-active", new { active = true });
        };
        Deactivated += (_, _) => _bridge?.Emit("window-active", new { active = false });
        Closing += (_, e) =>
        {
            // Let the page offer to save unsaved annotations first; it answers with "window.closeConfirmed".
            if (!_allowClose && _pageReady && _bridge is not null)
            {
                e.Cancel = true;
                _bridge.Emit("close-requested");
                return;
            }
            SavePlacement();
        };
        Loaded += async (_, _) => await InitializeWebViewAsync();
    }

    private IntPtr Handle => new WindowInteropHelper(this).Handle;
    private bool IsDark => _settings.Theme != "light";

    /// <summary>Files handed over by a second launch (see SingleInstance).</summary>
    public void OpenFromOtherInstance(string[] paths)
    {
        BringToFront();
        var files = paths.Where(File.Exists).Select(Path.GetFullPath).ToArray();
        if (files.Length == 0) return;
        if (!_pageReady || _bridge is null)
        {
            _pendingFiles.AddRange(files);
            return;
        }
        _bridge.Emit("open-files", new { files = files.Select(DescribeFile).ToArray() });
    }

    private void BringToFront()
    {
        if (WindowState == WindowState.Minimized) WindowState = WindowState.Normal;
        Activate();
        NativeMethods.SetForegroundWindow(Handle);
        if (Web.CoreWebView2 is not null) Web.Focus();
    }

    private async Task InitializeWebViewAsync()
    {
        // WebView2 needs a writable profile folder. Next to the exe won't work once installed
        // under Program Files, so keep it in %LOCALAPPDATA%.
        CoreWebView2Environment env;
        try
        {
            env = await CoreWebView2Environment.CreateAsync(null, Path.Combine(DataFolder, "WebView2"));
            await Web.EnsureCoreWebView2Async(env);
        }
        catch (WebView2RuntimeNotFoundException)
        {
            MessageBox.Show(this,
                "Vellum needs the Microsoft Edge WebView2 Runtime, which isn't installed.\n\n" +
                "Install it from https://go.microsoft.com/fwlink/p/?LinkId=2124703 and start Vellum again.",
                "Vellum", MessageBoxButton.OK, MessageBoxImage.Error);
            Close();
            return;
        }

        var core = Web.CoreWebView2;
        var settings = core.Settings;
        // The app provides its own context menu, zoom, shortcuts and find bar.
        settings.AreDefaultContextMenusEnabled = false;
        settings.IsZoomControlEnabled = false;
        settings.IsPinchZoomEnabled = false;
        settings.AreBrowserAcceleratorKeysEnabled = false;
        settings.IsStatusBarEnabled = false;
        settings.IsSwipeNavigationEnabled = false;
        settings.IsGeneralAutofillEnabled = false;
        settings.IsPasswordAutosaveEnabled = false;
        // Lets the page mark its title bar with CSS `app-region: drag` so Windows treats it as the real caption
        // (dragging, snapping, double-click to maximize, right-click system menu).
        settings.IsNonClientRegionSupportEnabled = true;
#if DEBUG
        settings.AreDevToolsEnabled = true;
#else
        settings.AreDevToolsEnabled = false;
#endif
        // Chromium's own UI (print dialog, scrollbars, form controls) follows the app theme.
        core.Profile.PreferredColorScheme = IsDark ? CoreWebView2PreferredColorScheme.Dark : CoreWebView2PreferredColorScheme.Light;

        _server = new AppResourceServer(core, env, Path.Combine(AppContext.BaseDirectory, "web"));
        _bridge = new BridgeHost(core);
        RegisterBridgeHandlers(_bridge);

        // The page may only ever show our own UI; anything else (a link inside a PDF) goes to the browser.
        core.NavigationStarting += (_, e) =>
        {
            if (!e.Uri.StartsWith(AppResourceServer.Origin + "/", StringComparison.OrdinalIgnoreCase))
            {
                e.Cancel = true;
                OpenExternal(e.Uri);
            }
        };
        core.NewWindowRequested += (_, e) =>
        {
            e.Handled = true;
            OpenExternal(e.Uri);
        };
        // If the page's process dies it can't answer the close prompt; don't trap the window open.
        core.ProcessFailed += (_, _) => _allowClose = true;
        core.NavigationCompleted += (_, _) =>
        {
            if (IsActive) Web.Focus();
        };

        core.Navigate(AppResourceServer.Origin + "/index.html");
    }

    private void RegisterBridgeHandlers(BridgeHost bridge)
    {
        // The page calls "ready" once it has booted; we answer with the files to open.
        bridge.Register("ready", _ =>
        {
            _pageReady = true;
            var files = _pendingFiles.Select(DescribeFile).ToArray();
            _pendingFiles.Clear();
            // The Windows user name signs annotations (the PDF "author" field).
            return Done(new
            {
                files,
                theme = _settings.Theme,
                user = Environment.UserName,
                version = typeof(App).Assembly.GetName().Version?.ToString(3),
            });
        });

        // ---- files --------------------------------------------------------

        bridge.Register("openDialog", request =>
        {
            var dialog = new OpenFileDialog
            {
                Title = OptionalString(request, "title") ?? "Open PDF",
                Filter = "PDF documents (*.pdf)|*.pdf|All files (*.*)|*.*",
                Multiselect = true,
                InitialDirectory = LastFolder(),
            };
            var files = dialog.ShowDialog(this) == true ? dialog.FileNames.Select(DescribeFile).ToArray() : [];
            return Done(new { files });
        });

        // Drag-and-drop: the page sends the dropped File objects, WebView2 gives us their real paths.
        bridge.Register("openDropped", request =>
        {
            var paths = new List<string>();
            if (request.Message.AdditionalObjects is { } objects)
            {
                foreach (var item in objects)
                    if (item is CoreWebView2File file && File.Exists(file.Path)) paths.Add(file.Path);
            }
            return Done(new { files = paths.Select(DescribeFile).ToArray() });
        });

        // Reopen from the recent list. Only paths already in that list are accepted.
        bridge.Register("openPath", request =>
        {
            var path = RequiredString(request, "path");
            if (_recent.Find(path) is null) throw new InvalidOperationException("That file isn't in the recent list.");
            if (!File.Exists(path)) throw new FileNotFoundException("The file is no longer there.");
            return Done(new { file = DescribeFile(path) });
        });

        bridge.Register("recent.list", _ => Done(new
        {
            entries = _recent.Entries
                .Select(e => new { e.Path, e.OpenedAt, e.Page, exists = File.Exists(e.Path) })
                .ToArray(),
        }));
        bridge.Register("recent.opened", request =>
        {
            var path = RequiredString(request, "path");
            _recent.Touch(path);
            try { JumpList.AddToRecentCategory(path); } catch (Exception) { /* jump list needs the association */ }
            return Done();
        });
        bridge.Register("recent.update", request =>
        {
            _recent.UpdatePosition(RequiredString(request, "path"), OptionalInt(request, "page"),
                OptionalString(request, "scaleValue"), OptionalString(request, "viewMode"));
            return Done();
        });
        bridge.Register("recent.remove", request =>
        {
            _recent.Remove(RequiredString(request, "path"));
            return Done();
        });
        bridge.Register("recent.clear", _ =>
        {
            _recent.Clear();
            return Done();
        });

        bridge.Register("showInFolder", request =>
        {
            var path = RequiredString(request, "path");
            if (File.Exists(path)) Process.Start("explorer.exe", $"/select,\"{path}\"");
            return Done();
        });
        bridge.Register("assoc.status", _ => Done(new { registered = FileAssociation.IsRegistered() }));
        bridge.Register("assoc.register", _ =>
        {
            FileAssociation.Register();
            FileAssociation.OpenDefaultAppsSettings();
            return Done(new { registered = true });
        });

        // Save As: the chosen path is registered so the page may write to it (and only to it).
        bridge.Register("saveAsDialog", request =>
        {
            var current = OptionalString(request, "path");
            var dialog = new SaveFileDialog
            {
                Title = OptionalString(request, "title") ?? "Save PDF as",
                Filter = "PDF documents (*.pdf)|*.pdf",
                DefaultExt = ".pdf",
                AddExtension = true,
                OverwritePrompt = true,
                FileName = OptionalString(request, "name") ?? "Document.pdf",
                InitialDirectory = current is not null && Directory.Exists(Path.GetDirectoryName(current))
                    ? Path.GetDirectoryName(current)
                    : LastFolder(),
            };
            return Done(new { file = dialog.ShowDialog(this) == true ? DescribeFile(dialog.FileName) : null });
        });

        // Split: the user picks a folder; each part gets a free file name there (nothing is overwritten),
        // registered so the page may write to it.
        bridge.Register("splitTargets", request =>
        {
            var names = request.Payload.ValueKind == JsonValueKind.Object
                && request.Payload.TryGetProperty("names", out var list) && list.ValueKind == JsonValueKind.Array
                ? list.EnumerateArray().Select(n => n.GetString() ?? "").ToArray()
                : [];
            if (names.Length == 0) throw new ArgumentException("No files to create.");
            var current = OptionalString(request, "path");
            var dialog = new OpenFolderDialog
            {
                Title = "Choose a folder for the split files",
                InitialDirectory = current is not null && Directory.Exists(Path.GetDirectoryName(current))
                    ? Path.GetDirectoryName(current)
                    : LastFolder(),
            };
            if (dialog.ShowDialog(this) != true) return Done(new { files = (object[]?)null });
            var taken = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            var files = names.Select(name => DescribeFile(FreePath(dialog.FolderName, name, taken))).ToArray();
            return Done(new { files, folder = dialog.FolderName });
        });

        // Protected (encrypted) PDFs can't be written, so their annotations live in a sidecar file
        // in %LOCALAPPDATA%\Vellum\annotations, named by the PDF's content hash.
        bridge.Register("annotations.loadSidecar", request =>
        {
            var path = SidecarPath(request);
            if (!File.Exists(path)) return Done(new { annotations = (object?)null });
            using var doc = JsonDocument.Parse(File.ReadAllText(path));
            var list = doc.RootElement.TryGetProperty("annotations", out var a) && a.ValueKind == JsonValueKind.Array ? a.Clone() : default;
            return Done(new { annotations = list.ValueKind == JsonValueKind.Array ? (object)list : null });
        });
        bridge.Register("annotations.saveSidecar", request =>
        {
            var path = SidecarPath(request);
            var list = request.Payload.GetProperty("annotations");
            if (list.ValueKind != JsonValueKind.Array) throw new ArgumentException("Missing annotations.");
            if (list.GetArrayLength() == 0)
            {
                if (File.Exists(path)) File.Delete(path);
                return Done(new { ok = true });
            }
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            var json = JsonSerializer.Serialize(new
            {
                version = 1,
                fileName = OptionalString(request, "fileName"),
                savedAt = DateTimeOffset.Now,
                annotations = list,
            }, BridgeHost.Json);
            var temp = path + ".tmp";
            File.WriteAllText(temp, json);
            File.Move(temp, path, overwrite: true);
            return Done(new { ok = true });
        });

        // The page has dealt with unsaved annotations; really close now.
        bridge.Register("window.closeConfirmed", _ =>
        {
            _allowClose = true;
            Dispatcher.BeginInvoke(Close);
            return Done();
        });

        // ---- window chrome ------------------------------------------------

        bridge.Register("window.state", _ => Done(new
        {
            maximized = WindowState == WindowState.Maximized,
            active = IsActive,
            theme = _settings.Theme,
        }));
        bridge.Register("window.setTitle", request =>
        {
            Title = RequiredString(request, "title");
            return Done();
        });
        bridge.Register("window.minimize", _ =>
        {
            WindowState = WindowState.Minimized;
            return Done();
        });
        bridge.Register("window.toggleMaximize", _ =>
        {
            WindowState = WindowState == WindowState.Maximized ? WindowState.Normal : WindowState.Maximized;
            return Done();
        });
        bridge.Register("window.close", _ =>
        {
            // Deferred: closing from inside a WebView2 callback would tear it down mid-call.
            Dispatcher.BeginInvoke(Close);
            return Done();
        });
        bridge.Register("window.resize", request =>
        {
            var edge = RequiredString(request, "edge");
            if (WindowState == WindowState.Normal) Dispatcher.BeginInvoke(() => WindowEffects.BeginResize(Handle, edge));
            return Done();
        });
        bridge.Register("window.setTheme", request =>
        {
            _settings.Theme = RequiredString(request, "theme") == "light" ? "light" : "dark";
            _settings.Save();
            ApplyThemeColors();
            WindowEffects.ApplyTheme(Handle, IsDark);
            Web.CoreWebView2.Profile.PreferredColorScheme =
                IsDark ? CoreWebView2PreferredColorScheme.Dark : CoreWebView2PreferredColorScheme.Light;
            return Done();
        });
    }

    // ---- window placement & theme ------------------------------------------

    private void ApplyThemeColors()
    {
        var (r, g, b) = IsDark ? ((byte)0x1D, (byte)0x1A, (byte)0x17) : ((byte)0xEC, (byte)0xE6, (byte)0xDB);
        Background = new SolidColorBrush(Color.FromRgb(r, g, b));
        Web.DefaultBackgroundColor = System.Drawing.Color.FromArgb(255, r, g, b);
    }

    private void OnWindowStateChanged()
    {
        var maximized = WindowState == WindowState.Maximized;
        Root.Margin = maximized ? WindowEffects.MaximizedOverhang(Handle) : new Thickness(0);
        _bridge?.Emit("window-state", new { maximized });
    }

    /// <summary>Reopens the window where it was last time, if that spot is still on a screen.</summary>
    private void RestorePlacement()
    {
        if (_settings is not { Left: double left, Top: double top, Width: double width, Height: double height }) return;
        if (width < MinWidth || height < MinHeight) return;
        var screens = new Rect(SystemParameters.VirtualScreenLeft, SystemParameters.VirtualScreenTop,
            SystemParameters.VirtualScreenWidth, SystemParameters.VirtualScreenHeight);
        // The title strip must be reachable, or the window could be lost off-screen.
        if (!screens.IntersectsWith(new Rect(left + 40, top, Math.Max(1, width - 80), 32))) return;
        WindowStartupLocation = WindowStartupLocation.Manual;
        Left = left;
        Top = top;
        Width = width;
        Height = height;
        if (_settings.Maximized) WindowState = WindowState.Maximized;
    }

    private void SavePlacement()
    {
        var bounds = WindowState == WindowState.Normal ? new Rect(Left, Top, Width, Height) : RestoreBounds;
        if (!bounds.IsEmpty)
        {
            _settings.Left = bounds.Left;
            _settings.Top = bounds.Top;
            _settings.Width = bounds.Width;
            _settings.Height = bounds.Height;
        }
        _settings.Maximized = WindowState == WindowState.Maximized;
        _settings.Save();
    }

    // ---- helpers -------------------------------------------------------------

    /// <summary>What the page needs to open a file: a private URL for its bytes, plus where you left off.</summary>
    private object DescribeFile(string path)
    {
        var info = new FileInfo(path);
        var token = _server!.RegisterDocument(info.FullName);
        var entry = _recent.Find(info.FullName);
        return new
        {
            token,
            path = info.FullName,
            name = info.Name,
            size = info.Exists ? info.Length : 0, // a Save As target may not exist yet
            url = $"{AppResourceServer.Origin}/doc/{token}",
            resume = entry is null ? null : new { page = entry.Page, scaleValue = entry.ScaleValue, viewMode = entry.ViewMode },
        };
    }

    private string LastFolder()
    {
        var last = _recent.Entries.Select(e => Path.GetDirectoryName(e.Path)).FirstOrDefault(Directory.Exists);
        return last ?? Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments);
    }

    private static Task<object?> Done(object? result = null) => Task.FromResult(result);

    /// <summary>A file name in `folder` that doesn't exist yet: "name.pdf", then "name (2).pdf", …</summary>
    private static string FreePath(string folder, string requested, HashSet<string> taken)
    {
        var invalid = Path.GetInvalidFileNameChars();
        var clean = new string(Path.GetFileNameWithoutExtension(requested).Where(c => !invalid.Contains(c)).ToArray()).Trim();
        if (clean.Length == 0) clean = "Part";
        for (var i = 1; ; i++)
        {
            var path = Path.Combine(folder, (i == 1 ? clean : $"{clean} ({i})") + ".pdf");
            if (!File.Exists(path) && taken.Add(path)) return path;
        }
    }

    private static readonly Regex SidecarKey = new("^[0-9A-F]{64}$", RegexOptions.Compiled);

    /// <summary>Sidecar file for a document key (a SHA-256 hex string, validated so it can't name another path).</summary>
    private static string SidecarPath(BridgeRequest request)
    {
        var key = RequiredString(request, "key");
        if (!SidecarKey.IsMatch(key)) throw new ArgumentException("Invalid document key.");
        return Path.Combine(DataFolder, "annotations", key + ".json");
    }

    private static string RequiredString(BridgeRequest request, string name) =>
        OptionalString(request, name) ?? throw new ArgumentException($"Missing '{name}'.");

    private static string? OptionalString(BridgeRequest request, string name) =>
        request.Payload.ValueKind == JsonValueKind.Object && request.Payload.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String
            ? v.GetString()
            : null;

    private static int? OptionalInt(BridgeRequest request, string name) =>
        request.Payload.ValueKind == JsonValueKind.Object && request.Payload.TryGetProperty(name, out var v) && v.TryGetInt32(out var n)
            ? n
            : null;

    private static void OpenExternal(string uri)
    {
        if (!Uri.TryCreate(uri, UriKind.Absolute, out var parsed)) return;
        if (parsed.Scheme is not ("http" or "https" or "mailto")) return;
        try { Process.Start(new ProcessStartInfo(parsed.AbsoluteUri) { UseShellExecute = true }); }
        catch (Exception) { /* no handler registered for the scheme */ }
    }
}
