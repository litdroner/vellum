using System.Collections.Concurrent;
using System.IO;
using System.Security.Cryptography;
using System.Text.Json;
using System.Windows.Threading;
using Microsoft.Web.WebView2.Core;

namespace Vellum.Hosting;

/// <summary>
/// Serves everything the page loads from a fake origin (https://app.vellum), without a real web server.
/// WebView2 hands us each request; we answer with a file from the bundled web folder, or with the bytes
/// of a PDF the user opened. Only files we registered can be read or written, never arbitrary disk paths.
///   GET  /doc/{token}   the PDF's bytes
///   POST /save/{token}  new bytes for that PDF (annotations saved); written atomically
///   GET  /ocr-lang/{code}.traineddata.gz  a downloaded OCR language pack, only once verified (see OcrLanguages)
/// </summary>
public sealed class AppResourceServer
{
    public const string Origin = "https://app.vellum";

    /// <summary>Present in files that contain annotations Vellum wrote (see annotations/persist.js).</summary>
    private static readonly byte[] VellumMarker = "/VellumId"u8.ToArray();

    private static readonly Dictionary<string, string> MimeTypes = new(StringComparer.OrdinalIgnoreCase)
    {
        [".html"] = "text/html; charset=utf-8",
        [".js"] = "text/javascript; charset=utf-8",
        [".mjs"] = "text/javascript; charset=utf-8",
        [".css"] = "text/css; charset=utf-8",
        [".json"] = "application/json",
        [".svg"] = "image/svg+xml",
        [".png"] = "image/png",
        [".gif"] = "image/gif",
        [".ico"] = "image/x-icon",
        [".woff2"] = "font/woff2",
        [".ttf"] = "font/ttf",
        [".wasm"] = "application/wasm",
        [".pdf"] = "application/pdf",
    };

    private readonly CoreWebView2Environment _env;
    private readonly string _webRoot;
    private readonly Dispatcher _dispatcher;
    private readonly ConcurrentDictionary<string, string> _documents = new();
    /// <summary>Tokens the page may read but never write (document history snapshots).</summary>
    private readonly ConcurrentDictionary<string, bool> _readOnly = new();

    public AppResourceServer(CoreWebView2 core, CoreWebView2Environment env, string webRoot)
    {
        _env = env;
        _webRoot = Path.GetFullPath(webRoot);
        _dispatcher = Dispatcher.CurrentDispatcher;
        // "All" source kinds so requests made from pdf.js's worker thread are intercepted too.
        core.AddWebResourceRequestedFilter(Origin + "/*", CoreWebView2WebResourceContext.All,
            CoreWebView2WebResourceRequestSourceKinds.All);
        core.WebResourceRequested += OnWebResourceRequested;
    }

    /// <summary>Makes a file readable (and writable, for saving) by the page; returns the opaque token used in its URL.</summary>
    public string RegisterDocument(string path)
    {
        var full = Path.GetFullPath(path);
        foreach (var (token, existing) in _documents)
            if (string.Equals(existing, full, StringComparison.OrdinalIgnoreCase) && !_readOnly.ContainsKey(token)) return token;
        var newToken = Guid.NewGuid().ToString("N");
        _documents[newToken] = full;
        return newToken;
    }

    /// <summary>Makes a file readable by the page, never writable: POST /save/{token} is refused.</summary>
    public string RegisterReadOnlyDocument(string path)
    {
        var full = Path.GetFullPath(path);
        foreach (var (token, existing) in _documents)
            if (string.Equals(existing, full, StringComparison.OrdinalIgnoreCase) && _readOnly.ContainsKey(token)) return token;
        var newToken = Guid.NewGuid().ToString("N");
        _readOnly[newToken] = true;
        _documents[newToken] = full;
        return newToken;
    }

    /// <summary>A downloaded OCR language pack's verified bytes by language code, or null (set by the window).</summary>
    public Func<string, byte[]?>? OcrLanguage { get; set; }

    public string? ResolveDocument(string token) => _documents.TryGetValue(token, out var p) ? p : null;

    /// <summary>True if the page was given this file to open or save to (writable).</summary>
    public bool IsWritable(string path)
    {
        var full = Path.GetFullPath(path);
        return _documents.Any(d => !_readOnly.ContainsKey(d.Key) && string.Equals(d.Value, full, StringComparison.OrdinalIgnoreCase));
    }

    private void OnWebResourceRequested(object? sender, CoreWebView2WebResourceRequestedEventArgs e)
    {
        try
        {
            var uri = new Uri(e.Request.Uri);
            var path = Uri.UnescapeDataString(uri.AbsolutePath);

            if (path.StartsWith("/save/", StringComparison.Ordinal))
            {
                if (e.Request.Method == "POST") HandleSave(e, path["/save/".Length..]);
                else e.Response = Error(405, "Method Not Allowed");
                return;
            }

            if (path.StartsWith("/doc/", StringComparison.Ordinal))
            {
                var file = ResolveDocument(path["/doc/".Length..]);
                if (file is null || !File.Exists(file))
                {
                    e.Response = Error(404, "Not Found");
                    return;
                }
                var bytes = ReadShared(file);
                var span = bytes.GetBuffer().AsSpan(0, (int)bytes.Length);
                // A content hash identifies the file for annotations kept outside it (protected PDFs),
                // so they follow the file through renames and moves.
                var headers = $"X-Vellum-Doc-Key: {Convert.ToHexString(SHA256.HashData(span))}";
                if (span.IndexOf(VellumMarker) >= 0) headers += "\r\nX-Vellum-Annotations: 1";
                e.Response = FileResponse(bytes, ".pdf", headers);
                return;
            }

            if (path.StartsWith("/ocr-lang/", StringComparison.Ordinal))
            {
                var name = path["/ocr-lang/".Length..];
                var bytes = name.EndsWith(".traineddata.gz", StringComparison.Ordinal) ? OcrLanguage?.Invoke(name[..^".traineddata.gz".Length]) : null;
                e.Response = bytes is null ? Error(404, "Not Found") : FileResponse(new MemoryStream(bytes, writable: false), ".gz");
                return;
            }

            // Static front-end file. Resolve and make sure it stays inside the web folder.
            var relative = path.TrimStart('/').Replace('/', Path.DirectorySeparatorChar);
            if (relative.Length == 0) relative = "index.html";
            var full = Path.GetFullPath(Path.Combine(_webRoot, relative));
            if (!full.StartsWith(_webRoot + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)
                || !File.Exists(full))
            {
                e.Response = Error(404, "Not Found");
                return;
            }
            e.Response = FileResponse(File.OpenRead(full), Path.GetExtension(full));
        }
        catch (Exception ex)
        {
            e.Response = Error(500, ex.GetType().Name);
        }
    }

    /// <summary>Receives the new PDF bytes and replaces the file on a background thread.</summary>
    private void HandleSave(CoreWebView2WebResourceRequestedEventArgs e, string token)
    {
        var file = ResolveDocument(token);
        if (file is not null && _readOnly.ContainsKey(token))
        {
            e.Response = JsonResponse(403, new { ok = false, error = "This is a snapshot from the document’s history. It can’t be changed; use Save As to keep a copy." });
            return;
        }
        if (file is null)
        {
            e.Response = JsonResponse(404, new { ok = false, error = "That document isn't open in Vellum." });
            return;
        }
        var body = new MemoryStream();
        e.Request.Content?.CopyTo(body);

        var deferral = e.GetDeferral();
        Task.Run(() => WriteAtomically(file, body)).ContinueWith(task => _dispatcher.BeginInvoke(() =>
        {
            e.Response = task.Exception is null
                ? JsonResponse(200, new { ok = true })
                : JsonResponse(500, new { ok = false, error = DescribeWriteError(task.Exception.InnerException ?? task.Exception) });
            deferral.Complete();
        }));
    }

    /// <summary>
    /// Writes to a temporary file next to the target, then swaps it in. If anything fails part-way,
    /// the original file is untouched.
    /// </summary>
    private static void WriteAtomically(string path, MemoryStream data)
    {
        var bytes = data.GetBuffer().AsSpan(0, (int)data.Length);
        if (bytes.Length < 8 || bytes[..Math.Min(1024, bytes.Length)].IndexOf("%PDF-"u8) < 0)
            throw new InvalidDataException("The data to save isn't a valid PDF, so nothing was written.");

        var directory = Path.GetDirectoryName(path)!;
        var temp = Path.Combine(directory, $"~{Path.GetFileName(path)}.{Guid.NewGuid():N}.tmp");
        try
        {
            using (var stream = new FileStream(temp, FileMode.CreateNew, FileAccess.Write, FileShare.None))
            {
                stream.Write(bytes);
                stream.Flush(flushToDisk: true);
            }
            if (File.Exists(path)) File.Replace(temp, path, destinationBackupFileName: null, ignoreMetadataErrors: true);
            else File.Move(temp, path);
        }
        finally
        {
            if (File.Exists(temp)) File.Delete(temp);
        }
    }

    private static string DescribeWriteError(Exception ex) => ex switch
    {
        UnauthorizedAccessException => "Vellum isn't allowed to write this file. It may be read-only, or in a protected folder. Try Save As.",
        IOException io when (io.HResult & 0xFFFF) is 32 or 33 => "Another program has this file open and locked. Close it there and try again.",
        InvalidDataException => ex.Message,
        _ => $"The file couldn't be written: {ex.Message}",
    };

    /// <summary>
    /// Reads the PDF into memory so no handle is left open on the user's file
    /// (otherwise saving annotations back over it could fail while WebView2 still holds the stream).
    /// </summary>
    private static MemoryStream ReadShared(string path)
    {
        using var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
        var ms = new MemoryStream((int)Math.Min(fs.Length, int.MaxValue));
        fs.CopyTo(ms);
        ms.Position = 0;
        return ms;
    }

    private CoreWebView2WebResourceResponse FileResponse(Stream content, string extension, string? extraHeaders = null)
    {
        var mime = MimeTypes.TryGetValue(extension, out var m) ? m : "application/octet-stream";
        var headers = $"Content-Type: {mime}\r\nCache-Control: no-store\r\nContent-Length: {content.Length}";
        if (extraHeaders is not null) headers += "\r\n" + extraHeaders;
        return _env.CreateWebResourceResponse(content, 200, "OK", headers);
    }

    private CoreWebView2WebResourceResponse JsonResponse(int status, object payload) =>
        _env.CreateWebResourceResponse(new MemoryStream(JsonSerializer.SerializeToUtf8Bytes(payload, BridgeHost.Json)),
            status, status == 200 ? "OK" : "Error", "Content-Type: application/json\r\nCache-Control: no-store");

    private CoreWebView2WebResourceResponse Error(int status, string reason) =>
        _env.CreateWebResourceResponse(null, status, reason, "Cache-Control: no-store");
}
