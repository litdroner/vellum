using System.Text.Json;
using Microsoft.Web.WebView2.Core;

namespace Vellum.Hosting;

/// <summary>One call from the page: its payload plus the raw message (which carries native objects such as dropped files).</summary>
public sealed record BridgeRequest(JsonElement Payload, CoreWebView2WebMessageReceivedEventArgs Message);

/// <summary>
/// The C# half of the C# ↔ JS bridge.
/// Page → host:  { id, type, payload }  — answered with { replyTo: id, ok, result | error }.
/// Host → page:  { event, payload }     — pushed events such as "open-files".
/// </summary>
public sealed class BridgeHost
{
    public static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    private readonly CoreWebView2 _core;
    private readonly Dictionary<string, Func<BridgeRequest, Task<object?>>> _handlers = new(StringComparer.Ordinal);

    public BridgeHost(CoreWebView2 core)
    {
        _core = core;
        _core.WebMessageReceived += OnWebMessageReceived;
    }

    public void Register(string type, Func<BridgeRequest, Task<object?>> handler) => _handlers[type] = handler;

    public void Emit(string eventName, object? payload = null) =>
        Post(JsonSerializer.Serialize(new { @event = eventName, payload }, Json));

    private void Post(string json)
    {
        // The WebView may already be gone while the window is closing.
        try { _core.PostWebMessageAsJson(json); }
        catch (InvalidOperationException) { }
        catch (System.Runtime.InteropServices.COMException) { }
    }

    private async void OnWebMessageReceived(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        // Only trust messages from our own page.
        if (!e.Source.StartsWith(AppResourceServer.Origin + "/", StringComparison.OrdinalIgnoreCase)) return;

        JsonElement message;
        try { message = JsonDocument.Parse(e.WebMessageAsJson).RootElement.Clone(); }
        catch (JsonException) { return; }

        var id = message.TryGetProperty("id", out var idEl) && idEl.ValueKind == JsonValueKind.Number ? idEl.GetInt64() : 0;
        var type = message.TryGetProperty("type", out var typeEl) ? typeEl.GetString() : null;
        var payload = message.TryGetProperty("payload", out var p) ? p : default;

        if (type is null || !_handlers.TryGetValue(type, out var handler))
        {
            Reply(id, false, null, $"Unknown bridge call '{type}'.");
            return;
        }

        try
        {
            var result = await handler(new BridgeRequest(payload, e));
            Reply(id, true, result, null);
        }
        catch (Exception ex)
        {
            Reply(id, false, null, ex.Message);
        }
    }

    private void Reply(long id, bool ok, object? result, string? error)
    {
        if (id == 0) return; // fire-and-forget message
        Post(JsonSerializer.Serialize(new { replyTo = id, ok, result, error }, Json));
    }
}
