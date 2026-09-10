using System.IO;
using System.Windows;
using Vellum.Services;

namespace Vellum;

public partial class App : Application
{
    private SingleInstance? _instance;

    protected override void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);

        // Used by the installer.
        if (e.Args.Contains("--register-association")) { FileAssociation.Register(); Shutdown(); return; }
        if (e.Args.Contains("--unregister-association")) { FileAssociation.Unregister(); Shutdown(); return; }

        // Any existing file passed on the command line (double-click / "Open with") is opened on launch.
        var files = e.Args
            .Where(a => !a.StartsWith("--", StringComparison.Ordinal))
            .Where(File.Exists)
            .Select(Path.GetFullPath)
            .ToArray();

        _instance = new SingleInstance();
        if (!_instance.IsPrimary && SingleInstance.TryForward(files))
        {
            Shutdown();
            return;
        }

        var window = new MainWindow(files);
        MainWindow = window;
        window.Show();
        _instance.Listen(paths => Dispatcher.BeginInvoke(() => window.OpenFromOtherInstance(paths)));
    }

    protected override void OnExit(ExitEventArgs e)
    {
        _instance?.Dispose();
        base.OnExit(e);
    }
}
