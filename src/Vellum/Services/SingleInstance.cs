using System.IO.Pipes;
using System.Security.Principal;
using System.Text.Json;

namespace Vellum.Services;

/// <summary>
/// Keeps one Vellum window per user. A second launch (e.g. double-clicking another PDF) sends its
/// file paths to the running instance over a named pipe and exits, so the file opens as a new tab.
/// The pipe only accepts connections from the same Windows user.
/// </summary>
public sealed class SingleInstance : IDisposable
{
    private static readonly string UserId = WindowsIdentity.GetCurrent().User?.Value ?? Environment.UserName;
    private static readonly string PipeName = $"Vellum.Open.{UserId}";

    private readonly Mutex _mutex;
    private readonly CancellationTokenSource _cts = new();

    public bool IsPrimary { get; }

    public SingleInstance()
    {
        _mutex = new Mutex(initiallyOwned: true, $@"Local\Vellum.Instance.{UserId}", out var createdNew);
        IsPrimary = createdNew;
    }

    /// <summary>Hands files to the running instance. False if it couldn't be reached.</summary>
    public static bool TryForward(string[] files)
    {
        try
        {
            using var client = new NamedPipeClientStream(".", PipeName, PipeDirection.Out, PipeOptions.CurrentUserOnly);
            client.Connect(3000);
            // Allow the running instance to take focus (Windows otherwise blocks background apps from doing so).
            NativeMethods.AllowSetForegroundWindow(NativeMethods.ASFW_ANY);
            JsonSerializer.Serialize(client, files);
            client.Flush();
            return true;
        }
        catch (Exception)
        {
            return false;
        }
    }

    /// <summary>Starts listening for other launches. <paramref name="onFiles"/> runs on a background thread.</summary>
    public void Listen(Action<string[]> onFiles)
    {
        if (!IsPrimary) return;
        _ = Task.Run(async () =>
        {
            while (!_cts.IsCancellationRequested)
            {
                try
                {
                    await using var server = new NamedPipeServerStream(PipeName, PipeDirection.In, 1,
                        PipeTransmissionMode.Byte, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
                    await server.WaitForConnectionAsync(_cts.Token);
                    var files = await JsonSerializer.DeserializeAsync<string[]>(server, cancellationToken: _cts.Token) ?? [];
                    onFiles(files);
                }
                catch (OperationCanceledException)
                {
                    break;
                }
                catch (Exception)
                {
                    // A malformed message or a pipe hiccup: keep serving, but never spin.
                    await Task.Delay(250);
                }
            }
        });
    }

    public void Dispose()
    {
        _cts.Cancel();
        if (IsPrimary)
        {
            try { _mutex.ReleaseMutex(); } catch (ApplicationException) { /* not owned by this thread */ }
        }
        _mutex.Dispose();
    }
}
