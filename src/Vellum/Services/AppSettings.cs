using System.IO;
using System.Text.Json;
using Vellum.Hosting;

namespace Vellum.Services;

/// <summary>Small app preferences kept in %LOCALAPPDATA%\Vellum\settings.json: theme, window placement, updates.</summary>
public sealed class AppSettings
{
    private string _path = "";

    public string Theme { get; set; } = "light";
    /// <summary>The appearance follows Windows' light/dark setting (Theme is then what it resolved to).</summary>
    public bool FollowSystemTheme { get; set; }
    /// <summary>The theme's background colour (#rrggbb), painted behind the page while it loads.</summary>
    public string? Background { get; set; }

    /// <summary>The version that last ran, to say "Updated to …" once after an update.</summary>
    public string? LastRunVersion { get; set; }
    public bool AutoUpdate { get; set; } = true;
    public DateTimeOffset? LastUpdateCheck { get; set; }
    /// <summary>A version the user chose to skip: automatic checks stay quiet about it.</summary>
    public string? SkippedVersion { get; set; }

    public double? Left { get; set; }
    public double? Top { get; set; }
    public double? Width { get; set; }
    public double? Height { get; set; }
    public bool Maximized { get; set; }

    public static AppSettings Load(string folder)
    {
        var path = Path.Combine(folder, "settings.json");
        AppSettings settings;
        try
        {
            settings = File.Exists(path)
                ? JsonSerializer.Deserialize<AppSettings>(File.ReadAllText(path), BridgeHost.Json) ?? new AppSettings()
                : new AppSettings();
        }
        catch (Exception)
        {
            settings = new AppSettings(); // unreadable settings just reset to defaults
        }
        settings._path = path;
        return settings;
    }

    public void Save()
    {
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(_path)!);
            var temp = _path + ".tmp";
            File.WriteAllText(temp, JsonSerializer.Serialize(this, BridgeHost.Json));
            File.Move(temp, _path, overwrite: true);
        }
        catch (IOException) { /* best effort */ }
        catch (UnauthorizedAccessException) { }
    }
}
