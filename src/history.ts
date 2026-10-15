// Undo/redo history: a stack of whole-tree snapshots. Trees are small, so storing the
// serialized tree for each step is simpler and safer than recording inverse operations.

/**
 * What is selected, by position, so it survives re-parsing the tree: a node's depth-first
 * index, an exit's index, or for a leaf's connection to its exit, the leaf's node index.
 */
export type SelectionRef = { node: number } | { exit: number } | { link: number };

export interface Snapshot {
  text: string; // the tree in the save format
  sel: SelectionRef;
}

interface Entry {
  snap: Snapshot;
  label: string; // the action, e.g. "delete “Node 3”"
}

export class History {
  private undoStack: Entry[] = [];
  private redoStack: Entry[] = [];

  constructor(private limit = 200) {}

  /** Record that the action `label` changed the tree away from `before`. */
  push(before: Snapshot, label: string): void {
    this.undoStack.push({ snap: before, label });
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack = [];
  }

  /** Step back from `current`; returns the state to restore, or null if there is none. */
  undo(current: Snapshot): Entry | null {
    const entry = this.undoStack.pop();
    if (!entry) return null;
    this.redoStack.push({ snap: current, label: entry.label });
    return entry;
  }

  /** Step forward again from `current`; returns the state to restore, or null. */
  redo(current: Snapshot): Entry | null {
    const entry = this.redoStack.pop();
    if (!entry) return null;
    this.undoStack.push({ snap: current, label: entry.label });
    return entry;
  }

  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
  }

  /** Label of the action Undo would revert, or null. */
  get undoLabel(): string | null {
    return this.undoStack.at(-1)?.label ?? null;
  }

  /** Label of the action Redo would reapply, or null. */
  get redoLabel(): string | null {
    return this.redoStack.at(-1)?.label ?? null;
  }
}
