import { describe, expect, it } from "vitest";
import { History, type Snapshot } from "./history";

const snap = (text: string): Snapshot => ({ text, sel: { node: 0 } });

describe("History", () => {
  it("undoes and redoes in order", () => {
    const h = new History();
    h.push(snap("a"), "first");
    h.push(snap("b"), "second");
    expect(h.undoLabel).toBe("second");

    expect(h.undo(snap("c"))?.snap.text).toBe("b");
    expect(h.undo(snap("b"))?.snap.text).toBe("a");
    expect(h.undo(snap("a"))).toBeNull();
    expect(h.redoLabel).toBe("first");

    expect(h.redo(snap("a"))?.snap.text).toBe("b");
    expect(h.redo(snap("b"))?.snap.text).toBe("c");
    expect(h.redo(snap("c"))).toBeNull();
    expect(h.undoLabel).toBe("second");
  });

  it("drops the redo stack when a new action is recorded", () => {
    const h = new History();
    h.push(snap("a"), "first");
    h.undo(snap("b"));
    h.push(snap("a"), "other");
    expect(h.redoLabel).toBeNull();
    expect(h.undoLabel).toBe("other");
  });

  it("forgets the oldest steps beyond its limit", () => {
    const h = new History(2);
    h.push(snap("a"), "1");
    h.push(snap("b"), "2");
    h.push(snap("c"), "3");
    expect(h.undo(snap("d"))?.snap.text).toBe("c");
    expect(h.undo(snap("c"))?.snap.text).toBe("b");
    expect(h.undo(snap("b"))).toBeNull();
  });

  it("clears everything", () => {
    const h = new History();
    h.push(snap("a"), "first");
    h.undo(snap("b"));
    h.clear();
    expect(h.undoLabel).toBeNull();
    expect(h.redoLabel).toBeNull();
  });
});
