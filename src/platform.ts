// Everything that differs between the desktop (Tauri) and browser builds lives here.

export const isTauri = "__TAURI_INTERNALS__" in window;

/** Where an open document lives, so Save can write back to it. */
export interface FileRef {
  name: string;
  path?: string; // desktop
  handle?: FileSystemFileHandleLike; // browsers with the File System Access API
}

// The File System Access API (Chromium browsers) isn't in TypeScript's DOM types yet.
interface FileSystemFileHandleLike {
  name: string;
  getFile(): Promise<File>;
  createWritable(): Promise<{ write(data: string): Promise<void>; close(): Promise<void> }>;
}
interface PickerWindow {
  showOpenFilePicker?(opts: object): Promise<FileSystemFileHandleLike[]>;
  showSaveFilePicker?(opts: object): Promise<FileSystemFileHandleLike>;
}
const picker = window as unknown as PickerWindow;

const JSON_FILTER = { name: "Probagraph tree", extensions: ["json"] };
const PICKER_TYPES = { types: [{ description: "Probagraph tree", accept: { "application/json": [".json"] } }] };

const baseName = (path: string) => path.split(/[\\/]/).pop() ?? path;

function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

/** Ask the user for a file to open. Resolves to null if they cancel. */
export async function openFile(): Promise<{ ref: FileRef; text: string } | null> {
  if (isTauri) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const { readTextFile } = await import("@tauri-apps/plugin-fs");
    const path = await open({ filters: [JSON_FILTER, { name: "All files", extensions: ["*"] }] });
    if (typeof path !== "string") return null;
    return { ref: { name: baseName(path), path }, text: await readTextFile(path) };
  }
  if (picker.showOpenFilePicker) {
    try {
      const [handle] = await picker.showOpenFilePicker(PICKER_TYPES);
      return { ref: { name: handle.name, handle }, text: await (await handle.getFile()).text() };
    } catch (err) {
      if (isAbort(err)) return null;
      throw err;
    }
  }
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,application/json";
    input.addEventListener("change", async () => {
      const file = input.files?.[0];
      resolve(file ? { ref: { name: file.name }, text: await file.text() } : null);
    });
    input.addEventListener("cancel", () => resolve(null));
    input.click();
  });
}

/**
 * Write `text` to `ref`, or ask where to save it when `ref` has nowhere to write to
 * (or `saveAs` is set). Resolves to the saved location, or null if cancelled.
 */
export async function saveFile(text: string, ref: FileRef | null, saveAs: boolean): Promise<FileRef | null> {
  const suggested = ref?.name ?? "untitled.json";
  if (isTauri) {
    const { writeTextFile } = await import("@tauri-apps/plugin-fs");
    let path = saveAs ? undefined : ref?.path;
    if (path === undefined) {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const chosen = await save({ defaultPath: suggested, filters: [JSON_FILTER] });
      if (!chosen) return null;
      path = /\.[^\\/.]+$/.test(chosen) ? chosen : chosen + ".json";
    }
    await writeTextFile(path, text);
    return { name: baseName(path), path };
  }
  if (picker.showSaveFilePicker) {
    let handle = saveAs ? undefined : ref?.handle;
    try {
      handle ??= await picker.showSaveFilePicker({ ...PICKER_TYPES, suggestedName: suggested });
    } catch (err) {
      if (isAbort(err)) return null;
      throw err;
    }
    const w = await handle.createWritable();
    await w.write(text);
    await w.close();
    return { name: handle.name, handle };
  }
  // No way to write files directly: download a copy instead.
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: suggested });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return { name: suggested };
}

export async function setWindowTitle(title: string): Promise<void> {
  document.title = title;
  if (isTauri) {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().setTitle(title);
  }
}

/** Run `canClose` before the window/tab closes; it resolves to false to keep it open. */
export async function onCloseRequested(canClose: () => Promise<boolean>, isDirty: () => boolean): Promise<void> {
  if (isTauri) {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().onCloseRequested(async (event) => {
      if (!(await canClose())) event.preventDefault();
    });
  } else {
    // Browsers only allow their own generic "leave site?" prompt here.
    window.addEventListener("beforeunload", (e) => {
      if (isDirty()) e.preventDefault();
    });
  }
}
