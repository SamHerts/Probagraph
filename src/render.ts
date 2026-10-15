// Builds the SVG markup for the tree. Everything is redrawn from scratch on each change,
// which is plenty fast for trees of a few hundred nodes and keeps the code simple.

import { NODE_H, NODE_W, type Layout } from "./layout";
import { Exit, fmtPct, type ProbabilityTree, type Node } from "./model";

// One colour per exit (cycled if there are more exits than colours); mid-tones that
// read on both the light and the dark theme.
export const EXIT_PALETTE = ["#8b5cf6", "#16a34a", "#e11d48", "#2563eb", "#d97706", "#db2777", "#0d9488", "#ea580c"];

export const FONT_FAMILY = 'system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans", Ubuntu, sans-serif';

/** The connection from a leaf to its exit (a leaf has at most one, so the leaf identifies it). */
export class Link {
  constructor(readonly leaf: Node) {}
}

export type Item = Node | Exit | Link;

/** Links are recreated on every click, so compare them by leaf. */
export function sameItem(a: Item | null, b: Item | null): boolean {
  if (a instanceof Link && b instanceof Link) return a.leaf === b.leaf;
  return a === b;
}

/** A simulated run being shown: the nodes it has reached so far, and its exit once it gets there. */
export interface SimulationView {
  path: Set<Node>;
  current: Node; // the node the run has just reached
  exit: Exit | null; // set once the run reaches a linked leaf
}

export interface Scene {
  tree: ProbabilityTree;
  layout: Layout;
  selected: Item;
  exitColor: Map<Exit, string>;
  sim: SimulationView | null;
}

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

const measureCtx = document.createElement("canvas").getContext("2d")!;

function textWidth(text: string, size: number, weight = 400): number {
  measureCtx.font = `${weight} ${size}px ${FONT_FAMILY}`;
  return measureCtx.measureText(text).width;
}

/** Shorten text with an ellipsis so it fits in maxWidth. */
function clip(text: string, maxWidth: number, size: number, weight = 400): string {
  if (textWidth(text, size, weight) <= maxWidth) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (textWidth(text.slice(0, mid) + "…", size, weight) <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo).trimEnd() + "…";
}

const f = (n: number) => Math.round(n * 100) / 100;

/** Rounded elbow: right from (x0, y0) to the lane, along the lane to y1, right to x1. */
function elbowPath(x0: number, y0: number, lane: number, y1: number, x1: number, r: number): string {
  if (Math.abs(y1 - y0) < 0.5) return `M${f(x0)},${f(y0)}H${f(x1)}`;
  r = Math.min(r, Math.abs(y1 - y0) / 2, lane - x0, x1 - lane);
  const sy = y1 > y0 ? 1 : -1;
  return (
    `M${f(x0)},${f(y0)}H${f(lane - r)}Q${f(lane)},${f(y0)} ${f(lane)},${f(y0 + sy * r)}` +
    `V${f(y1 - sy * r)}Q${f(lane)},${f(y1)} ${f(lane + r)},${f(y1)}H${f(x1)}`
  );
}

function arrowHead(x: number, y: number, size: number): string {
  return `M${f(x)},${f(y)}L${f(x - size)},${f(y - size * 0.45)}L${f(x - size)},${f(y + size * 0.45)}Z`;
}

/** Exit (or none) that should stay highlighted while others fade. */
export function focusExit(selected: Item): Exit | null {
  if (selected instanceof Exit) return selected;
  if (selected instanceof Link) return selected.leaf.exit;
  return selected.isLeaf ? selected.exit : null;
}

export function renderScene(s: Scene): string {
  const { tree, layout, selected, exitColor, sim } = s;
  const pos = layout.pos;
  const focus = focusExit(selected);
  const out: string[] = [];

  // Exit links first, then branch edges, so nodes are drawn on top of both.
  const links = tree.root.leaves().filter((n) => n.exit !== null);
  const selLeaf = selected instanceof Link ? selected.leaf : selected;
  const rank = (n: Node) => (n.exit === focus ? 2 : 0) + (n === selLeaf ? 1 : 0);
  links.sort((a, b) => rank(a) - rank(b)); // focused links on top
  out.push('<g class="links">');
  for (const leaf of links) {
    const ex = leaf.exit!;
    const lp = pos.get(leaf)!;
    const ep = pos.get(ex)!;
    const faded = focus !== null && ex !== focus ? " faded" : "";
    const isSelected = selected instanceof Link && selected.leaf === leaf;
    const strong = isSelected || leaf === selected || selected === ex;
    const head = strong ? 12 : 10;
    const d = elbowPath(lp.x + NODE_W, lp.y, layout.laneX.get(ex)!, ep.y, ep.x - head + 1, 10);
    // An invisible wide stroke under the wire makes it easy to click.
    out.push(
      `<g class="link${faded}${isSelected ? " selected" : ""}${sim?.exit === ex && sim.path.has(leaf) ? " sim" : ""}" data-link="${leaf.id}" style="--c:${exitColor.get(ex)}">` +
        `<title>${esc(leaf.label)} → ${esc(ex.label)}</title>` +
        `<path class="hit" d="${d}"/>` +
        `<path class="wire" d="${d}" stroke-width="${strong ? 3.5 : 2}"/>` +
        `<path class="head" d="${arrowHead(ep.x, ep.y, head)}"/></g>`,
    );
  }
  // Junction dots where a link joins the middle of its exit's lane.
  for (const [ex, lane] of layout.laneX) {
    const ys = [...layout.leafYs.get(ex)!, pos.get(ex)!.y];
    const lo = Math.min(...ys);
    const hi = Math.max(...ys);
    const faded = focus !== null && ex !== focus ? " faded" : "";
    for (const y of ys) {
      if (lo < y && y < hi) {
        out.push(`<circle class="junction${faded}" style="--c:${exitColor.get(ex)}" cx="${f(lane)}" cy="${f(y)}" r="3.5"/>`);
      }
    }
  }
  out.push("</g>");

  // Branch edges, thicker the likelier the path, with a probability pill at the child end.
  out.push('<g class="edges">');
  for (const node of tree.root.walk()) {
    const p = pos.get(node)!;
    for (const child of node.children) {
      const c = pos.get(child)!;
      const x0 = p.x + NODE_W;
      const mx = (x0 + c.x) / 2;
      const w = 1.5 + 3.5 * child.cumulative;
      out.push(`<path class="edge${sim?.path.has(child) ? " sim" : ""}" d="M${f(x0)},${f(p.y)}C${f(mx)},${f(p.y)} ${f(mx)},${f(c.y)} ${f(c.x)},${f(c.y)}" stroke-width="${f(w)}"/>`);
    }
  }
  for (const node of tree.root.walk()) {
    for (const child of node.children) {
      const c = pos.get(child)!;
      const label = fmtPct(child.prob);
      const pw = textWidth(label, 11, 600) + 12;
      const right = c.x - 6;
      const top = c.y - 6 - 18;
      out.push(
        `<g class="pill${sim?.path.has(child) ? " sim" : ""}" data-id="${child.id}"><rect x="${f(right - pw)}" y="${f(top)}" width="${f(pw)}" height="18" rx="9"/>` +
          `<text x="${f(right - pw / 2)}" y="${f(top + 9)}">${esc(label)}</text></g>`,
      );
    }
  }
  out.push("</g>");

  out.push('<g class="nodes">');
  for (const node of tree.root.walk()) out.push(renderNode(node, pos.get(node)!, selected, exitColor, sim));
  for (const ex of tree.exits) out.push(renderExit(tree, ex, pos.get(ex)!, selected, exitColor.get(ex)!, sim));
  out.push("</g>");
  return out.join("");
}

/** Simulation classes: "sim" for everything on the run's path, "sim-now" for where it is. */
function simClass(sim: SimulationView | null, onPath: boolean, isNow: boolean): string {
  if (!sim || !onPath) return "";
  return isNow ? "sim sim-now" : "sim";
}

function renderNode(node: Node, p: { x: number; y: number }, selected: Item, exitColor: Map<Exit, string>, sim: SimulationView | null): string {
  const kind = node.isRoot ? "root" : node.isLeaf ? "leaf" : "inner";
  const incomplete = !node.childrenComplete();
  const onPath = sim?.path.has(node) ?? false;
  const isNow = sim?.current === node && sim.exit === null;
  const cls = ["node", kind, node === selected ? "selected" : "", incomplete ? "incomplete" : "", simClass(sim, onPath, isNow)].join(" ");
  const cum = node.cumulative;
  const color = node.exit !== null && node.isLeaf ? exitColor.get(node.exit)! : null;
  const barW = NODE_W - 24 - (color ? 6 : 0);
  const parts = [
    `<g class="${cls}" data-id="${node.id}" transform="translate(${f(p.x)},${f(p.y - NODE_H / 2)})"${color ? ` style="--c:${color}"` : ""}>`,
    `<title>${esc(node.pathLabels().join(" → "))}</title>`,
    `<rect class="halo" x="-5" y="-5" width="${NODE_W + 10}" height="${NODE_H + 10}" rx="15"/>`,
    `<rect class="card" width="${NODE_W}" height="${NODE_H}" rx="10"/>`,
  ];
  if (color) parts.push(`<rect class="stripe" x="${NODE_W - 9}" y="8" width="5" height="${NODE_H - 16}" rx="2.5"/>`);
  parts.push(
    `<text class="label" x="12" y="21">${esc(clip(node.label, NODE_W - 24 - (color ? 6 : 0), 13, 600))}</text>`,
    `<text class="reach" x="12" y="39"><tspan class="dim">P(reach) </tspan>${fmtPct(cum)}</text>`,
    `<rect class="bar-track" x="12" y="${NODE_H - 12}" width="${barW}" height="4" rx="2"/>`,
    `<rect class="bar" x="12" y="${NODE_H - 12}" width="${f(Math.max(cum * barW, cum > 0 ? 2 : 0))}" height="4" rx="2"/>`,
  );
  if (incomplete) {
    parts.push(`<text class="caption warn" x="${NODE_W}" y="${NODE_H + 14}">branches sum to ${fmtPct(node.childrenSum())}</text>`);
  }
  parts.push("</g>");
  return parts.join("");
}

function renderExit(tree: ProbabilityTree, ex: Exit, p: { x: number; y: number }, selected: Item, color: string, sim: SimulationView | null): string {
  const n = tree.leavesOf(ex).length;
  const cls = ["exit", ex === selected ? "selected" : "", n ? "" : "unlinked", simClass(sim, sim?.exit === ex, true)].join(" ");
  return (
    `<g class="${cls}" data-id="${ex.id}" transform="translate(${f(p.x)},${f(p.y - NODE_H / 2)})" style="--c:${color}">` +
    `<title>${esc(ex.label)}</title>` +
    `<rect class="halo" x="-5" y="-5" width="${NODE_W + 10}" height="${NODE_H + 10}" rx="${NODE_H / 2 + 5}"/>` +
    `<rect class="card" width="${NODE_W}" height="${NODE_H}" rx="${NODE_H / 2}"/>` +
    `<rect class="tint" width="${NODE_W}" height="${NODE_H}" rx="${NODE_H / 2}"/>` +
    `<circle class="dot" cx="22" cy="${NODE_H / 2}" r="6"/>` +
    `<text class="label" x="36" y="23">${esc(clip(ex.label, NODE_W - 36 - 18, 13, 600))}</text>` +
    `<text class="prob" x="36" y="43">${fmtPct(tree.exitProbability(ex))}</text>` +
    `<text class="caption" x="${NODE_W - 8}" y="${NODE_H + 14}">${n} path${n === 1 ? "" : "s"}</text>` +
    "</g>"
  );
}

/** Dashed line shown while dragging a leaf towards an exit. */
export function renderDragLine(x0: number, y0: number, x1: number, y1: number): string {
  const mx = (x0 + x1) / 2;
  return `<path class="dragline" d="M${f(x0)},${f(y0)}C${f(mx)},${f(y0)} ${f(mx)},${f(y1)} ${f(x1)},${f(y1)}"/>`;
}
