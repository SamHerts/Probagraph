import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ProbabilityTree, Node, fmtPct, parseProbability, parseTree, serializeTree, simulate } from "./model";

const repoFile = (name: string) => readFileSync(fileURLToPath(new URL(`../${name}`, import.meta.url)), "utf8");

describe("save files", () => {
  for (const name of ["examples/mars_lander.json"]) {
    it(`round-trips ${name} byte for byte`, () => {
      const text = repoFile(name);
      expect(serializeTree(parseTree(text))).toBe(text);
    });
  }

  it("computes the Mars lander outcomes", () => {
    const tree = parseTree(repoFile("examples/mars_lander.json"));
    const p = (label: string) => tree.exitProbability(tree.findExit(label)!);
    expect(tree.exits.map((e) => e.label)).toEqual(["Full Success", "Partial Success", "Postponed", "Mission Lost"]);
    expect(p("Full Success")).toBeCloseTo(0.7 * 0.9 * 0.85 * 0.8 + 0.2 * 0.6 * 0.5, 12);
    const total = tree.exits.reduce((s, e) => s + tree.exitProbability(e), 0);
    const unassigned = tree.unassignedLeaves().reduce((s, n) => s + n.cumulative, 0);
    expect(total + unassigned).toBeCloseTo(1, 12);
  });

  it("loads the nested version 2 format", () => {
    const tree = ProbabilityTree.fromDict({
      exits: ["Win"],
      root: {
        label: "Start",
        children: [
          { label: "A", prob: 0.25, exit: 0 },
          { label: "B", prob: 0.75 },
        ],
      },
    });
    expect(tree.root.children.map((c) => c.label)).toEqual(["A", "B"]);
    expect(tree.root.children[0].exit).toBe(tree.exits[0]);
  });

  it("loads the bare version 1 format", () => {
    const tree = ProbabilityTree.fromDict({ label: "Start", children: [{ label: "A", prob: 1 }] });
    expect(tree.exits).toEqual([]);
    expect(tree.root.leaves()[0].label).toBe("A");
  });

  it("creates exits that are only named on nodes", () => {
    const tree = ProbabilityTree.fromDict({
      nodes: [
        { id: 0, label: "Start" },
        { id: 1, parent: 0, label: "A", prob: 1, exit: "Surprise" },
      ],
    });
    expect(tree.exits.map((e) => e.label)).toEqual(["Surprise"]);
  });

  it.each([
    [{ nodes: [{ id: 0, label: "a" }, { id: 0, label: "b" }] }, /duplicate node id/],
    [{ nodes: [{ id: 0, label: "a" }, { id: 1, parent: 7, label: "b" }] }, /missing parent/],
    [{ nodes: [{ id: 0, label: "a" }, { id: 1, label: "b" }] }, /exactly one root/],
    [{ nodes: [{ id: 0 }] }, /missing "label"/],
    [[1, 2], /does not contain/],
  ])("rejects invalid data %#", (data, message) => {
    expect(() => ProbabilityTree.fromDict(data)).toThrow(message);
  });
});

describe("tree editing", () => {
  it("drops the exit of a leaf that gains a child", () => {
    const tree = new ProbabilityTree();
    const leaf = tree.root.addChild("A", 1);
    leaf.exit = tree.addExit("Win");
    leaf.addChild("B", 1);
    expect(leaf.exit).toBeNull();
    expect(tree.leavesOf(tree.exits[0])).toEqual([]);
  });

  it("normalizes children, splitting evenly when all are zero", () => {
    const root = new Node("Start");
    root.addChild("A", 0.2);
    root.addChild("B", 0.6);
    root.normalizeChildren();
    expect(root.children[0].prob).toBeCloseTo(0.25, 12);
    expect(root.children[1].prob).toBeCloseTo(0.75, 12);
    for (const c of root.children) c.prob = 0;
    root.normalizeChildren();
    expect(root.children.map((c) => c.prob)).toEqual([0.5, 0.5]);
  });

  it("tracks remaining probability and completeness", () => {
    const root = new Node("Start");
    root.addChild("A", 0.3);
    expect(root.remaining()).toBeCloseTo(0.7);
    expect(root.childrenComplete()).toBe(false);
    root.addChild("B", root.remaining());
    expect(root.childrenComplete()).toBe(true);
  });

  it("removes an exit and unlinks its leaves", () => {
    const tree = new ProbabilityTree();
    const ex = tree.addExit("Win");
    const leaf = tree.root.addChild("A", 1);
    leaf.exit = ex;
    tree.removeExit(ex);
    expect(tree.exits).toEqual([]);
    expect(leaf.exit).toBeNull();
  });
});

describe("probability input", () => {
  it.each([
    ["25", 0.25],
    ["25%", 0.25],
    [" 12.5 % ", 0.125],
    ["1/4", 0.25],
    ["0", 0],
    ["100", 1],
  ])("parses %j", (text, value) => {
    expect(parseProbability(text)).toBeCloseTo(value, 12);
  });

  it.each(["", "%", "abc", "1/0", "101", "-5", "3/2", "a/2"])("rejects %j", (text) => {
    expect(() => parseProbability(text)).toThrow();
  });

  it.each([
    [0.25, "25%"],
    [1, "100%"],
    [0, "0%"],
    [1 / 3, "33.3333%"],
    [0.12345678, "12.3457%"],
  ])("formats %d as %s", (p, text) => {
    expect(fmtPct(p)).toBe(text);
  });
});

describe("simulate", () => {
  const tree = () => {
    const root = new Node("Start");
    const a = root.addChild("A", 0.25);
    root.addChild("B", 0.75);
    a.addChild("A1", 0.5);
    a.addChild("A2", 0.5);
    return root;
  };
  const labels = (r: { path: Node[] }) => r.path.map((n) => n.label);

  it("picks branches by their probabilities", () => {
    // 0.1 → A (first 25%), then 0.6 → A2 (second half).
    const rolls = [0.1, 0.6];
    expect(labels(simulate(tree(), () => rolls.shift()!))).toEqual(["Start", "A", "A2"]);
    expect(labels(simulate(tree(), () => 0.25))).toEqual(["Start", "B"]);
    expect(labels(simulate(tree(), () => 0.999999))).toEqual(["Start", "B"]);
  });

  it("stops early when the roll lands in a node's missing share", () => {
    const root = new Node("Start");
    root.addChild("A", 0.6);
    expect(simulate(root, () => 0.5)).toMatchObject({ stoppedEarly: false });
    const r = simulate(root, () => 0.7);
    expect(r.stoppedEarly).toBe(true);
    expect(labels(r)).toEqual(["Start"]);
  });

  it("never takes a zero-probability branch", () => {
    const root = new Node("Start");
    root.addChild("Never", 0);
    root.addChild("Always", 1);
    expect(labels(simulate(root, () => 0))).toEqual(["Start", "Always"]);
  });

  it("scales over-full branches instead of favouring the first", () => {
    const root = new Node("Start");
    root.addChild("A", 1);
    root.addChild("B", 1);
    expect(labels(simulate(root, () => 0.75))).toEqual(["Start", "B"]);
  });

  it("matches the probabilities over many runs", () => {
    const root = tree();
    let seed = 1;
    const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
    const counts = new Map<string, number>();
    const n = 20000;
    for (let i = 0; i < n; i++) {
      const leaf = simulate(root, rand).path.at(-1)!.label;
      counts.set(leaf, (counts.get(leaf) ?? 0) + 1);
    }
    expect(counts.get("B")! / n).toBeCloseTo(0.75, 1);
    expect(counts.get("A1")! / n).toBeCloseTo(0.125, 1);
  });
});

describe("exit colours", () => {
  it("saves a chosen colour and loads it back", () => {
    const tree = new ProbabilityTree();
    tree.addExit("Win").color = "#16a34a";
    tree.addExit("Lose");
    const text = serializeTree(tree);
    expect(text).toContain('"exits": [{"label": "Win", "color": "#16a34a"}, "Lose"]');
    const back = parseTree(text);
    expect(back.exits.map((e) => [e.label, e.color])).toEqual([
      ["Win", "#16a34a"],
      ["Lose", null],
    ]);
    expect(serializeTree(back)).toBe(text);
  });

  it("links leaves to exits that have colours", () => {
    const tree = ProbabilityTree.fromDict({
      exits: [{ label: "Win", color: "#ABCDEF" }],
      nodes: [
        { id: 0, label: "Start" },
        { id: 1, parent: 0, label: "A", prob: 1, exit: "Win" },
      ],
    });
    expect(tree.root.children[0].exit).toBe(tree.exits[0]);
    expect(tree.exits[0].color).toBe("#abcdef");
  });

  it.each(["red", "#fff", "#12345g", '#000000" onclick="x', 42, null])("ignores the invalid colour %j", (color) => {
    const tree = ProbabilityTree.fromDict({ exits: [{ label: "Win", color }], nodes: [{ id: 0, label: "Start" }] });
    expect(tree.exits[0].color).toBeNull();
  });

  it("rejects an exit object without a label", () => {
    expect(() => ProbabilityTree.fromDict({ exits: [{ color: "#000000" }], nodes: [{ id: 0, label: "Start" }] })).toThrow(/label/);
  });
});
