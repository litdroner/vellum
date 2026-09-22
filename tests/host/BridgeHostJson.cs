// RecentFiles saves with BridgeHost.Json; the real BridgeHost needs WebView2, so the tests use the same options here.
using System.Text.Json;

namespace Vellum.Hosting;

public static class BridgeHost
{
    public static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
}
