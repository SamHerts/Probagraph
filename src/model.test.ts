import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ProbabilityTree, Node, fmtPct, parseProbability, parseTree, serializeTree } from "./model";

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
