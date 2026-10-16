import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ProbabilityTree, Node, fmtPct, parseProbability, parseTree, roundProb, serializeTree, simulate } from "./model";

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
    const { chance } = tree.analyze();
    const unassigned = tree.unassignedLeaves().reduce((s, n) => s + chance.get(n)!, 0);
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

describe("probability precision", () => {
  it("drops floating-point noise", () => {
    expect(roundProb(0.1 + 0.2)).toBe(0.3);
    expect(parseProbability("1/3")).toBe(0.333333333333);
    expect(roundProb(1.5)).toBe(1);
    expect(roundProb(-0.2)).toBe(0);
  });

  it("treats sums that display as 100% as complete", () => {
    const root = new Node("Start");
    for (let i = 0; i < 3; i++) root.addChild("Third", parseProbability("1/3"));
    expect(root.childrenComplete()).toBe(true);
    expect(root.remaining()).toBe(0);
    expect(fmtPct(root.childrenSum())).toBe("100%");

    const short = new Node("Start");
    short.addChild("A", parseProbability("99.9998"));
    expect(short.childrenComplete()).toBe(false);
  });

  it("splits and normalizes to stored precision", () => {
    const root = new Node("Start");
    for (let i = 0; i < 7; i++) root.addChild("Seventh", 0.1);
    root.splitChildrenEvenly();
    expect(root.children[0].prob).toBe(0.142857142857);
    expect(root.childrenComplete()).toBe(true);
    root.children[0].prob = 0.5;
    root.normalizeChildren();
    expect(root.childrenComplete()).toBe(true);
    for (const c of root.children) expect(c.prob).toBe(roundProb(c.prob));
  });

  it("cleans up long probabilities when loading", () => {
    const tree = ProbabilityTree.fromDict({
      nodes: [
        { id: 0, label: "Start" },
        { id: 1, parent: 0, label: "Left", prob: 0.3333335555557037 },
        { id: 2, parent: 0, label: "Right", prob: 0.6666664444442963 },
      ],
    });
    expect(tree.root.children.map((c) => c.prob)).toEqual([0.333333555556, 0.666666444444]);
    expect(tree.root.childrenComplete()).toBe(true);
    expect(serializeTree(tree)).toContain('"prob": 0.333333555556}');
  });

  it.each([1.5, -0.2])("clamps the out-of-range probability %d when loading", (prob) => {
    const tree = ProbabilityTree.fromDict({ nodes: [{ id: 0, label: "Start" }, { id: 1, parent: 0, label: "A", prob }] });
    expect(tree.root.children[0].prob).toBe(prob > 1 ? 1 : 0);
  });

  it("rejects non-numeric probabilities when loading", () => {
    expect(() => ProbabilityTree.fromDict({ nodes: [{ id: 0, label: "Start" }, { id: 1, parent: 0, label: "A", prob: "lots" }] })).toThrow(/probability/);
  });
});

describe("merging routes", () => {
  // Start ─50%─ A ─100%─ M ─┬─25%─ X
  //   └─50%─ B ─100%─ B2 ┄┄┘ └─75%─ Y      (B2 continues at M)
  const build = () => {
    const tree = new ProbabilityTree();
    const a = tree.root.addChild("A", 0.5);
    const b = tree.root.addChild("B", 0.5);
    const m = a.addChild("M", 1);
    const x = m.addChild("X", 0.25);
    const y = m.addChild("Y", 0.75);
    const b2 = b.addChild("B2", 1);
    b2.setNext(m);
    return { tree, a, b, m, x, y, b2 };
  };

  it("adds up the chance of every route into a node", () => {
    const { tree, m, x, y, b2 } = build();
    const { chance, routes, incoming } = tree.analyze();
    expect(chance.get(m)).toBeCloseTo(1, 12);
    expect(chance.get(x)).toBeCloseTo(0.25, 12);
    expect(chance.get(y)).toBeCloseTo(0.75, 12);
    expect(routes.get(m)).toBe(2);
    expect(routes.get(x)).toBe(2);
    expect(incoming.get(m)).toEqual([b2]);
    expect(tree.outcomes()).toEqual([x, y]); // B2 passes its chance on, so it isn't an outcome
  });

  it("places a merge node to the right of every route into it", () => {
    const { tree, a, m, b2 } = build();
    const { depth } = tree.analyze();
    expect(depth.get(a)).toBe(1);
    expect(depth.get(b2)).toBe(2);
    expect(depth.get(m)).toBe(3); // after B2, not just after A
  });

  it("counts exit chances through merges", () => {
    const { tree, x, y } = build();
    const win = tree.addExit("Win");
    x.setExit(win);
    y.setExit(win);
    expect(tree.exitProbability(win)).toBeCloseTo(1, 12);
  });

  it("explains why a link isn't allowed", () => {
    const { tree, a, b, m, x, b2 } = build();
    expect(tree.continueProblem(x, x)).toMatch(/itself/);
    expect(tree.continueProblem(x, tree.root)).toMatch(/start node/);
    expect(tree.continueProblem(b, m)).toMatch(/Only leaves/);
    expect(tree.continueProblem(x, a)).toMatch(/loop/); // A leads to M, which leads to X
    expect(tree.continueProblem(x, b2)).toMatch(/loop/); // B2 continues at M, which leads to X
    expect(tree.continueProblem(b2, x)).toBeNull();
  });

  it("keeps a leaf to one connection: an exit, a continue link, or new branches", () => {
    const { tree, m, b2 } = build();
    const win = tree.addExit("Win");
    b2.setExit(win);
    expect(b2.next).toBeNull();
    b2.setNext(m);
    expect(b2.exit).toBeNull();
    b2.addChild("More", 1);
    expect(b2.next).toBeNull();
  });

  it("removes continue links into a deleted branch", () => {
    const { tree, a, b2 } = build();
    expect(tree.removeNode(a)).toBe(1);
    expect(b2.next).toBeNull();
    expect(tree.outcomes().map((n) => n.label)).toEqual(["B2"]);
  });

  it("saves and loads continue links", () => {
    const { tree } = build();
    const text = serializeTree(tree);
    expect(text).toContain('{"id": 6, "parent": 5, "label": "B2", "prob": 1.0, "next": 2}');
    const back = parseTree(text);
    const b2 = [...back.root.walk()].find((n) => n.label === "B2")!;
    expect(b2.next?.label).toBe("M");
    expect(serializeTree(back)).toBe(text);
  });

  const nodes = (...extra: object[]) => ({
    nodes: [
      { id: 0, label: "Start" },
      { id: 1, parent: 0, label: "A", prob: 0.5 },
      { id: 2, parent: 0, label: "B", prob: 0.5 },
      ...extra,
    ],
  });
  it.each([
    [nodes({ id: 3, parent: 1, label: "C", prob: 1, next: 9 }), /missing node 9/],
    [nodes({ id: 3, parent: 1, label: "C", prob: 1, next: 0 }), /start node/],
    [{ nodes: [{ id: 0, label: "Start" }, { id: 1, parent: 0, label: "A", prob: 1, next: 2 }, { id: 2, parent: 0, label: "B", prob: 1, next: 1 }] }, /loop/],
    [nodes({ id: 3, parent: 1, label: "C", prob: 1, next: 2, exit: "Win" }), /both an exit/],
    [{ nodes: [{ id: 0, label: "Start" }, { id: 1, parent: 0, label: "A", prob: 1, next: 2 }, { id: 2, parent: 1, label: "B", prob: 1 }] }, /has branches/],
  ])("rejects a bad continue link %#", (data, message) => {
    expect(() => ProbabilityTree.fromDict(data)).toThrow(message);
  });

  it("simulates through a continue link", () => {
    const { tree } = build();
    // 0.9 → B (second half), 0.3 → B2 (its only branch), B2 continues at M, 0.5 → Y (after X's 25%).
    const rolls = [0.9, 0.3, 0.5];
    const r = simulate(tree.root, () => rolls.shift()!);
    expect(r.path.map((n) => n.label)).toEqual(["Start", "B", "B2", "M", "Y"]);
    expect(r.chance).toBeCloseTo(0.5 * 0.75, 12); // this route's chance, not Y's total
  });
});
