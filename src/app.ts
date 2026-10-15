// Interactive editor for probability trees (growing left to right).

import { alertDialog, confirmDialog, dialogOpen, editExit, editNode, promptText } from "./dialogs";
import { History, type SelectionRef, type Snapshot } from "./history";
import { NODE_H, NODE_W, layoutTree, type Layout } from "./layout";
import { ProbabilityTree, Exit, Node, fmtPct, parseTree, serializeTree, simulate } from "./model";
import { openFile, saveFile, setWindowTitle, onCloseRequested, type FileRef } from "./platform";
import { EXIT_PALETTE, Link, esc, renderDragLine, renderScene, sameItem, type Item, type SimulationView } from "./render";
import exampleTree from "../examples/mars_lander.json?raw";

const MIN_ZOOM = 0.2;
const MAX_ZOOM = 3;
const SIM_STEP_MS = 450; // time the simulation spends on each node

type MenuEntry = { label: string; run: () => void; disabled?: boolean; checked?: boolean } | { heading: string } | "sep";

/** The colour an exit gets when none is chosen, from its position in the list. */
const autoColor = (index: number) => EXIT_PALETTE[index % EXIT_PALETTE.length];

const $ = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

export class App {
  tree = new ProbabilityTree();
  selected: Item = this.tree.root;
  layout!: Layout;
  items = new Map<number, Item>();
  exitColor = new Map<Exit, string>();
  file: FileRef | null = null;
  dirty = false;
  counter = 0;
  view = { x: 0, y: 0, k: 1 };

  private history = new History();
  private committed: Snapshot; // the tree as of the last recorded change, plus the current selection
  private savedText: string; // the tree as last saved or opened, to tell whether there are unsaved changes
  private sim: SimulationView | null = null; // the simulated run being shown, if any
  private simTimer: number | undefined;

  private canvas = $("#canvas");
  private svg = $<SVGSVGElement>("#svg");
  private viewport = $<SVGGElement>("#viewport");
  private scene = $<SVGGElement>("#scene");
  private overlay = $<SVGGElement>("#overlay");
  private menu = $("#menu");
  private status = $("#status");

  private pan: { x: number; y: number; vx: number; vy: number } | null = null;
  private drag: { leaf: Node; x: number; y: number; active: boolean } | null = null;
  private lastClick: { t: number; x: number; y: number; item: Item | null } | null = null;
  private pointers = new Map<number, { x: number; y: number }>(); // for two-finger pinch zoom
  private pinch: { d: number; x: number; y: number } | null = null;

  constructor() {
    this.bindToolbar();
    this.bindCanvas();
    this.bindPanel();
    this.bindKeys();
    void onCloseRequested(() => this.confirmDiscard(), () => this.dirty);
    this.committed = this.snapshot();
    this.savedText = this.committed.text;
    this.refresh();
  }

  // --- drawing -------------------------------------------------------------------

  refresh(): void {
    this.layout = layoutTree(this.tree);
    this.items.clear();
    for (const n of this.tree.root.walk()) this.items.set(n.id, n);
    for (const e of this.tree.exits) this.items.set(e.id, e);
    this.exitColor = new Map(this.tree.exits.map((e, i) => [e, e.color ?? autoColor(i)]));
    this.draw();
    this.updatePanel();
    this.updateTitle();
    this.updateHistoryButtons();
  }

  private updateHistoryButtons(): void {
    const [undo, redo] = [this.history.undoLabel, this.history.redoLabel];
    const undoBtn = $<HTMLButtonElement>('[data-action="undo"]');
    const redoBtn = $<HTMLButtonElement>('[data-action="redo"]');
    undoBtn.disabled = undo === null;
    redoBtn.disabled = redo === null;
    undoBtn.title = undo ? `Undo ${undo} (Ctrl+Z)` : "Nothing to undo";
    redoBtn.title = redo ? `Redo ${redo} (Ctrl+Shift+Z)` : "Nothing to redo";
  }

  private draw(): void {
    this.scene.innerHTML = renderScene({ tree: this.tree, layout: this.layout, selected: this.selected, exitColor: this.exitColor, sim: this.sim });
    this.svg.classList.toggle("simulating", this.sim !== null);
  }

  private applyView(animate = false): void {
    const { x, y, k } = this.view;
    this.viewport.classList.toggle("animate", animate);
    this.viewport.style.transform = `translate(${x}px, ${y}px) scale(${k})`;
    $("#zoom-level").textContent = `${Math.round(k * 100)}%`;
  }

  private updateTitle(): void {
    void setWindowTitle(`${this.dirty ? "*" : ""}${this.file?.name ?? "Untitled"} — Probagraph`);
  }

  private updatePanel(): void {
    const tree = this.tree;
    const sel = this.selected;
    const selLeaf = sel instanceof Link ? sel.leaf : sel;
    const unassigned = tree.unassignedLeaves();
    const unassignedP = unassigned.reduce((s, n) => s + n.cumulative, 0);

    // Stacked bar: how the total probability splits between the exits.
    const segments = tree.exits.map((e) => {
      const p = tree.exitProbability(e);
      return `<span style="flex-grow:${p};background:${this.exitColor.get(e)}" title="${esc(e.label)}: ${fmtPct(p)}"></span>`;
    });
    if (unassignedP > 0) segments.push(`<span class="none" style="flex-grow:${unassignedP}" title="No exit: ${fmtPct(unassignedP)}"></span>`);
    $("#dist").innerHTML = segments.join("");

    $("#exit-rows").innerHTML = tree.exits
      .map((e) => {
        const p = tree.exitProbability(e);
        return (
          `<tr data-id="${e.id}"${e === sel ? ' class="selected"' : ""}>` +
          `<td><span class="swatch" style="background:${this.exitColor.get(e)}"></span>${esc(e.label)}</td>` +
          `<td class="num">${tree.leavesOf(e).length}</td><td class="num">${fmtPct(p)}</td></tr>`
        );
      })
      .join("");
    const exitsTotal = tree.exits.reduce((s, e) => s + tree.exitProbability(e), 0);
    $("#exit-total").textContent = tree.exits.length
      ? `All exits: ${fmtPct(exitsTotal)} · no exit: ${fmtPct(unassignedP)} (${unassigned.length} ${unassigned.length === 1 ? "leaf" : "leaves"})`
      : "No exits yet: press X (or + Exit) to create one.";

    const leaves = tree.root.leaves();
    $("#leaf-rows").innerHTML = leaves
      .map((leaf) => {
        const ex = leaf.exit;
        const chip = ex ? `<span class="chip" style="--c:${this.exitColor.get(ex)}">${esc(ex.label)}</span>` : "";
        return (
          `<tr data-id="${leaf.id}"${leaf === selLeaf ? ' class="selected"' : ""}>` +
          `<td class="path"><div>${esc(leaf.label)}</div><div class="crumbs">${leaf.pathLabels().slice(0, -1).map(esc).join(" → ")}</div></td>` +
          `<td>${chip}</td><td class="num">${fmtPct(leaf.cumulative)}</td></tr>`
        );
      })
      .join("");
    const total = leaves.reduce((s, n) => s + n.cumulative, 0);
    $("#leaf-total").textContent = `${leaves.length} ${leaves.length === 1 ? "leaf" : "leaves"}, total = ${fmtPct(total)}`;
    document.querySelector("#leaf-rows tr.selected, #exit-rows tr.selected")?.scrollIntoView({ block: "nearest" });

    const warnings = [...tree.root.walk()].filter((n) => !n.childrenComplete());
    $("#warnings").innerHTML = warnings.length
      ? "<strong>Incomplete branching</strong> (leaf totals won't reach 100%):<ul>" +
        warnings.map((n) => `<li>“${esc(n.label)}”: branches sum to ${fmtPct(n.childrenSum())}</li>`).join("") +
        "</ul>"
      : "";

    let info: string;
    if (sel instanceof Exit) {
      const n = tree.leavesOf(sel).length;
      info = `Exit: ${sel.label} | combined P = ${fmtPct(tree.exitProbability(sel))} from ${n} path${n === 1 ? "" : "s"}`;
    } else if (sel instanceof Link) {
      info = `Connection: ${sel.leaf.label} → ${sel.leaf.exit?.label} | P = ${fmtPct(sel.leaf.cumulative)} | Delete removes it`;
    } else {
      info = sel.isRoot ? `${sel.label} (start)` : `${sel.pathLabels().join(" → ")} | Chance = ${fmtPct(sel.cumulative)}`;
      if (!sel.isRoot) info += ` | branch = ${fmtPct(sel.prob)}`;
      if (sel.exit !== null) info += ` | exit = ${sel.exit.label}`;
    }
    this.setStatus(info);
  }

  private setStatus(text: string, warn = false): void {
    this.status.textContent = text;
    this.status.classList.toggle("warn", warn);
  }

  // --- view ----------------------------------------------------------------------

  /** Zoom to `k`, keeping the screen point (cx, cy) fixed (default: canvas centre). */
  setZoom(k: number, cx?: number, cy?: number): void {
    const r = this.canvas.getBoundingClientRect();
    cx ??= r.width / 2;
    cy ??= r.height / 2;
    k = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, k));
    const { x, y, k: old } = this.view;
    this.view = { x: cx - ((cx - x) * k) / old, y: cy - ((cy - y) * k) / old, k };
    this.applyView();
  }

  /** Zoom so the whole tree (including exits) fits the canvas, and centre it. */
  zoomFit(): void {
    const r = this.canvas.getBoundingClientRect();
    if (r.width < 10 || r.height < 10) return;
    const { width, height } = this.layout;
    const k = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.min(r.width / width, r.height / height, 1.25)));
    this.view = { x: Math.max(0, (r.width - width * k) / 2), y: Math.max(0, (r.height - height * k) / 2), k };
    this.applyView(true);
  }

  private scrollIntoView(item: Item): void {
    const p = this.layout.pos.get(item instanceof Link ? item.leaf : item);
    if (!p) return;
    const r = this.canvas.getBoundingClientRect();
    const { x, y, k } = this.view;
    const left = x + p.x * k;
    const top = y + (p.y - NODE_H / 2) * k;
    const v = { ...this.view };
    if (left < 0 || left + NODE_W * k > r.width) v.x = r.width / 2 - (p.x + NODE_W / 2) * k;
    if (top < 0 || top + NODE_H * k > r.height) v.y = r.height / 2 - p.y * k;
    if (v.x !== x || v.y !== y) {
      this.view = v;
      this.applyView(true);
    }
  }

  private toWorld(clientX: number, clientY: number): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    const { x, y, k } = this.view;
    return { x: (clientX - r.left - x) / k, y: (clientY - r.top - y) / k };
  }

  // --- mouse ---------------------------------------------------------------------

  /** Distance between, and midpoint of, the two active touch points. */
  private pinchState(): { d: number; x: number; y: number } {
    const [a, b] = [...this.pointers.values()];
    return { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }

  private itemAt(el: Element | null): Item | null {
    const hit = el?.closest("[data-id], [data-link]");
    if (!hit) return null;
    const linkId = hit.getAttribute("data-link");
    if (linkId !== null) {
      const leaf = this.items.get(Number(linkId));
      return leaf instanceof Node && leaf.exit !== null ? new Link(leaf) : null;
    }
    return this.items.get(Number(hit.getAttribute("data-id"))) ?? null;
  }

  private bindCanvas(): void {
    const svg = this.svg;

    svg.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      this.hideMenu();
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      svg.setPointerCapture(e.pointerId);
      if (this.pointers.size === 2) {
        this.pan = this.drag = null;
        this.overlay.innerHTML = "";
        this.pinch = this.pinchState();
        return;
      }
      const item = this.itemAt(e.target as Element);
      // Our own double-click detection: the DOM is redrawn between the two clicks.
      const now = performance.now();
      const last = this.lastClick;
      const isDouble = last !== null && now - last.t < 400 && sameItem(last.item, item) && Math.hypot(e.clientX - last.x, e.clientY - last.y) < 6;
      this.lastClick = isDouble ? null : { t: now, x: e.clientX, y: e.clientY, item };
      if (isDouble) {
        if (item) void this.editSelected();
        else void this.addChild();
        return;
      }
      if (item) {
        this.select(item, false);
        if (item instanceof Node && item.isLeaf) this.drag = { leaf: item, x: e.clientX, y: e.clientY, active: false };
      } else {
        this.pan = { x: e.clientX, y: e.clientY, vx: this.view.x, vy: this.view.y };
        svg.classList.add("panning");
      }
    });

    svg.addEventListener("pointermove", (e) => {
      if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.pinch && this.pointers.size === 2) {
        const now = this.pinchState();
        const r = this.canvas.getBoundingClientRect();
        this.setZoom((this.view.k * now.d) / this.pinch.d, now.x - r.left, now.y - r.top);
        this.view.x += now.x - this.pinch.x;
        this.view.y += now.y - this.pinch.y;
        this.applyView();
        this.pinch = now;
        return;
      }
      if (this.pan) {
        this.view.x = this.pan.vx + e.clientX - this.pan.x;
        this.view.y = this.pan.vy + e.clientY - this.pan.y;
        this.applyView();
        return;
      }
      const d = this.drag;
      if (!d) return;
      if (!d.active && Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) < 6) return;
      d.active = true;
      const lp = this.layout.pos.get(d.leaf)!;
      const w = this.toWorld(e.clientX, e.clientY);
      this.overlay.innerHTML = renderDragLine(lp.x + NODE_W, lp.y, w.x, w.y);
      const target = this.itemAt(document.elementFromPoint(e.clientX, e.clientY));
      this.scene.querySelector(".drop-target")?.classList.remove("drop-target");
      if (target instanceof Exit) this.scene.querySelector(`[data-id="${target.id}"]`)?.classList.add("drop-target");
    });

    const endPointer = (e: PointerEvent) => {
      this.pointers.delete(e.pointerId);
      if (this.pointers.size < 2) this.pinch = null;
      this.pan = null;
      svg.classList.remove("panning");
      const d = this.drag;
      this.drag = null;
      if (!d?.active) return;
      this.overlay.innerHTML = "";
      const target = e.type === "pointerup" ? this.itemAt(document.elementFromPoint(e.clientX, e.clientY)) : null;
      if (target instanceof Exit) {
        this.linkExit(d.leaf, target);
      } else {
        this.draw();
        this.setStatus("Drop the link onto an exit node to connect this leaf to it.", true);
      }
    };
    svg.addEventListener("pointerup", endPointer);
    svg.addEventListener("pointercancel", endPointer);

    svg.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        this.hideMenu();
        const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
        if (e.ctrlKey || e.metaKey) {
          // Ctrl+wheel, or a trackpad pinch (which browsers report as Ctrl+wheel).
          const r = this.canvas.getBoundingClientRect();
          this.setZoom(this.view.k * Math.exp(-e.deltaY * unit * 0.002), e.clientX - r.left, e.clientY - r.top);
          return;
        }
        let dx = e.deltaX * unit;
        let dy = e.deltaY * unit;
        if (e.shiftKey && dx === 0) [dx, dy] = [dy, 0];
        this.view.x -= dx;
        this.view.y -= dy;
        this.applyView();
      },
      { passive: false },
    );

    svg.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      const item = this.itemAt(e.target as Element);
      if (!item) return;
      this.select(item, false);
      this.showMenu(e.clientX, e.clientY, this.menuFor(item));
    });

    window.addEventListener("resize", () => this.hideMenu());
    window.addEventListener("blur", () => this.hideMenu());
    document.addEventListener("pointerdown", (e) => {
      if (!this.menu.contains(e.target as globalThis.Node)) this.hideMenu();
    });
  }

  private menuFor(item: Item): MenuEntry[] {
    if (item instanceof Link) {
      return [
        { label: "Remove connection", run: () => void this.deleteSelected() },
        { label: "Select leaf", run: () => this.select(item.leaf) },
        { label: "Select exit", run: () => item.leaf.exit && this.select(item.leaf.exit) },
      ];
    }
    if (item instanceof Exit) {
      return [
        { label: "Edit exit…", run: () => void this.editSelected() },
        { label: "Delete exit", run: () => void this.deleteSelected() },
      ];
    }
    const entries: MenuEntry[] = [
      { label: "Add child", run: () => void this.addChild() },
      { label: "Add sibling", run: () => void this.addSibling(), disabled: item.isRoot },
      { label: "Edit…", run: () => void this.editSelected() },
    ];
    if (item.isLeaf) {
      entries.push("sep", { heading: "Send to exit" });
      for (const ex of this.tree.exits) entries.push({ label: ex.label, run: () => this.linkExit(item, ex), checked: item.exit === ex });
      entries.push({ label: "New exit…", run: () => void this.addExit() });
      entries.push({ label: "No exit", run: () => this.linkExit(item, null), disabled: item.exit === null });
    }
    entries.push(
      "sep",
      { label: "Split children evenly", run: () => this.splitEvenly() },
      { label: "Normalize children to 100%", run: () => this.normalize() },
      "sep",
      { label: "Delete", run: () => void this.deleteSelected(), disabled: item.isRoot },
    );
    return entries;
  }

  private showMenu(x: number, y: number, entries: MenuEntry[]): void {
    const m = this.menu;
    m.replaceChildren();
    for (const entry of entries) {
      if (entry === "sep") {
        m.append(document.createElement("hr"));
      } else if ("heading" in entry) {
        m.append(Object.assign(document.createElement("div"), { className: "heading", textContent: entry.heading }));
      } else {
        const b = Object.assign(document.createElement("button"), { textContent: entry.label, disabled: !!entry.disabled });
        if (entry.checked) b.classList.add("checked");
        b.addEventListener("click", () => {
          this.hideMenu();
          entry.run();
        });
        m.append(b);
      }
    }
    m.hidden = false;
    const r = m.getBoundingClientRect();
    m.style.left = `${Math.min(x, window.innerWidth - r.width - 4)}px`;
    m.style.top = `${Math.min(y, window.innerHeight - r.height - 4)}px`;
    m.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }

  private hideMenu(): void {
    this.menu.hidden = true;
  }

  // --- toolbar, side panel and keys ----------------------------------------------

  private bindToolbar(): void {
    const actions: Record<string, () => unknown> = {
      new: () => this.newTree(),
      open: () => this.openTree(),
      example: () => this.openExample(),
      save: () => this.save(),
      saveAs: () => this.save(true),
      undo: () => this.undo(),
      redo: () => this.redo(),
      addChild: () => this.addChild(),
      addSibling: () => this.addSibling(),
      addExit: () => this.addExit(),
      edit: () => this.editSelected(),
      delete: () => this.deleteSelected(),
      simulate: () => this.runSimulation(),
      split: () => this.splitEvenly(),
      normalize: () => this.normalize(),
      zoomOut: () => this.setZoom(this.view.k / 1.2),
      zoomReset: () => this.setZoom(1),
      zoomIn: () => this.setZoom(this.view.k * 1.2),
      fit: () => this.zoomFit(),
    };
    for (const b of document.querySelectorAll<HTMLButtonElement>("[data-action]")) {
      b.addEventListener("click", () => void actions[b.dataset.action!]?.());
    }
  }

  private bindPanel(): void {
    for (const sel of ["#exit-rows", "#leaf-rows"]) {
      $(sel).addEventListener("click", (e) => {
        const item = this.itemAt(e.target as Element);
        if (item && item !== this.selected) this.select(item);
      });
    }
    // Drag the splitter to resize the side panel.
    const splitter = $("#splitter");
    const panel = $(".panel");
    splitter.addEventListener("pointerdown", (e) => {
      splitter.setPointerCapture(e.pointerId);
      const startX = e.clientX;
      const startW = panel.getBoundingClientRect().width;
      const move = (ev: PointerEvent) => {
        panel.style.width = `${Math.min(window.innerWidth * 0.7, Math.max(240, startW - (ev.clientX - startX)))}px`;
      };
      splitter.addEventListener("pointermove", move);
      splitter.addEventListener("pointerup", () => splitter.removeEventListener("pointermove", move), { once: true });
    });
  }

  private bindKeys(): void {
    window.addEventListener("keydown", (e) => {
      if (dialogOpen() || e.altKey) return;
      const t = e.target as HTMLElement;
      if (t.closest("input, textarea, select, [contenteditable]")) return;
      if (e.key === "Escape") {
        this.hideMenu();
        return this.stopSimulation();
      }
      if (!this.menu.hidden) return; // let the menu's buttons take Enter etc.
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      const run: (() => unknown) | undefined = mod
        ? {
            s: () => this.save(e.shiftKey),
            z: () => (e.shiftKey ? this.redo() : this.undo()),
            y: () => this.redo(),
            o: () => this.openTree(),
            n: () => this.newTree(),
            "=": () => this.setZoom(this.view.k * 1.2),
            "+": () => this.setZoom(this.view.k * 1.2),
            "-": () => this.setZoom(this.view.k / 1.2),
            "0": () => this.setZoom(1),
          }[key]
        : {
            a: () => this.addChild(),
            Tab: () => this.addChild(),
            s: () => this.addSibling(),
            x: () => this.addExit(),
            Enter: () => this.editSelected(),
            F2: () => this.editSelected(),
            Delete: () => this.deleteSelected(),
            Backspace: () => this.deleteSelected(),
            ArrowLeft: () => this.navigate("parent"),
            ArrowRight: () => this.navigate("child"),
            ArrowUp: () => this.navigate("prev"),
            ArrowDown: () => this.navigate("next"),
            f: () => this.zoomFit(),
            r: () => this.runSimulation(),
          }[key];
      if (!run) return;
      e.preventDefault();
      // Keep focus off toolbar buttons, so Enter edits instead of re-clicking them.
      (document.activeElement as HTMLElement | null)?.blur?.();
      void run();
    });
  }

  // --- actions -------------------------------------------------------------------

  select(item: Item, scroll = true): void {
    if (sameItem(item, this.selected)) return;
    this.stopSimulation(false);
    this.selected = item;
    this.committed.sel = this.selectionRef();
    this.draw();
    this.updatePanel();
    if (scroll) this.scrollIntoView(item);
  }

  /** Call after every edit to the tree: records it for undo, then redraws. */
  private changed(label: string): void {
    this.stopSimulation(false);
    const now = this.snapshot();
    if (now.text !== this.committed.text) this.history.push(this.committed, label);
    this.committed = now;
    this.dirty = now.text !== this.savedText;
    this.refresh();
    this.scrollIntoView(this.selected);
  }

  // --- undo ----------------------------------------------------------------------

  private selectionRef(): SelectionRef {
    const sel = this.selected;
    if (sel instanceof Exit) return { exit: this.tree.exits.indexOf(sel) };
    if (sel instanceof Link) return { link: [...this.tree.root.walk()].indexOf(sel.leaf) };
    return { node: [...this.tree.root.walk()].indexOf(sel) };
  }

  private snapshot(): Snapshot {
    return { text: serializeTree(this.tree), sel: this.selectionRef() };
  }

  private restore(snap: Snapshot): void {
    this.stopSimulation(false);
    this.tree = parseTree(snap.text);
    const sel = snap.sel;
    const nodes = [...this.tree.root.walk()];
    let item: Item | undefined;
    if ("exit" in sel) item = this.tree.exits[sel.exit];
    else if ("link" in sel) {
      const leaf = nodes[sel.link];
      item = leaf?.exit ? new Link(leaf) : leaf;
    } else item = nodes[sel.node];
    this.selected = item ?? this.tree.root;
    this.committed = { text: snap.text, sel: this.selectionRef() };
    this.dirty = snap.text !== this.savedText;
    this.refresh();
    this.scrollIntoView(this.selected);
  }

  undo(): void {
    const entry = this.history.undo(this.snapshot());
    if (!entry) return this.setStatus("Nothing to undo.");
    this.restore(entry.snap);
    this.setStatus(`Undid ${entry.label}.`);
  }

  redo(): void {
    const entry = this.history.redo(this.snapshot());
    if (!entry) return this.setStatus("Nothing to redo.");
    this.restore(entry.snap);
    this.setStatus(`Redid ${entry.label}.`);
  }

  private newLabel(): string {
    return `Node ${++this.counter}`;
  }

  private resolveExit(name: string | null): Exit | null {
    if (name === null) return null;
    return this.tree.findExit(name) ?? this.tree.addExit(name);
  }

  private selectedNode(action: string): Node | null {
    if (this.selected instanceof Exit) {
      this.setStatus(`Select a tree node (not an exit) to ${action}.`, true);
      return null;
    }
    return this.selected instanceof Link ? this.selected.leaf : this.selected;
  }

  private async addUnder(parent: Node): Promise<void> {
    const oldExit = parent.exit;
    const child = parent.addChild(this.newLabel(), parent.remaining());
    this.selected = child;
    this.refresh();
    this.scrollIntoView(child);
    const result = await editNode(child, this.tree.exits, "New branch");
    if (result === null) {
      // cancelled: undo the add
      child.remove();
      parent.exit = oldExit;
      this.counter--;
      this.selected = parent;
      this.refresh();
      return;
    }
    child.label = result.label;
    child.prob = result.prob;
    child.exit = this.resolveExit(result.exitName);
    this.changed(`add “${child.label}”`);
    if (oldExit !== null) {
      this.setStatus(`“${parent.label}” now branches onward, so it no longer leads to exit “${oldExit.label}”.`, true);
    }
  }

  async addChild(): Promise<void> {
    const node = this.selectedNode("add a child");
    if (node) await this.addUnder(node);
  }

  async addSibling(): Promise<void> {
    const node = this.selectedNode("add a sibling");
    if (node) await this.addUnder(node.parent ?? node);
  }

  async addExit(): Promise<void> {
    const sel = this.selected instanceof Link ? this.selected.leaf : this.selected;
    const leaf = sel instanceof Node && sel.isLeaf ? sel : null;
    const name = await promptText(
      "New exit",
      leaf ? `Exit name (“${leaf.label}” will lead to it)` : "Exit name",
      `Exit ${this.tree.exits.length + 1}`,
      (v) => {
        if (this.tree.findExit(v)) throw new Error(`An exit named “${v}” already exists.`);
      },
    );
    if (name === null) return;
    const ex = this.tree.addExit(name);
    if (leaf) leaf.exit = ex;
    else this.selected = ex;
    this.changed(`add exit “${name}”`);
  }

  linkExit(leaf: Node, ex: Exit | null): void {
    const old = leaf.exit;
    leaf.exit = ex;
    this.changed(ex ? `link “${leaf.label}” to “${ex.label}”` : `remove connection “${leaf.label}” → “${old?.label}”`);
  }

  async editSelected(): Promise<void> {
    const sel = this.selected;
    const item = sel instanceof Link ? sel.leaf : sel; // a connection is edited through its leaf
    if (item !== sel) this.select(item);
    if (item instanceof Exit) {
      const auto = autoColor(this.tree.exits.indexOf(item));
      const result = await editExit(item, auto, EXIT_PALETTE, (v) => {
        if (v !== item.label && this.tree.findExit(v)) throw new Error(`An exit named “${v}” already exists.`);
      });
      if (result === null) return;
      const old = item.label;
      item.label = result.label;
      item.color = result.color;
      this.changed(`edit exit “${old}”`); // records nothing if neither the name nor the colour changed
      return;
    }
    const result = await editNode(item, this.tree.exits, "Edit node");
    if (result === null) return;
    item.label = result.label;
    item.prob = result.prob;
    if (item.isLeaf) item.exit = this.resolveExit(result.exitName);
    this.changed(`edit “${item.label}”`);
  }

  async deleteSelected(): Promise<void> {
    const item = this.selected;
    if (item instanceof Link) {
      // Remove just this connection; the leaf stays, now without an exit.
      this.selected = item.leaf;
      this.linkExit(item.leaf, null);
      return;
    }
    if (item instanceof Exit) {
      const n = this.tree.leavesOf(item).length;
      if (n) {
        const msg = `Delete exit “${item.label}”? ${n} ${n === 1 ? "leaf" : "leaves"} will be unlinked.`;
        if ((await confirmDialog("Delete exit", msg, [["cancel", "Cancel"], ["yes", "Delete"]])) !== "yes") return;
      }
      this.tree.removeExit(item);
      this.selected = this.tree.root;
      this.changed(`delete exit “${item.label}”`);
      return;
    }
    if (item.isRoot) {
      this.setStatus("The entrance node can't be deleted (use New to start over).", true);
      return;
    }
    if (!item.isLeaf) {
      const n = [...item.walk()].length - 1;
      const msg = `Delete “${item.label}” and its ${n} descendant node${n === 1 ? "" : "s"}?`;
      if ((await confirmDialog("Delete branch", msg, [["cancel", "Cancel"], ["yes", "Delete"]])) !== "yes") return;
    }
    const parent = item.parent!;
    item.remove();
    this.selected = parent;
    this.changed(`delete “${item.label}”`);
  }

  /** Operate on the selected node's children, or on its siblings if it's a leaf. */
  private targetForChildrenOp(): Node | null {
    const n = this.selectedNode("change branch probabilities");
    if (n === null) return null;
    const target = n.isLeaf && n.parent !== null ? n.parent : n;
    return target.isLeaf ? null : target;
  }

  splitEvenly(): void {
    const target = this.targetForChildrenOp();
    if (!target) return;
    target.splitChildrenEvenly();
    this.changed(`split “${target.label}” evenly`);
  }

  normalize(): void {
    const target = this.targetForChildrenOp();
    if (!target) return;
    target.normalizeChildren();
    this.changed(`normalize “${target.label}”`);
  }

  navigate(where: "parent" | "child" | "prev" | "next"): void {
    const s = this.selected;
    if (s instanceof Link) {
      if (where === "parent") this.select(s.leaf);
      else if (where === "child" && s.leaf.exit) this.select(s.leaf.exit);
      return;
    }
    if (s instanceof Exit) {
      const exits = [...this.tree.exits].sort((a, b) => this.layout.pos.get(a)!.y - this.layout.pos.get(b)!.y);
      const leaves = this.tree.leavesOf(s);
      if (where === "parent" && leaves.length) this.select(leaves[0]);
      else if (where === "prev" || where === "next") {
        const next = exits[exits.indexOf(s) + (where === "prev" ? -1 : 1)];
        if (next) this.select(next);
      }
      return;
    }
    if (where === "parent" && s.parent) this.select(s.parent);
    else if (where === "child") {
      if (s.children.length) this.select(s.children[s.children.length >> 1]);
      else if (s.exit) this.select(s.exit);
    } else if ((where === "prev" || where === "next") && s.parent) {
      const sibs = s.parent.children;
      const next = sibs[sibs.indexOf(s) + (where === "prev" ? -1 : 1)];
      if (next) this.select(next);
    }
  }

  // --- simulation ----------------------------------------------------------------

  /** Simulate one event: walk from the root, picking branches by probability, and show it. */
  runSimulation(): void {
    this.stopSimulation(false);
    const { path, stoppedEarly } = simulate(this.tree.root);
    const leaf = path[path.length - 1];
    const exit = !stoppedEarly && leaf.isLeaf ? leaf.exit : null;
    const labels = path.map((n) => n.label);

    const finish = () => {
      this.sim = { path: new Set(path), current: leaf, exit };
      this.draw();
      this.scrollIntoView(exit ?? leaf);
      let text = `Simulated: ${labels.join(" → ")}`;
      if (stoppedEarly) {
        const covered = leaf.childrenSum();
        text += `, then stopped: “${leaf.label}”'s branches only cover ${fmtPct(covered)} and this run fell in the other ${fmtPct(1 - covered)}`;
      } else {
        text += exit ? ` → exit “${exit.label}”` : " (no exit)";
        text += ` | chance of this path: ${fmtPct(leaf.cumulative)}`;
      }
      this.setStatus(text + " | R to run again, Esc to clear");
    };

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return finish();
    // Step along the path one node at a time, then light up the exit.
    let i = 0;
    const step = () => {
      if (i === path.length) return finish();
      const node = path[i++];
      this.sim = { path: new Set(path.slice(0, i)), current: node, exit: null };
      this.draw();
      this.scrollIntoView(node);
      this.setStatus(`Simulating… ${labels.slice(0, i).join(" → ")}`);
      this.simTimer = window.setTimeout(step, SIM_STEP_MS);
    };
    step();
  }

  /** Clear any simulated run; `redraw` is false when the caller redraws anyway. */
  stopSimulation(redraw = true): void {
    window.clearTimeout(this.simTimer);
    if (this.sim === null) return;
    this.sim = null;
    if (redraw) {
      this.draw();
      this.updatePanel();
    }
  }

  // --- files ---------------------------------------------------------------------

  /** Offer to save unsaved changes; resolves to false if the user cancels. */
  async confirmDiscard(): Promise<boolean> {
    if (!this.dirty) return true;
    const answer = await confirmDialog("Unsaved changes", `Save changes to “${this.file?.name ?? "Untitled"}” first?`, [
      ["cancel", "Cancel"],
      ["discard", "Don't save"],
      ["save", "Save"],
    ]);
    if (answer === "save") return this.save();
    return answer === "discard";
  }

  private load(tree: ProbabilityTree, file: FileRef | null): void {
    this.stopSimulation(false);
    this.tree = tree;
    this.selected = tree.root;
    this.file = file;
    this.dirty = false;
    this.counter = [...tree.root.walk()].length - 1;
    this.history.clear();
    this.committed = this.snapshot();
    this.savedText = this.committed.text;
    this.refresh();
    this.zoomFit();
  }

  async newTree(): Promise<void> {
    if (!(await this.confirmDiscard())) return;
    this.load(new ProbabilityTree(), null);
    this.view = { x: 0, y: 0, k: 1 };
    this.applyView(true);
  }

  async openTree(): Promise<void> {
    if (!(await this.confirmDiscard())) return;
    try {
      const result = await openFile();
      if (result) this.load(parseTree(result.text), result.ref);
    } catch (err) {
      await alertDialog("Open failed", String((err as Error).message ?? err));
    }
  }

  async save(saveAs = false): Promise<boolean> {
    try {
      const text = serializeTree(this.tree);
      const ref = await saveFile(text, this.file, saveAs);
      if (ref === null) return false;
      this.file = ref;
      this.savedText = text;
    } catch (err) {
      await alertDialog("Save failed", String((err as Error).message ?? err));
      return false;
    }
    this.dirty = false;
    this.updateTitle();
    this.setStatus(`Saved ${this.file.name}.`);
    return true;
  }

  async openExample(): Promise<void> {
    if (!(await this.confirmDiscard())) return;
    this.load(parseTree(exampleTree), { name: "mars_lander.json" });
  }
}
