using System.Diagnostics;
using System.IO;
using System.Text.Json;
using System.Text.Json.Nodes;
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
    private static readonly string DataFolder = ResolveDataFolder();

    /// <summary>
    /// Where settings, recent files and annotations for protected PDFs live: %LOCALAPPDATA%\Vellum.
    /// Debug builds can be pointed at another folder (VELLUM_DATA_DIR) so automated tests never touch
    /// a person's own settings, recent files or WebView2 profile. Release builds ignore it.
    /// </summary>
    private static string ResolveDataFolder()
    {
#if DEBUG
        var test = Environment.GetEnvironmentVariable("VELLUM_DATA_DIR");
        if (!string.IsNullOrWhiteSpace(test) && Path.IsPathFullyQualified(test)) return test;
#endif
        return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Vellum");
    }

    private readonly List<string> _pendingFiles;
    /// <summary>The version an in-app update failed to install, reported once the page is ready.</summary>
    private string? _updateFailed;
    private readonly RecentFiles _recent = new(DataFolder);
    private readonly DocumentHistory _history = new(DataFolder);
    private readonly DocumentCollections _collections = new(DataFolder);
    private readonly SavedResearch _savedResearch = new(DataFolder);
    private readonly AppSettings _settings = AppSettings.Load(DataFolder);
    private AppResourceServer? _server;
    private BridgeHost? _bridge;
    /// <summary>The WebView2 environment the window's own view runs in; HTML to PDF renders in the same one.</summary>
    private CoreWebView2Environment? _webViewEnvironment;
    private bool _pageReady;
    /// <summary>Set once the page has confirmed nothing is left unsaved (or can't answer).</summary>
    private bool _allowClose;

    public MainWindow(string[] startupFiles)
    {
        InitializeComponent();
        // After an in-app update (installed or not), the documents that were open come back.
        var relaunch = Updater.TakeRelaunch(DataFolder);
        _updateFailed = relaunch.FailedVersion;
        _pendingFiles = [.. startupFiles, .. relaunch.Files.Except(startupFiles, StringComparer.OrdinalIgnoreCase)];
        _ = Task.Run(_updater.CleanUp);
        _ = Task.Run(_office.CleanUp);
        _ = Task.Run(SweepHeld);
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

    /// <summary>
    /// What the page sees as prefers-color-scheme. "Follow Windows" needs the real system setting;
    /// otherwise the app's own choice, so Chromium's scrollbars and form controls match it.
    /// </summary>
    private CoreWebView2PreferredColorScheme PreferredScheme => _settings.FollowSystemTheme
        ? CoreWebView2PreferredColorScheme.Auto
        : IsDark ? CoreWebView2PreferredColorScheme.Dark : CoreWebView2PreferredColorScheme.Light;

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

        _webViewEnvironment = env;
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
        core.Profile.PreferredColorScheme = PreferredScheme;

        _server = new AppResourceServer(core, env, Path.Combine(AppContext.BaseDirectory, "web"));
        _server.OcrLanguage = code => _ocrLanguages.Find(code) is { } pack ? _ocrLanguages.ReadVerified(pack) : null;
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
            var version = Updater.Current.ToString(3);
            // Said once, after an update: "Updated to …".
            var updatedFrom = Updater.TryParseVersion(_settings.LastRunVersion, out var last) && last < Updater.Current ? _settings.LastRunVersion : null;
            if (_settings.LastRunVersion != version)
            {
                _settings.LastRunVersion = version;
                _settings.Save();
            }
            // The Windows user name signs annotations (the PDF "author" field).
            // Said once, when Setup couldn't install an update and started this version again.
            var updateFailed = _updateFailed;
            _updateFailed = null;
            return Done(new { files, theme = _settings.Theme, user = Environment.UserName, name = GreetingName(), version, updatedFrom, updateFailed });
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

        // Replace or insert a picture: the chosen image's bytes come back in the answer itself, so the file
        // is only read, never registered with the resource server (which would make it writable by the page).
        // With "multiple" the person may pick several (Images to PDF); `files` is then all of them, in the
        // order the dialog gives them, and `file` is still the first, for the callers that want just one.
        bridge.Register("pictureDialog", request =>
        {
            const long MaxPictureBytes = 25 * 1024 * 1024;
            var dialog = new OpenFileDialog
            {
                Title = OptionalString(request, "purpose") switch { "insert" => "Insert picture", "signature" => "Choose a signature picture", "watermark" => "Choose a watermark picture", "images" => "Choose pictures", _ => "Replace picture with" },
                Filter = "Pictures (*.png;*.jpg;*.jpeg)|*.png;*.jpg;*.jpeg|All files (*.*)|*.*",
                Multiselect = OptionalBool(request, "multiple") == true,
                InitialDirectory = LastFolder(),
            };
            if (dialog.ShowDialog(this) != true) return Done(new { file = (object?)null, files = Array.Empty<object>() });
            var files = dialog.FileNames.Select(name =>
            {
                var info = new FileInfo(name);
                if (info.Length > MaxPictureBytes) throw new InvalidDataException($"“{info.Name}” is larger than 25 MB.");
                return new { name = info.Name, path = info.FullName, data = Convert.ToBase64String(File.ReadAllBytes(info.FullName)) };
            }).ToArray();
            return Done(new { file = files.FirstOrDefault(), files });
        });

        // Attach a file to the PDF: the chosen file's bytes come back in the answer itself, so the file is
        // only read, never registered with the resource server (which would make it writable by the page).
        // Nothing is attached here — the page holds it until the person saves the document.
        bridge.Register("attachDialog", request =>
        {
            const long MaxAttachmentBytes = 32L * 1024 * 1024;
            var dialog = new OpenFileDialog
            {
                Title = "Choose a file to attach",
                Filter = "All files (*.*)|*.*",
                InitialDirectory = LastFolder(),
            };
            if (dialog.ShowDialog(this) != true) return Done(new { file = (object?)null });
            var info = new FileInfo(dialog.FileName);
            if (info.Length > MaxAttachmentBytes) throw new InvalidDataException("it is larger than 32 MB.");
            return Done(new { file = new { name = info.Name, data = Convert.ToBase64String(File.ReadAllBytes(info.FullName)) } });
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

        // Reopen a document the page already knows: one in the recent list, or one a collection lists.
        bridge.Register("openPath", request =>
        {
            var path = RequiredString(request, "path");
            if (_recent.Find(path) is null && !_collections.Contains(path) && !_savedResearch.Contains(path)) throw new InvalidOperationException("That file isn't in the recent list, a collection or a saved research result.");
            if (!File.Exists(path)) throw new FileNotFoundException("The file is no longer there.");
            return Done(new { file = DescribeFile(path) });
        });

        bridge.Register("recent.list", _ => Done(new
        {
            entries = _recent.Entries
                .Select(e => new { e.Path, e.OpenedAt, e.Page, e.Pages, exists = File.Exists(e.Path), cover = _recent.CoverDataUrl(e.Path) })
                .ToArray(),
        }));
        // The page sends a small JPEG of an open file's first page for the home screen.
        bridge.Register("recent.cover", request =>
        {
            const string prefix = "data:image/jpeg;base64,";
            var path = RequiredString(request, "path");
            var image = RequiredString(request, "image");
            if (!image.StartsWith(prefix, StringComparison.Ordinal) || image.Length > 600_000) throw new ArgumentException("Invalid cover image.");
            _recent.SetCover(path, Convert.FromBase64String(image[prefix.Length..]), OptionalInt(request, "pages"));
            return Done();
        });
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
                OptionalString(request, "scaleValue"), OptionalString(request, "viewMode"), OptionalBool(request, "spread"));
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

        // ---- collections: named lists of file paths; no PDF is copied, moved or changed ----

        bridge.Register("collections.list", _ => Done(new
        {
            collections = _collections.All.Select(c => new
            {
                c.Id,
                c.Name,
                c.CreatedAt,
                documents = c.Paths.Select(p =>
                {
                    var exists = File.Exists(p);
                    return new { path = p, exists, pages = _recent.Find(p)?.Pages, cover = exists ? _recent.CoverDataUrl(p) : null };
                }).ToArray(),
            }).ToArray(),
        }));
        bridge.Register("collections.create", request => Done(new { id = _collections.Create(RequiredString(request, "name")).Id }));
        bridge.Register("collections.rename", request =>
        {
            _collections.Rename(RequiredString(request, "id"), RequiredString(request, "name"));
            return Done();
        });
        bridge.Register("collections.delete", request =>
        {
            _collections.Delete(RequiredString(request, "id"));
            return Done();
        });
        // Adds a file the page already knows: one in the recent list or open in Vellum.
        bridge.Register("collections.add", request =>
        {
            var path = RequiredString(request, "path");
            if (_recent.Find(path) is null && !_server!.IsWritable(path)) throw new InvalidOperationException("That file isn't in the recent list or open in Vellum.");
            return Done(new { added = _collections.Add(RequiredString(request, "id"), [path]) });
        });
        // Adds files chosen in the Open dialog (none are opened).
        bridge.Register("collections.addDialog", request =>
        {
            var id = RequiredString(request, "id");
            var dialog = new OpenFileDialog
            {
                Title = "Add PDFs to the collection",
                Filter = "PDF documents (*.pdf)|*.pdf|All files (*.*)|*.*",
                Multiselect = true,
                InitialDirectory = LastFolder(),
            };
            if (dialog.ShowDialog(this) != true) return Done(new { added = 0, chosen = 0 });
            return Done(new { added = _collections.Add(id, dialog.FileNames), chosen = dialog.FileNames.Length });
        });
        // The documents of one collection as read-only URLs, for Collection research: the page reads their text
        // and can never write to them (POST /save/{token} is refused for a read-only token).
        bridge.Register("collections.documents", request =>
        {
            var id = RequiredString(request, "id");
            var collection = _collections.All.FirstOrDefault(c => c.Id == id) ?? throw new InvalidOperationException("That collection no longer exists.");
            return Done(new
            {
                collection.Name,
                documents = collection.Paths.Select(p =>
                {
                    var exists = File.Exists(p);
                    return new
                    {
                        path = p,
                        name = Path.GetFileName(p),
                        exists,
                        url = exists ? $"{AppResourceServer.Origin}/doc/{_server!.RegisterReadOnlyDocument(p)}" : null,
                    };
                }).ToArray(),
            });
        });
        bridge.Register("collections.remove", request =>
        {
            _collections.Remove(RequiredString(request, "id"), RequiredString(request, "path"));
            return Done();
        });

        // ---- saved research: a result kept as the page made it, given back unchanged; no PDF is touched ----

        bridge.Register("research.list", _ => Done(new
        {
            items = _savedResearch.All.Select(r => new
            {
                r.Id,
                r.Name,
                r.CreatedAt,
                result = r.Result,
                documents = r.Paths.Select(p => new { path = p, name = Path.GetFileName(p), exists = File.Exists(p) }).ToArray(),
            }).ToArray(),
        }));
        // The page hands over the whole result and the paths it quotes; nothing is recomputed here or on opening.
        bridge.Register("research.save", request =>
        {
            if (request.Payload.ValueKind != JsonValueKind.Object || !request.Payload.TryGetProperty("result", out var result) || result.ValueKind != JsonValueKind.Object)
                throw new ArgumentException("There is no research result to save.");
            var paths = new List<string>();
            if (request.Payload.TryGetProperty("paths", out var listed) && listed.ValueKind == JsonValueKind.Array)
                paths.AddRange(listed.EnumerateArray().Where(p => p.ValueKind == JsonValueKind.String).Select(p => p.GetString()!));
            var saved = _savedResearch.Save(RequiredString(request, "name"), paths, JsonNode.Parse(result.GetRawText()));
            return Done(new { saved.Id, saved.Name, saved.CreatedAt });
        });
        bridge.Register("research.delete", request =>
        {
            _savedResearch.Delete(RequiredString(request, "id"));
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

        // Document history: snapshots of an open document, kept on this PC (Services/DocumentHistory.cs).
        // Only documents the page was given to open or save may have history; snapshots open read-only.
        bridge.Register("history.list", request => Done(new { snapshots = _history.List(HistoryDocument(request)) }));
        bridge.Register("history.create", request =>
            Done(new { snapshot = _history.Create(HistoryDocument(request), OptionalString(request, "name")) }));
        bridge.Register("history.open", request =>
        {
            var document = HistoryDocument(request);
            var (snapshot, file) = _history.Get(document, RequiredString(request, "id"));
            var token = _server!.RegisterReadOnlyDocument(file);
            var label = snapshot.Name.Length > 0 ? snapshot.Name : $"Snapshot {snapshot.CreatedAt:d MMM yyyy HH.mm}";
            return Done(new
            {
                file = new
                {
                    token,
                    path = file,
                    name = $"{Path.GetFileNameWithoutExtension(document)} — {label}.pdf",
                    size = snapshot.Size,
                    url = $"{AppResourceServer.Origin}/doc/{token}",
                    readOnly = true,
                    snapshot = new { snapshot.Id, snapshot.Name, snapshot.CreatedAt, document },
                },
            });
        });
        bridge.Register("history.delete", request =>
        {
            _history.Delete(HistoryDocument(request), RequiredString(request, "id"));
            return Done();
        });
        bridge.Register("history.clear", request => Done(new { removed = _history.Clear(HistoryDocument(request)) }));
        // Save As: the document's history follows it to the new path (both paths must be open in Vellum).
        bridge.Register("history.move", request =>
        {
            var to = RequiredString(request, "to");
            if (!_server!.IsWritable(to)) throw new InvalidOperationException("That document isn’t open in Vellum.");
            var moved = _history.Move(HistoryDocument(request), to);
            return Done(new { moved = moved == HistoryMove.Moved, conflict = moved == HistoryMove.Conflict });
        });
        // Settings: every document's history on this PC. A history is named by its folder's key, never by a
        // path from the page; removing one deletes that folder in Vellum's data folder and never a document.
        bridge.Register("history.stored", _ => Done(new { documents = _history.Stored() }));
        bridge.Register("history.openStored", request =>
            Done(new { file = DescribeFile(_history.DocumentFor(RequiredString(request, "key"))) }));
        bridge.Register("history.removeStored", request =>
            Done(new { removed = _history.RemoveStored(RequiredString(request, "key"), OptionalBool(request, "onlyIfMissing") == true) }));
        bridge.Register("history.removeMissing", _ => Done(new { removed = _history.RemoveMissing() }));

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
            _settings.FollowSystemTheme = request.Payload.TryGetProperty("system", out var system) && system.ValueKind == JsonValueKind.True;
            _settings.Background = OptionalString(request, "background") is { } background && HexColor.IsMatch(background) ? background : null;
            _settings.Save();
            ApplyThemeColors();
            WindowEffects.ApplyTheme(Handle, IsDark);
            Web.CoreWebView2.Profile.PreferredColorScheme = PreferredScheme;
            return Done();
        });

        RegisterUpdateHandlers(bridge);
        RegisterOcrLanguageHandlers(bridge);
        RegisterExportHandlers(bridge);
        RegisterHtmlToPdfHandlers(bridge);
        RegisterOfficeConversionHandlers(bridge);
        RegisterBatchHandlers(bridge);
        RegisterFlowHandlers(bridge);
    }

    // ---- window placement & theme ------------------------------------------

    private void ApplyThemeColors()
    {
        // Until the page reports its theme: Mist, dark (obsidian) or light.
        var (r, g, b) = IsDark ? ((byte)0x12, (byte)0x16, (byte)0x17) : ((byte)0xED, (byte)0xF1, (byte)0xF0);
        // The page reports its theme's own background, so a coloured theme doesn't flash grey on start.
        if (_settings.Background is { } hex && HexColor.IsMatch(hex))
        {
            var rgb = Convert.ToInt32(hex[1..], 16);
            (r, g, b) = ((byte)(rgb >> 16), (byte)(rgb >> 8), (byte)rgb);
        }
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
            resume = entry is null ? null : new { page = entry.Page, scaleValue = entry.ScaleValue, viewMode = entry.ViewMode, spread = entry.Spread },
        };
    }

    private string HistoryDocument(BridgeRequest request)
    {
        var path = RequiredString(request, "path");
        if (!_server!.IsWritable(path)) throw new InvalidOperationException("That document isn’t open in Vellum.");
        return Path.GetFullPath(path);
    }

    private string LastFolder()
    {
        var last = _recent.Entries.Select(e => Path.GetDirectoryName(e.Path)).FirstOrDefault(Directory.Exists);
        return last ?? Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments);
    }

    private static Task<object?> Done(object? result = null) => Task.FromResult(result);

    /// <summary>First name for the home screen's greeting, from the account's display name; empty if there is none.</summary>
    private static string GreetingName()
    {
        try
        {
            uint size = 256;
            var buffer = new System.Text.StringBuilder((int)size);
            if (NativeMethods.GetUserNameEx(NativeMethods.NameDisplay, buffer, ref size))
                return buffer.ToString().Trim().Split(' ', StringSplitOptions.RemoveEmptyEntries).FirstOrDefault() ?? "";
        }
        catch (Exception) { /* no display name: greet without one */ }
        return "";
    }

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
    private static readonly Regex HexColor = new("^#[0-9a-fA-F]{6}$", RegexOptions.Compiled);

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
