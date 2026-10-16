// Probability tree data model, independent of the UI.

let nextId = 1;

// Probabilities are shown to 4 decimal places of a percent (0.0001% = 1e-6). Siblings
// whose sum would display as 100% are considered complete.
export const SUM_TOLERANCE = 5e-7;

// Probabilities are stored to 12 decimal places: far finer than anything shown, but
// enough to drop floating-point noise like 0.30000000000000004 and stop it accumulating.
const PROB_DECIMALS = 1e12;

/** Clamp a probability into [0, 1] and round it to the stored precision. */
export function roundProb(p: number): number {
  return Math.round(Math.min(1, Math.max(0, p)) * PROB_DECIMALS) / PROB_DECIMALS;
}

/** A named outcome that any number of leaves can lead into. */
export class Exit {
  readonly id = nextId++;
  /** `color` is a "#rrggbb" chosen by the user, or null to use the automatic palette. */
  constructor(
    public label: string,
    public color: string | null = null,
  ) {}
}

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

/** A "#rrggbb" colour in lower case, or null if `v` isn't one. Colours end up in markup, so nothing else is accepted. */
export function parseColor(v: unknown): string | null {
  return typeof v === "string" && HEX_COLOR.test(v) ? v.toLowerCase() : null;
}

export class Node {
  readonly id = nextId++;
  children: Node[] = [];
  parent: Node | null = null;
  // A leaf either ends (at an exit, or at no exit) or continues at another node, which
  // turns the tree into a graph where several routes can merge. At most one is set.
  exit: Exit | null = null;
  next: Node | null = null;

  /** `prob` is the probability of taking the edge from the parent to this node (0..1). */
  constructor(
    public label: string,
    public prob = 1,
  ) {}

  get isRoot(): boolean {
    return this.parent === null;
  }

  get isLeaf(): boolean {
    return this.children.length === 0;
  }

  /** A leaf where runs end, as opposed to one that continues at another node. */
  get isOutcome(): boolean {
    return this.isLeaf && this.next === null;
  }

  /** Where a run goes from here: the children, or the node this leaf continues at. */
  get successors(): Node[] {
    return this.next ? [this.next] : this.children;
  }

  /** End this leaf at `ex` (null: at no exit). Ending somewhere replaces continuing. */
  setExit(ex: Exit | null): void {
    this.exit = ex;
    if (ex) this.next = null;
  }

  /** Continue this leaf at `target` (null: stop continuing). Replaces any exit. */
  setNext(target: Node | null): void {
    this.next = target;
    if (target) this.exit = null;
  }

  childrenSum(): number {
    return this.children.reduce((s, c) => s + c.prob, 0);
  }

  childrenComplete(): boolean {
    return this.isLeaf || Math.abs(this.childrenSum() - 1) <= SUM_TOLERANCE;
  }

  /** Probability mass not yet assigned to children. */
  remaining(): number {
    const r = roundProb(1 - this.childrenSum());
    return r <= SUM_TOLERANCE ? 0 : r;
  }

  addChild(label: string, prob: number): Node {
    // A node that branches onward no longer ends at an exit or continues elsewhere.
    this.exit = null;
    this.next = null;
    const child = new Node(label, prob);
    child.parent = this;
    this.children.push(child);
    return child;
  }

  remove(): void {
    if (this.parent === null) throw new Error("cannot remove the root node");
    const sibs = this.parent.children;
    sibs.splice(sibs.indexOf(this), 1);
    this.parent = null;
  }

  /** Scale children so their probabilities sum to 1 (equal split if all are 0). */
  normalizeChildren(): void {
    if (this.isLeaf) return;
    const total = this.childrenSum();
    for (const c of this.children) c.prob = roundProb(total > 0 ? c.prob / total : 1 / this.children.length);
  }

  /** Give every child the same probability. */
  splitChildrenEvenly(): void {
    for (const c of this.children) c.prob = roundProb(1 / this.children.length);
  }

  *walk(): Generator<Node> {
    yield this;
    for (const c of this.children) yield* c.walk();
  }

  leaves(): Node[] {
    return [...this.walk()].filter((n) => n.isLeaf);
  }

  pathLabels(): string[] {
    const labels: string[] = [];
    for (let n: Node | null = this; n !== null; n = n.parent) labels.push(n.label);
    return labels.reverse();
  }
}

// File format (version 3) is a flat list of nodes in depth-first order, each pointing
// at its parent's id, so the JSON stays shallow no matter how deep the tree grows:
//   {"version": 3, "exits": ["Win"], "nodes": [
//     {"id": 0, "label": "Start"},
//     {"id": 1, "parent": 0, "label": "A", "prob": 0.25, "exit": "Win"}, ...]}

export interface NodeRecord {
  id: number;
  parent?: number;
  label: string;
  prob?: number;
  exit?: string;
  next?: number; // id of the node this leaf continues at
}

/** An exit is saved as just its name, or as an object when it has a chosen colour. */
export type ExitRecord = string | { label: string; color: string };

export interface TreeRecord {
  version: 3;
  exits: ExitRecord[];
  nodes: NodeRecord[];
}

function exitFromRecord(v: unknown): Exit {
  if (isObject(v)) return new Exit(String(required(v, "label")), parseColor(v.color));
  return new Exit(String(v));
}

type Json = Record<string, unknown>;

function toInt(v: unknown, what: string): number {
  const n = typeof v === "string" ? Number(v.trim()) : v;
  if (typeof n !== "number" || !Number.isInteger(n)) throw new Error(`invalid ${what}: ${JSON.stringify(v)}`);
  return n;
}

function toFloat(v: unknown, what: string): number {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isFinite(n)) throw new Error(`invalid ${what}: ${JSON.stringify(v)}`);
  return n;
}

/** A probability read from a file: must be a number; clamped and rounded like any other. */
const toProb = (v: unknown) => roundProb(toFloat(v, "probability"));

function required(d: Json, key: string): unknown {
  if (!(key in d)) throw new Error(`missing "${key}" in ${JSON.stringify(d)}`);
  return d[key];
}

function isObject(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Chances and shape of the graph, worked out in one pass (see ProbabilityTree.analyze). */
export interface Analysis {
  chance: Map<Node, number>; // chance of reaching each node, over every route into it
  routes: Map<Node, number>; // how many distinct routes from the start reach each node
  depth: Map<Node, number>; // the longest route from the start, in steps: the node's column
  incoming: Map<Node, Node[]>; // the leaves that continue at each node
}

export class ProbabilityTree {
  constructor(
    public root: Node = new Node("Start"),
    public exits: Exit[] = [],
  ) {}

  addExit(label: string): Exit {
    const ex = new Exit(label);
    this.exits.push(ex);
    return ex;
  }

  findExit(label: string): Exit | undefined {
    return this.exits.find((e) => e.label === label);
  }

  removeExit(ex: Exit): void {
    for (const n of this.root.walk()) if (n.exit === ex) n.exit = null;
    this.exits.splice(this.exits.indexOf(ex), 1);
  }

  leavesOf(ex: Exit): Node[] {
    return this.root.leaves().filter((n) => n.exit === ex);
  }

  /** Combined probability of all paths that end in this exit. */
  exitProbability(ex: Exit, chance = this.analyze().chance): number {
    return this.leavesOf(ex).reduce((s, n) => s + chance.get(n)!, 0);
  }

  /** The leaves where runs end (not those that continue at another node). */
  outcomes(): Node[] {
    return this.root.leaves().filter((n) => n.isOutcome);
  }

  /** Outcome leaves that don't lead to any exit. */
  unassignedLeaves(): Node[] {
    return this.outcomes().filter((n) => n.exit === null);
  }

  /**
   * Work out every node's chance, route count and column in one pass, in graph order:
   * a node is visited once everything that leads into it has been. Throws if continue
   * links form a loop.
   */
  analyze(): Analysis {
    const nodes = [...this.root.walk()];
    const incoming = new Map(nodes.map((n): [Node, Node[]] => [n, []]));
    for (const n of nodes) if (n.next) incoming.get(n.next)?.push(n);
    const waiting = new Map(nodes.map((n) => [n, (n.parent ? 1 : 0) + incoming.get(n)!.length]));
    const chance = new Map(nodes.map((n) => [n, 0]));
    const routes = new Map(nodes.map((n) => [n, 0]));
    const depth = new Map(nodes.map((n) => [n, 0]));
    chance.set(this.root, 1);
    routes.set(this.root, 1);

    const ready = [this.root];
    let visited = 0;
    while (ready.length) {
      const n = ready.pop()!;
      visited++;
      for (const m of n.successors) {
        const share = n.next ? 1 : m.prob; // a continue link carries the whole chance
        chance.set(m, chance.get(m)! + chance.get(n)! * share);
        routes.set(m, routes.get(m)! + routes.get(n)!);
        depth.set(m, Math.max(depth.get(m)!, depth.get(n)! + 1));
        waiting.set(m, waiting.get(m)! - 1);
        if (waiting.get(m) === 0) ready.push(m);
      }
    }
    if (visited !== nodes.length) throw new Error("continue links form a loop");
    return { chance, routes, depth, incoming };
  }

  /** Why `leaf` can't continue at `target`, or null if it can. */
  continueProblem(leaf: Node, target: Node): string | null {
    if (!leaf.isLeaf) return `Only leaves can continue at another node; “${leaf.label}” has branches.`;
    if (target === leaf) return "A node can't continue at itself.";
    if (target.isRoot) return "Every run already starts at the start node, so nothing can continue there.";
    // Linking is only safe if the target can't lead back to the leaf.
    const seen = new Set<Node>();
    const stack = [target];
    while (stack.length) {
      const n = stack.pop()!;
      if (n === leaf) return `That would make a loop: “${target.label}” already leads to “${leaf.label}”.`;
      if (seen.has(n)) continue;
      seen.add(n);
      stack.push(...n.successors);
    }
    return null;
  }

  /** Remove `node` and its subtree; returns how many continue links into it were removed. */
  removeNode(node: Node): number {
    const gone = new Set(node.walk());
    let unlinked = 0;
    for (const n of this.root.walk()) {
      if (!gone.has(n) && n.next && gone.has(n.next)) {
        n.next = null;
        unlinked++;
      }
    }
    node.remove();
    return unlinked;
  }

  // --- serialization -------------------------------------------------------------

  toDict(): TreeRecord {
    const all = [...this.root.walk()];
    const ids = new Map(all.map((n, i) => [n, i]));
    const nodes = all.map((n, i): NodeRecord => {
      const d: NodeRecord =
        n.parent === null
          ? { id: i, label: n.label }
          : { id: i, parent: ids.get(n.parent)!, label: n.label, prob: n.prob };
      if (n.exit !== null && n.isLeaf) d.exit = n.exit.label;
      if (n.next !== null && n.isLeaf) d.next = ids.get(n.next)!;
      return d;
    });
    const exits = this.exits.map((e): ExitRecord => (e.color ? { label: e.label, color: e.color } : e.label));
    return { version: 3, exits, nodes };
  }

  static fromDict(data: unknown): ProbabilityTree {
    if (!isObject(data)) throw new Error("file does not contain a probability tree");
    if (!("nodes" in data)) return ProbabilityTree.fromNestedDict(data);
    const rawExits = data.exits ?? [];
    const rawNodes = data.nodes;
    if (!Array.isArray(rawExits) || !Array.isArray(rawNodes)) throw new Error('"exits" and "nodes" must be lists');

    const exits = rawExits.map(exitFromRecord);
    const byName = new Map(exits.map((e) => [e.label, e]));

    const records = rawNodes.map((d) => {
      if (!isObject(d)) throw new Error(`invalid node entry: ${JSON.stringify(d)}`);
      return d;
    });
    const nodes = new Map<number, Node>();
    for (const d of records) {
      const nid = toInt(required(d, "id"), "node id");
      if (nodes.has(nid)) throw new Error(`duplicate node id ${nid}`);
      nodes.set(nid, new Node(String(required(d, "label")), "prob" in d ? toProb(d.prob) : 1));
    }

    const roots: Node[] = [];
    for (const d of records) {
      // attach in file order so sibling order is preserved
      const node = nodes.get(toInt(d.id, "node id"))!;
      if (!("parent" in d)) {
        roots.push(node);
        continue;
      }
      const parent = nodes.get(toInt(d.parent, "parent id"));
      if (parent === undefined) throw new Error(`node ${d.id} refers to missing parent ${d.parent}`);
      node.parent = parent;
      parent.children.push(node);
    }
    if (roots.length !== 1) throw new Error(`expected exactly one root node, found ${roots.length}`);

    for (const d of records) {
      if (!("exit" in d)) continue;
      const name = String(d.exit);
      let ex = byName.get(name);
      if (ex === undefined) {
        ex = new Exit(name);
        byName.set(name, ex);
        exits.push(ex);
      }
      const node = nodes.get(toInt(d.id, "node id"))!;
      if (node.isLeaf) node.exit = ex;
    }

    for (const d of records) {
      if (!("next" in d)) continue;
      const node = nodes.get(toInt(d.id, "node id"))!;
      const target = nodes.get(toInt(d.next, "next node id"));
      if (target === undefined) throw new Error(`node ${d.id} continues at missing node ${d.next}`);
      if (!node.isLeaf) throw new Error(`node ${d.id} has branches, so it can't continue at another node`);
      if (node.exit) throw new Error(`node ${d.id} has both an exit and a node to continue at`);
      node.next = target;
    }

    const tree = new ProbabilityTree(roots[0], exits);
    tree.root.prob = 1;
    if (roots[0].next || [...nodes.values()].some((n) => n.next === roots[0])) {
      throw new Error("nothing can continue at the start node");
    }
    tree.analyze(); // throws if the continue links form a loop
    return tree;
  }

  /** Load the older nested formats (version 1: bare root node; version 2: exits + root). */
  private static fromNestedDict(data: Json): ProbabilityTree {
    if (!("root" in data)) data = { exits: [], root: data };
    const exits = ((data.exits ?? []) as unknown[]).map((label) => new Exit(String(label)));

    const build = (d: unknown, parent: Node | null): Node => {
      if (!isObject(d)) throw new Error(`invalid node entry: ${JSON.stringify(d)}`);
      const node = new Node(String(required(d, "label")), "prob" in d ? toProb(d.prob) : 1);
      node.parent = parent;
      node.children = ((d.children ?? []) as unknown[]).map((c) => build(c, node));
      if ("exit" in d && node.isLeaf) {
        const ex = exits[toInt(d.exit, "exit index")];
        if (ex === undefined) throw new Error(`exit index ${d.exit} is out of range`);
        node.exit = ex;
      }
      return node;
    };

    const tree = new ProbabilityTree(build(data.root, null), exits);
    tree.root.prob = 1;
    return tree;
  }
}

/** A float as Python's json.dumps writes it (whole numbers keep a ".0"). */
function pyFloat(x: number): string {
  return Number.isInteger(x) ? x.toFixed(1) : String(x);
}

/** Serialize a tree in the save format: one node per line, readable and diff-friendly. */
export function serializeTree(tree: ProbabilityTree): string {
  const data = tree.toDict();
  // Same separators as the Python writer (json.dumps), so files round-trip byte for byte.
  const lines = data.nodes.map((n) => {
    let line = `    {"id": ${n.id}`;
    if (n.parent !== undefined) line += `, "parent": ${n.parent}`;
    line += `, "label": ${JSON.stringify(n.label)}`;
    if (n.prob !== undefined) line += `, "prob": ${pyFloat(n.prob)}`;
    if (n.exit !== undefined) line += `, "exit": ${JSON.stringify(n.exit)}`;
    if (n.next !== undefined) line += `, "next": ${n.next}`;
    return line + "}";
  });
  const exitJson = (e: ExitRecord) =>
    typeof e === "string" ? JSON.stringify(e) : `{"label": ${JSON.stringify(e.label)}, "color": ${JSON.stringify(e.color)}}`;
  const exits = "[" + data.exits.map(exitJson).join(", ") + "]";
  return `{\n  "version": ${data.version},\n  "exits": ${exits},\n  "nodes": [\n${lines.join(",\n")}\n  ]\n}\n`;
}

export function parseTree(text: string): ProbabilityTree {
  return ProbabilityTree.fromDict(JSON.parse(text));
}

function parseFloatStrict(s: string): number {
  const t = s.trim();
  const v = Number(t);
  if (t === "" || Number.isNaN(v)) throw new Error(`could not read a number from "${s.trim()}"`);
  return v;
}

/**
 * Parse user input into a probability in [0, 1].
 * Accepts percentages ("25", "25%", "12.5") or fractions ("1/4").
 */
export function parseProbability(text: string): number {
  const s = text.trim().replace(/%+$/, "").trim();
  if (!s) throw new Error("probability is empty");
  let value: number;
  const slash = s.indexOf("/");
  if (slash >= 0) {
    const den = parseFloatStrict(s.slice(slash + 1));
    if (den === 0) throw new Error("division by zero");
    value = parseFloatStrict(s.slice(0, slash)) / den;
  } else {
    value = parseFloatStrict(s) / 100;
  }
  if (!(value >= 0 && value <= 1)) throw new Error("probability must be between 0% and 100%");
  return roundProb(value);
}

/** Format a probability as a percentage with up to 4 decimals, trailing zeros trimmed. */
export function fmtPct(p: number): string {
  return (p * 100).toFixed(4).replace(/0+$/, "").replace(/\.$/, "") + "%";
}

export interface SimulationResult {
  path: Node[]; // from the root to where the run ended
  stoppedEarly: boolean; // true if the run fell in the share a node's branches don't cover
  chance: number; // the chance of this particular route
}

/**
 * Simulate one event: start at the root and repeatedly take a branch at random, weighted
 * by its probability, until reaching an outcome leaf; leaves that continue at another
 * node carry on from there. If a node's branches add up to less than 100%, the run can
 * land in the missing share and stop there. `random` returns [0, 1).
 */
export function simulate(root: Node, random: () => number = Math.random): SimulationResult {
  const path = [root];
  let node = root;
  let chance = 1;
  while (!node.isOutcome) {
    // Loops are refused when links are made or files are opened; this is a last resort.
    if (path.length > 100000) throw new Error("simulation went around a loop");
    if (node.next) {
      node = node.next;
      path.push(node);
      continue;
    }
    const total = node.childrenSum();
    // Complete (or over-full) branches are scaled to their actual sum, so rounding
    // can't make a complete node stop early.
    let r = random() * (node.childrenComplete() || total > 1 ? total : 1);
    const next = node.children.find((c) => {
      if (r < c.prob) return true;
      r -= c.prob;
      return false;
    });
    if (next === undefined) return { path, stoppedEarly: true, chance: chance * Math.max(0, 1 - total) };
    chance *= next.prob;
    path.push(next);
    node = next;
  }
  return { path, stoppedEarly: false, chance };
}
