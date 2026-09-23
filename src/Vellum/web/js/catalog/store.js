// Recent and favourite tools, kept on this PC under one key (docs/TOOLS_UX_SPEC.md §10): tool ids and
// times only, never a file name or anything from a document. It reads and writes the storage it is
// given (localStorage in the app, a Map in tests), and every read and write is guarded: storage that
// fails, or holds something unreadable, counts as empty. A tool that no longer exists is dropped when
// read, as are repeats and anything past the limits. Not `vellum.tools`: that key holds the annotation
// colours. Nothing here runs on its own: it reads when asked and writes when a tool is run or starred.

import { HOME_TOOLS, TOOLS, toolCommands } from './catalog.js';

export const STORE_KEY = 'vellum.catalog';
export const RECENT_LIMIT = 8;
export const FAVORITES_LIMIT = 12;
export const HOME_LIMIT = 4;

const EMPTY = Object.freeze({ recent: [], favorites: [] });

/**
 * Recent and favourite tools over `storage` ({ getItem, setItem }), knowing the catalog's `tools`.
 * onChange(): called after each write (a run recorded, a star, Recent cleared), and at no other time.
 */
export function createToolPrefs(storage, { tools = TOOLS, onChange = null } = {}) {
  const byId = new Map(tools.map((t) => [t.id, t]));
  // Command id → the tool that runs it (its own command or a variant's): what the palette and Home record.
  const byCommand = new Map();
  for (const t of tools) for (const id of toolCommands(t)) if (!byCommand.has(id)) byCommand.set(id, t.id);

  const read = () => {
    try {
      const data = JSON.parse(storage?.getItem(STORE_KEY) ?? 'null');
      if (data?.v !== 1) return EMPTY;
      const seen = new Set();
      const recent = (Array.isArray(data.recent) ? data.recent : [])
        .filter((e) => byId.has(e?.id) && Number.isFinite(e.t) && !seen.has(e.id) && seen.add(e.id))
        .slice(0, RECENT_LIMIT)
        .map(({ id, t }) => ({ id, t }));
      const favorites = [...new Set((Array.isArray(data.favorites) ? data.favorites : []).filter((id) => byId.has(id)))]
        .slice(0, FAVORITES_LIMIT);
      return { recent, favorites };
    } catch {
      return EMPTY;
    }
  };
  const write = ({ recent, favorites }) => {
    try { storage?.setItem(STORE_KEY, JSON.stringify({ v: 1, recent, favorites })); } catch { /* not kept this time */ }
    try { onChange?.(); } catch { /* a listener's failure is its own */ }
  };
  const recordRun = (id, t = Date.now()) => {
    if (!byId.has(id)) return;
    const data = read();
    write({ ...data, recent: [{ id, t }, ...data.recent.filter((e) => e.id !== id)].slice(0, RECENT_LIMIT) });
  };

  return {
    /** Tool ids, most recently run first. */
    recent: () => read().recent.map((e) => e.id),
    /** Tool ids, in the order they were starred. */
    favorites: () => read().favorites,
    isFavorite: (id) => read().favorites.includes(id),
    /** Stars or unstars a tool: true when it is now a favourite, false when not, null when the list is full. */
    toggleFavorite(id) {
      if (!byId.has(id)) return false;
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
    recordRun,
    /** A command was run (from the palette, say): if a tool runs it, that tool goes to the front of Recent. */
    recordCommand(commandId, t = Date.now()) {
      const id = byCommand.get(commandId);
      if (id) recordRun(id, t);
    },
    clearRecent() {
      write({ ...read(), recent: [] });
    },
    /**
     * The Home row (§8): the tools `fits` allows (those that need no document), recently run ones first,
     * then HOME_TOOLS, each once, at most `limit`. Tool records, from the catalog.
     */
    homeTools(fits, limit = HOME_LIMIT) {
      const ids = new Set([...read().recent.map((e) => e.id), ...HOME_TOOLS]);
      return [...ids].map((id) => byId.get(id)).filter((t) => t && fits(t)).slice(0, limit);
    },
  };
}
