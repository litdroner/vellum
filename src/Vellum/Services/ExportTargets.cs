using System.IO;

namespace Vellum.Services;

// Where a file Vellum writes for the person lands, by name, in a folder the host already allowed: the Export
// Center, Compress and PDF/A (export.targets), and each item of a batch (MainWindow.Batch.cs). The page proposes
// a name; the host cleans it and decides the path, so a name can never climb out of its folder.
//
// Two rules keep other files safe. "Keep both" never replaces anything: the name is numbered instead
// ("report (2).pdf"). And a file the page may only read — a batch's own source, a history snapshot — is never
// a target at all, whatever was asked: its name is numbered too, so an output can never overwrite an input.
public static class ExportTargets
{
    /// <summary>More numbered names than any folder needs: past this, something is wrong, so stop.</summary>
    private const int MostNumbered = 10_000;

    /// <summary>A file name the page asked for, as a plain name in one folder: no separators, no invalid characters.</summary>
    public static string CleanName(string requested)
    {
        var invalid = Path.GetInvalidFileNameChars();
        var name = new string(Path.GetFileName(requested).Where(c => !invalid.Contains(c)).ToArray()).Trim().TrimEnd('.');
        if (name.Length == 0 || name is "." or "..") throw new ArgumentException("That file name can’t be used.");
        return name;
    }

    /// <summary>
    /// The path `requested` gets in `folder`. Replacing (keepBoth false), it is the name itself, unless this
    /// request already used it (`taken`) or `keep` says that file must not be written; keeping both, it is the
    /// first free name. Every path returned is added to `taken` (compare paths ignoring case).
    /// </summary>
    public static string Resolve(string folder, string requested, bool keepBoth, ISet<string> taken, Func<string, bool>? keep = null)
    {
        var name = CleanName(requested);
        var path = Path.Combine(folder, name);
        if (!keepBoth && keep?.Invoke(path) != true && taken.Add(path)) return path;
        return Free(folder, name, taken, keep);
    }

    /// <summary>"name.pdf", then "name (2).pdf", …: the first name in `folder` that isn't there, taken or kept.</summary>
    public static string Free(string folder, string name, ISet<string> taken, Func<string, bool>? keep = null)
    {
        var stem = Path.GetFileNameWithoutExtension(name);
        var extension = Path.GetExtension(name);
        for (var i = 1; i <= MostNumbered; i++)
        {
            var path = Path.Combine(folder, (i == 1 ? stem : $"{stem} ({i})") + extension);
            if (!File.Exists(path) && keep?.Invoke(path) != true && taken.Add(path)) return path;
        }
        throw new IOException($"There are too many files called “{stem}” in that folder already.");
    }
}
