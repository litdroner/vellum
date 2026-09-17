using System.Diagnostics;
using System.IO;
using System.Text.Json;
using Vellum.Hosting;
using Vellum.Services;

namespace Vellum;

// In-app updates. The page drives the flow (check → download with progress → install); the host talks
// to GitHub and runs Setup (see Services/Updater.cs).
public partial class MainWindow
{
    private readonly Updater _updater = new(DataFolder);
    private Updater.Release? _latest;
    /// <summary>The verified installer for <see cref="_latest"/>, once downloaded.</summary>
    private string? _downloaded;
    private CancellationTokenSource? _download;

    private void RegisterUpdateHandlers(BridgeHost bridge)
    {
        bridge.Register("update.settings", _ => Done(new
        {
            current = Updater.Current.ToString(3),
            auto = _settings.AutoUpdate,
            lastCheck = _settings.LastUpdateCheck,
        }));
        bridge.Register("update.setAuto", request =>
        {
            _settings.AutoUpdate = OptionalBool(request, "enabled") ?? true;
            _settings.Save();
            return Done();
        });
        bridge.Register("update.skip", request =>
        {
            _settings.SkippedVersion = RequiredString(request, "version");
            _settings.Save();
            return Done();
        });
        bridge.Register("update.check", CheckForUpdateAsync);
        bridge.Register("update.download", DownloadUpdateAsync);
        bridge.Register("update.cancel", _ =>
        {
            _download?.Cancel();
            return Done();
        });
        bridge.Register("update.install", InstallUpdateAsync);
        bridge.Register("update.notes", ReleaseNotesAsync);
    }

    /// <summary>
    /// Asks GitHub for the newest release. Automatic checks (at most one a day, and only if enabled) stay
    /// quiet about failures and about a version the user chose to skip.
    /// </summary>
    private async Task<object?> CheckForUpdateAsync(BridgeRequest request)
    {
        var automatic = OptionalBool(request, "auto") == true;
        var current = Updater.Current.ToString(3);
        if (automatic && (!_settings.AutoUpdate || _settings.LastUpdateCheck > DateTimeOffset.Now.AddHours(-20)))
            return new { available = false, current };

        Updater.Release? latest;
        try
        {
            latest = await _updater.GetLatestAsync();
        }
        catch (UpdateException) when (automatic)
        {
            return new { available = false, current };
        }
        _settings.LastUpdateCheck = DateTimeOffset.Now;
        _settings.Save();

        if (latest is null || latest.Version <= Updater.Current || latest.DownloadUrl.Length == 0
            || (automatic && latest.Version.ToString(3) == _settings.SkippedVersion))
            return new { available = false, current, latest = latest?.Version.ToString(3) };

        if (_latest?.Version != latest.Version) _downloaded = null;
        _latest = latest;
        return new
        {
            available = true,
            current,
            version = latest.Version.ToString(3),
            name = latest.Name,
            notes = latest.Notes,
            size = latest.Size,
            publishedAt = latest.PublishedAt,
            page = latest.PageUrl,
            verified = latest.Sha256 is not null,
        };
    }

    /// <summary>Downloads the update found by the last check, sending "update-progress" events as it goes.</summary>
    private async Task<object?> DownloadUpdateAsync(BridgeRequest request)
    {
        var release = _latest ?? throw new InvalidOperationException("Check for updates first.");
        _download?.Cancel();
        using var cts = new CancellationTokenSource();
        _download = cts;
        var clock = Stopwatch.StartNew();
        var lastReport = -1000L;
        // Created on the UI thread, so reports arrive there (the WebView may only be used from it).
        var progress = new Progress<(long Received, long Total)>(p =>
        {
            if (clock.ElapsedMilliseconds - lastReport < 80 && p.Received < p.Total) return;
            lastReport = clock.ElapsedMilliseconds;
            _bridge?.Emit("update-progress", new { received = p.Received, total = p.Total });
        });
        try
        {
            _downloaded = await _updater.DownloadAsync(release, progress, cts.Token,
                () => Dispatcher.BeginInvoke(() => _bridge?.Emit("update-stage", new { stage = "verifying" })));
            return new { done = true, version = release.Version.ToString(3) };
        }
        catch (OperationCanceledException) when (cts.IsCancellationRequested)
        {
            return new { cancelled = true };
        }
        finally
        {
            if (_download == cts) _download = null;
        }
    }

    /// <summary>
    /// Starts Setup (no window of its own) and closes Vellum, which Setup restarts once it's done. The page
    /// has already dealt with unsaved changes and shows "Installing…", then "Restarting…".
    /// </summary>
    private async Task<object?> InstallUpdateAsync(BridgeRequest request)
    {
        if (_latest?.Sha256 is not { } sha256 || _downloaded is null || !File.Exists(_downloaded))
            throw new InvalidOperationException("Download the update first.");
        // Written first, so Setup never finds Vellum closed without it.
        Updater.SaveRelaunchFiles(DataFolder, StringArray(request, "files"), _latest.Version);
        try
        {
            await _updater.StartInstallerAsync(_downloaded, sha256);
        }
        catch
        {
            Updater.TakeRelaunch(DataFolder);
            throw;
        }
        // Setup waits for this process to exit, installs, then starts the new version, which reopens the files.
        _allowClose = true;
        _ = Task.Delay(700).ContinueWith(_ => Dispatcher.BeginInvoke(Close), TaskScheduler.Default);
        return new { ok = true };
    }

    /// <summary>The running version's release notes ("What's new" after an update).</summary>
    private async Task<object?> ReleaseNotesAsync(BridgeRequest request)
    {
        var release = await _updater.GetReleaseAsync(Updater.Current);
        return new { version = Updater.Current.ToString(3), notes = release?.Notes, page = release?.PageUrl };
    }

    private static bool? OptionalBool(BridgeRequest request, string name) =>
        request.Payload.ValueKind == JsonValueKind.Object && request.Payload.TryGetProperty(name, out var v)
            && (v.ValueKind == JsonValueKind.True || v.ValueKind == JsonValueKind.False)
            ? v.GetBoolean()
            : null;

    private static string[] StringArray(BridgeRequest request, string name) =>
        request.Payload.ValueKind == JsonValueKind.Object && request.Payload.TryGetProperty(name, out var list) && list.ValueKind == JsonValueKind.Array
            ? list.EnumerateArray().Where(e => e.ValueKind == JsonValueKind.String).Select(e => e.GetString()!).ToArray()
            : [];
}
