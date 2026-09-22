// OCR languages as the page sees them. English is bundled and always installed; other languages are packs
// the host downloads on request and verifies (Services/OcrLanguages.cs, list in languages.json). Pure
// functions, so the rules are testable without the app; ocr/language-packs.js talks to the host.

export const ENGLISH = Object.freeze({ code: 'eng', name: 'English', builtIn: true, installed: true, size: 0 });

/** The host's answer ({ selected, downloading, packs }) as one list, English first, then packs by name. */
export function languageList(answer) {
  const packs = (answer?.packs ?? [])
    .filter((p) => p && /^[a-z]{3}$/.test(p.code) && p.code !== ENGLISH.code)
    .map((p) => ({ code: p.code, name: String(p.name || p.code), builtIn: false, installed: Boolean(p.installed), size: Number(p.size) || 0 }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const languages = [ENGLISH, ...packs];
  const selected = languages.some((l) => l.code === answer?.selected) ? answer.selected : ENGLISH.code;
  return { selected, downloading: answer?.downloading ?? null, languages };
}

export const installedLanguages = (list) => list.languages.filter((l) => l.installed);
export const availableLanguages = (list) => list.languages.filter((l) => !l.installed);

/** The language OCR reads in: the selected one (which may not be downloaded; see ocrReadiness). */
export const selectedLanguage = (list) => list.languages.find((l) => l.code === list.selected) ?? ENGLISH;

/**
 * Whether OCR can run in `language`, given the host's full check (ocr.prepare → { ready, reason }).
 * English never depends on a pack. Resolves to { ready, title, message } for the dialog.
 */
export function ocrReadiness(language, check) {
  if (language.builtIn || check?.ready) return { ready: true };
  const damaged = check?.reason === 'damaged';
  return {
    ready: false,
    title: damaged ? `The ${language.name} language data is damaged` : `${language.name} isn’t downloaded`,
    message: damaged
      ? `OCR in ${language.name} needs its language pack, and the copy on this PC didn’t pass its check, so it was removed. Download it again in Settings → OCR, or read this document in English.`
      : `OCR in ${language.name} needs its language pack. Download it in Settings → OCR (${formatMB(language.size)}), or read this document in English.`,
  };
}

/** "1.3 MB" */
export function formatMB(bytes) {
  const mb = (Number(bytes) || 0) / (1024 * 1024);
  return `${mb >= 10 ? Math.round(mb) : Math.max(0.1, Math.round(mb * 10) / 10)} MB`;
}
