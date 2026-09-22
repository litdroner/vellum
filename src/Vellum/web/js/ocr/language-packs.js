import { bridge } from '../bridge.js';
import { ENGLISH, languageList } from './languages.js';

// The host's OCR language calls (MainWindow.Ocr.cs). Without the host (a plain browser) only English exists.

export const languagePacks = {
  async list() {
    if (!bridge.available) return languageList({ selected: ENGLISH.code, packs: [] });
    return languageList(await bridge.request('ocr.languages'));
  },
  async select(code) { return languageList(await bridge.request('ocr.select', { code })); },
  /** Full check of a pack before OCR uses it: { ready, reason: 'missing' | 'damaged' | null }. */
  async prepare(code) {
    if (code === ENGLISH.code || !bridge.available) return { ready: code === ENGLISH.code };
    return bridge.request('ocr.prepare', { code });
  },
  /** Resolves with { installed | cancelled, list }; throws with a message to show if it failed. */
  async download(code) {
    const result = await bridge.request('ocr.download', { code });
    return { ...result, list: languageList(result.list) };
  },
  cancel() { return bridge.request('ocr.cancelDownload'); },
  async remove(code) { return languageList(await bridge.request('ocr.remove', { code })); },
  /** fn({ code, received, total } | { code, verifying: true }); returns an unsubscribe function. */
  onProgress(fn) { return bridge.on('ocr-language-progress', fn); },
};
