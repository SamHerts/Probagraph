import { describe, expect, it } from "vitest";
import { loadBackup, storeBackup } from "./autosave";

function fakeStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (k) => data.get(k) ?? null,
    key: (i) => [...data.keys()][i] ?? null,
    removeItem: (k) => void data.delete(k),
    setItem: (k, v) => void data.set(k, String(v)),
  };
}

describe("autosave", () => {
  it("stores and restores a backup", () => {
    const storage = fakeStorage();
    expect(loadBackup(storage)).toBeNull();
    storeBackup({ text: "tree", savedText: "old", name: "plan.json" }, storage);
    expect(loadBackup(storage)).toEqual({ text: "tree", savedText: "old", name: "plan.json" });
  });

  it("ignores missing or damaged data", () => {
    const storage = fakeStorage();
    storage.setItem("probagraph.autosave.v1", "{not json");
    expect(loadBackup(storage)).toBeNull();
    storage.setItem("probagraph.autosave.v1", JSON.stringify({ text: 5 }));
    expect(loadBackup(storage)).toBeNull();
    expect(loadBackup(null)).toBeNull();
  });

  it("keeps working when storage throws", () => {
    const broken = { ...fakeStorage(), getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("full"); } };
    expect(() => storeBackup({ text: "t", savedText: "t", name: null }, broken)).not.toThrow();
    expect(loadBackup(broken)).toBeNull();
  });
});
