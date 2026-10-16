// Small modal dialogs built on <dialog>; each returns a promise of the user's answer.

import { fmtPct, parseColor, parseProbability, type Exit, type Node } from "./model";
import { esc } from "./render";

export const NO_EXIT = "(none)";

let openCount = 0;

/** True while any dialog is showing (keyboard shortcuts are ignored then). */
export function dialogOpen(): boolean {
  return openCount > 0;
}

/**
 * Show a dialog whose form body is `html`. `submit` validates and returns the result,
 * or throws an Error whose message is shown; cancelling resolves to null. `setup` can
 * attach extra behaviour to the dialog before it opens.
 */
function showDialog<T>(
  title: string,
  html: string,
  submit: (form: HTMLFormElement, button: string) => T,
  buttons: [string, string][] = [["cancel", "Cancel"], ["ok", "OK"]],
  setup?: (dlg: HTMLDialogElement) => void,
): Promise<T | null> {
  const dlg = document.createElement("dialog");
  dlg.innerHTML =
    `<form method="dialog"><h2>${esc(title)}</h2>${html}<p class="error" role="alert"></p>` +
    `<div class="buttons">${buttons
      .map(([value, text], i) => `<button value="${value}" class="${i === buttons.length - 1 ? "primary" : ""}"${value === "cancel" ? ' formnovalidate type="button" data-cancel' : ""}>${esc(text)}</button>`)
      .join("")}</div></form>`;
  document.body.append(dlg);
  openCount++;
  const form = dlg.querySelector("form")!;
  const error = dlg.querySelector<HTMLElement>(".error")!;
  setup?.(dlg);

  return new Promise<T | null>((resolve) => {
    const finish = (value: T | null) => {
      openCount--;
      dlg.close();
      dlg.remove();
      resolve(value);
    };
    dlg.querySelector("[data-cancel]")?.addEventListener("click", () => finish(null));
    dlg.addEventListener("cancel", (e) => {
      e.preventDefault();
      finish(null);
    });
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const button = (e.submitter as HTMLButtonElement | null)?.value ?? "ok";
      try {
        finish(submit(form, button));
      } catch (err) {
        error.textContent = (err as Error).message;
      }
    });
    dlg.showModal();
    const first = dlg.querySelector<HTMLInputElement>("[autofocus]") ?? dlg.querySelector<HTMLElement>("button.primary");
    first?.focus();
    if (first instanceof HTMLInputElement) first.select();
  });
}

export interface NodeEdit {
  label: string;
  prob: number;
  exitName: string | null;
}

/** Edit a node's label, branch probability and (for leaves) exit. */
export function editNode(node: Node, exits: Exit[], title: string): Promise<NodeEdit | null> {
  let hint: string;
  if (node.isRoot) {
    hint = "The entrance node is always reached (100%).";
  } else {
    const others = node.parent!.children.filter((c) => c !== node).reduce((s, c) => s + c.prob, 0);
    hint = `Percent (25 or 25%) or fraction (1/4). Siblings already use ${fmtPct(others)}; remaining: ${fmtPct(Math.max(0, 1 - others))}.`;
  }
  const pct = fmtPct(node.prob).replace(/%$/, "");
  let html =
    `<label>Label<input name="label" value="${esc(node.label)}" ${node.isRoot ? "autofocus" : ""} required></label>` +
    `<label>Probability<input name="prob" value="${node.isRoot ? "100" : esc(pct)}" ${node.isRoot ? "disabled" : "autofocus"} inputmode="decimal"></label>` +
    `<p class="hint">${esc(hint)}</p>`;
  if (node.isLeaf) {
    html +=
      `<label>Exit<input name="exit" list="exit-options" value="${esc(node.exit?.label ?? "")}" placeholder="${NO_EXIT}"></label>` +
      `<datalist id="exit-options">${exits.map((e) => `<option value="${esc(e.label)}">`).join("")}</datalist>` +
      `<p class="hint">Pick an exit, type a new name to create one, or leave empty for none.</p>`;
    if (node.next) {
      html += `<p class="hint">Continues at “${esc(node.next.label)}”. Choosing an exit replaces that.</p>`;
    }
  }
  return showDialog(title, html, (form) => {
    const data = new FormData(form);
    const label = String(data.get("label") ?? "").trim();
    if (!label) throw new Error("Label cannot be empty.");
    let prob = 1;
    if (!node.isRoot) {
      try {
        // Left as shown: keep the exact value instead of re-reading its rounded display.
        const text = String(data.get("prob") ?? "");
        prob = text.trim() === pct ? node.prob : parseProbability(text);
      } catch (err) {
        throw new Error(`Invalid probability: ${(err as Error).message}`);
      }
    }
    const exitName = String(data.get("exit") ?? "").trim();
    return { label, prob, exitName: exitName === "" || exitName === NO_EXIT ? null : exitName };
  });
}

export interface ExitEdit {
  label: string;
  color: string | null; // null: use the automatic colour
}

/**
 * Edit an exit's name and colour. `autoColor` is the colour it gets automatically;
 * `validate` may throw to reject the name.
 */
export function editExit(exit: Exit, autoColor: string, palette: string[], validate: (label: string) => void): Promise<ExitEdit | null> {
  const current = exit.color;
  const custom = current !== null && !palette.includes(current);
  const swatch = (value: string, color: string, title: string, checked: boolean) =>
    `<label class="swatch-option" title="${esc(title)}"><input type="radio" name="color" value="${value}"${checked ? " checked" : ""}>` +
    `<span style="--c:${color}"></span></label>`;
  const html =
    `<label>Name<input name="label" value="${esc(exit.label)}" autofocus required></label>` +
    `<fieldset class="colors"><legend>Color</legend><div class="swatches">` +
    swatch("auto", autoColor, "Automatic", current === null).replace("<span ", '<span class="auto" ') +
    palette.map((c) => swatch(c, c, c, current === c)).join("") +
    // A rainbow until a custom colour is picked, then that colour. The native picker sits
    // invisibly on top, so clicking the swatch opens it.
    `<label class="swatch-option custom" title="Custom color"><input type="radio" name="color" value="custom"${custom ? " checked" : ""}>` +
    `<span class="${custom ? "picked" : ""}" style="--c:${custom ? current : autoColor}"></span>` +
    `<input type="color" name="custom" value="${custom ? current : autoColor}" aria-label="Custom color"></label>` +
    `</div></fieldset>` +
    `<p class="hint">Automatic picks from the palette by the exit's position in the list.</p>`;
  const submit = (form: HTMLFormElement) => {
    const data = new FormData(form);
    const label = String(data.get("label") ?? "").trim();
    if (!label) throw new Error("Name cannot be empty.");
    validate(label);
    const choice = String(data.get("color") ?? "auto");
    const color = choice === "auto" ? null : choice === "custom" ? String(data.get("custom")) : choice;
    return { label, color: color === null ? null : parseColor(color) };
  };
  return showDialog("Edit exit", html, submit, undefined, (dlg) => {
    // Picking a custom colour selects the custom option and shows the colour.
    const picker = dlg.querySelector<HTMLInputElement>('input[type="color"]')!;
    picker.addEventListener("input", () => {
      dlg.querySelector<HTMLInputElement>('input[value="custom"]')!.checked = true;
      const shown = dlg.querySelector<HTMLElement>(".swatch-option.custom span")!;
      shown.classList.add("picked");
      shown.style.setProperty("--c", picker.value);
    });
  });
}

/** Ask for a line of text; `validate` may throw to reject it. */
export function promptText(title: string, message: string, initial: string, validate: (value: string) => void = () => {}): Promise<string | null> {
  const html = `<label>${esc(message)}<input name="value" value="${esc(initial)}" autofocus required></label>`;
  return showDialog(title, html, (form) => {
    const value = String(new FormData(form).get("value") ?? "").trim();
    if (!value) throw new Error("Name cannot be empty.");
    validate(value);
    return value;
  });
}

/** Ask a question; resolves to the value of the button pressed, or null if cancelled. */
export function confirmDialog(title: string, message: string, buttons: [string, string][]): Promise<string | null> {
  return showDialog(title, `<p>${esc(message)}</p>`, (_form, button) => button, buttons);
}

export function alertDialog(title: string, message: string): Promise<unknown> {
  return confirmDialog(title, message, [["ok", "OK"]]);
}
