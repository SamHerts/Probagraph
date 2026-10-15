// Keeps a copy of the open tree in the browser's local storage, so a refresh, crash or
// closed tab doesn't lose work. It lives only in this browser; it is a safety net, not
// a replacement for saving the file.

const KEY = "probagraph.autosave.v1";

export interface Backup {
  text: string; // the tree in the save format
  savedText: string; // the tree as last saved, to tell whether there were unsaved changes
  name: string | null; // the file's name, if it has one
}

/** Storage, or null where it's unavailable (some private windows, blocked site data). */
function defaultStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function loadBackup(storage = defaultStorage()): Backup | null {
  try {
    const data: unknown = JSON.parse(storage?.getItem(KEY) ?? "null");
    if (typeof data !== "object" || data === null) return null;
    const { text, savedText, name } = data as Record<string, unknown>;
    if (typeof text !== "string" || typeof savedText !== "string") return null;
    return { text, savedText, name: typeof name === "string" ? name : null };
  } catch {
    return null;
  }
}

export function storeBackup(backup: Backup, storage = defaultStorage()): void {
  try {
    storage?.setItem(KEY, JSON.stringify(backup));
  } catch {
    // Full or blocked: nothing more we can do, and the page still works without it.
  }
}
