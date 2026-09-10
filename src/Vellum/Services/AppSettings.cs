using System.IO;
using System.Text.Json;
using Vellum.Hosting;

namespace Vellum.Services;

/// <summary>Small app preferences kept in %LOCALAPPDATA%\Vellum\settings.json: theme and window placement.</summary>
public sealed class AppSettings
{
    private string _path = "";

    public string Theme { get; set; } = "dark";
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
