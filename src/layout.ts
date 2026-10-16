// Positions every node and exit in world coordinates (zoom is applied by the view).

import type { Analysis, ProbabilityTree, Exit, Node } from "./model";

export const NODE_W = 164;
export const NODE_H = 60;
export const COL_GAP = 110; // horizontal space between columns (room for edge labels)
export const ROW_GAP = 22; // vertical space between neighbouring leaves
export const EXIT_GAP = 40; // space between the last exit lane and the exit column
export const LANE_GAP = 16; // horizontal spacing between exit lanes
export const LANE_OFFSET = 28; // space between the last tree column and the first lane
export const MARGIN = 40;

export interface Point {
  x: number; // left edge
  y: number; // vertical centre
}

export interface Layout {
  pos: Map<Node | Exit, Point>;
  laneX: Map<Exit, number>; // x of each linked exit's vertical lane
  leafYs: Map<Exit, number[]>; // y of every leaf linked to each exit
  width: number;
  height: number;
}

/**
 * Rows follow the tree: leaves stack top to bottom and each parent sits midway between
 * its children. Columns follow the graph: a node's column is its longest route from the
 * start, so a node that other leaves continue at sits to the right of all of them.
 */
export function layoutTree(tree: ProbabilityTree, analysis: Analysis): Layout {
  const pos = new Map<Node | Exit, Point>();
  let nextY = MARGIN + NODE_H / 2;
  const maxDepth = Math.max(...analysis.depth.values());
  let bottom = 0;

  const place = (node: Node): number => {
    const x = MARGIN + analysis.depth.get(node)! * (NODE_W + COL_GAP);
    let y: number;
    if (node.isLeaf) {
      y = nextY;
      nextY += NODE_H + ROW_GAP;
    } else {
      const ys = node.children.map(place);
      y = (ys[0] + ys[ys.length - 1]) / 2;
    }
    pos.set(node, { x, y });
    bottom = Math.max(bottom, y);
    return y;
  };
  place(tree.root);

  // Exits sit in their own column to the right, each as close as possible to the
  // average height of the leaves feeding it, without overlapping one another.
  const lastColRight = MARGIN + maxDepth * (NODE_W + COL_GAP) + NODE_W;
  const leafYs = new Map<Exit, number[]>(tree.exits.map((e) => [e, []]));
  for (const leaf of tree.root.leaves()) {
    if (leaf.exit !== null) leafYs.get(leaf.exit)?.push(pos.get(leaf)!.y);
  }
  const wanted = new Map<Exit, number>();
  tree.exits.forEach((e, i) => {
    const ys = leafYs.get(e)!;
    wanted.set(e, ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : nextY + i);
  });
  let yMin = MARGIN + NODE_H / 2;
  const exitY = new Map<Exit, number>();
  for (const ex of [...tree.exits].sort((a, b) => wanted.get(a)! - wanted.get(b)!)) {
    const y = Math.max(wanted.get(ex)!, yMin);
    exitY.set(ex, y);
    yMin = y + NODE_H + ROW_GAP;
    bottom = Math.max(bottom, y);
  }

  // Each linked exit gets its own vertical lane that its leaves' links merge into.
  // A link's horizontal run crosses every lane to the left of its own, so lanes with
  // the shortest vertical span go leftmost, where they get in the fewest links' way.
  const span = (e: Exit) => {
    const ys = [...leafYs.get(e)!, exitY.get(e)!];
    return Math.max(...ys) - Math.min(...ys);
  };
  const linked = tree.exits.filter((e) => leafYs.get(e)!.length).sort((a, b) => span(a) - span(b));
  const lanesLeft = lastColRight + LANE_OFFSET;
  const laneX = new Map(linked.map((e, i) => [e, lanesLeft + i * LANE_GAP]));
  const exitX = lanesLeft + Math.max(linked.length - 1, 0) * LANE_GAP + EXIT_GAP;
  for (const [ex, y] of exitY) pos.set(ex, { x: exitX, y });

  const right = tree.exits.length ? exitX + NODE_W : lastColRight;
  // Extra room below the bottom row for the small captions under nodes.
  return { pos, laneX, leafYs, width: right + MARGIN, height: bottom + NODE_H / 2 + 16 + MARGIN };
}
