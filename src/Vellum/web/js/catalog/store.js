// Recent and favourite tools, kept on this PC under one key (docs/TOOLS_UX_SPEC.md §10): tool ids and
// times only, never a file name or anything from a document. It reads and writes the storage it is
// given (localStorage in the app, a Map in tests), and every read and write is guarded: storage that
// fails, or holds something unreadable, counts as empty. A tool that no longer exists is dropped when
// read. Not `vellum.tools`: that key holds the annotation colours.

import { TOOLS } from './catalog.js';

export const STORE_KEY = 'vellum.catalog';
export const RECENT_LIMIT = 8;
export const FAVORITES_LIMIT = 12;

const EMPTY = Object.freeze({ recent: [], favorites: [] });

/** Recent and favourite tools over `storage` ({ getItem, setItem }), knowing the tools `ids`. */
export function createToolPrefs(storage, ids = TOOLS.map((t) => t.id)) {
  const known = new Set(ids);
  const read = () => {
    try {
      const data = JSON.parse(storage?.getItem(STORE_KEY) ?? 'null');
      if (data?.v !== 1) return EMPTY;
      const recent = (Array.isArray(data.recent) ? data.recent : []).filter((e) => known.has(e?.id) && Number.isFinite(e.t));
      const favorites = (Array.isArray(data.favorites) ? data.favorites : []).filter((id) => known.has(id));
      return { recent, favorites: [...new Set(favorites)] };
    } catch {
      return EMPTY;
    }
  };
  const write = ({ recent, favorites }) => {
    try { storage?.setItem(STORE_KEY, JSON.stringify({ v: 1, recent, favorites })); } catch { /* not kept this time */ }
  };
  return {
    /** Tool ids, most recently run first. */
    recent: () => read().recent.map((e) => e.id),
    /** Tool ids, in the order they were starred. */
    favorites: () => read().favorites,
    isFavorite: (id) => read().favorites.includes(id),
    /** Stars or unstars a tool: true when it is now a favourite, false when not, null when the list is full. */
    toggleFavorite(id) {
      if (!known.has(id)) return false;
      const data = read();
      if (data.favorites.includes(id)) {
        write({ ...data, favorites: data.favorites.filter((f) => f !== id) });
        return false;
      }
      if (data.favorites.length >= FAVORITES_LIMIT) return null;
      write({ ...data, favorites: [...data.favorites, id] });
      return true;
    },
    /** A tool was run: it goes to the front of Recent. */
    recordRun(id, t = Date.now()) {
      if (!known.has(id)) return;
      const data = read();
      write({ ...data, recent: [{ id, t }, ...data.recent.filter((e) => e.id !== id)].slice(0, RECENT_LIMIT) });
    },
    clearRecent() {
      write({ ...read(), recent: [] });
    },
  };
}
