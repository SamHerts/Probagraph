import { describe, expect, it } from "vitest";
import { NODE_W, layoutTree } from "./layout";
import { ProbabilityTree } from "./model";

describe("layout", () => {
  it("puts a node that leaves continue at to the right of those leaves", () => {
    const tree = new ProbabilityTree();
    const a = tree.root.addChild("A", 0.5);
    const deep = tree.root.addChild("B", 0.5).addChild("B2", 1).addChild("B3", 1);
    const merge = a.addChild("M", 1);
    deep.setNext(merge);
    const { pos } = layoutTree(tree, tree.analyze());
    expect(pos.get(merge)!.x).toBeGreaterThan(pos.get(deep)!.x + NODE_W);
    expect(pos.get(a)!.x).toBeLessThan(pos.get(merge)!.x);
  });
});
