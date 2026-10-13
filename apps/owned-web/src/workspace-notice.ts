// Owned, non-blocking notice when a conversation's saved sandbox files could not be restored
// (or could not be saved before an idle stop). Rendered outside the upstream T3 tree.
import type { Conversation } from "./adapter.ts";

const TYPES = [
  "workspace.saved",
  "workspace.save_failed",
  "workspace.restored",
  "workspace.restore_failed",
];

/** The latest persistence problem worth showing, or null. */
export function workspaceProblem(c: Conversation): { seq: number; text: string } | null {
  const last = c.events.filter((e) => TYPES.includes(e.type)).at(-1);
  if (!last) return null;
  if (last.type === "workspace.restore_failed")
    return {
      seq: last.seq,
      text: "This sandbox started without the files saved from its last session. The saved copy is kept.",
    };
  if (last.type === "workspace.save_failed" && last.data.stoppedAnyway === true)
    return {
      seq: last.seq,
      text: "The sandbox was stopped after its files could not be saved; they will be missing next time.",
    };
  return null;
}

export function syncWorkspaceNotice(c: Conversation, doc: Document = document) {
  const id = `owned-workspace-${c.id}`.replace(/[^a-zA-Z0-9_-]/g, "_");
  const problem = workspaceProblem(c);
  const existing = doc.getElementById(id);
  const dismissed = (() => {
    try {
      return localStorage.getItem(id) === String(problem?.seq);
    } catch {
      return false;
    }
  })();
  if (!problem || dismissed) return existing?.remove();
  if (existing?.dataset.seq === String(problem.seq)) return;
  existing?.remove();
  const box = doc.createElement("div"),
    text = doc.createElement("span"),
    close = doc.createElement("button");
  box.id = id;
  box.dataset.seq = String(problem.seq);
  box.setAttribute("role", "status");
  box.style.cssText =
    "position:fixed;left:50%;transform:translateX(-50%);top:12px;z-index:2147483646;max-width:520px;padding:10px 14px;border-radius:10px;background:#1f1f23;color:#f5f5f5;border:1px solid #f59e0b;font:13px/1.4 system-ui,sans-serif;display:flex;gap:10px;align-items:center";
  text.textContent = problem.text;
  close.type = "button";
  close.textContent = "Dismiss";
  close.style.cssText =
    "padding:2px 8px;border-radius:6px;border:1px solid #555;background:#2d2d33;color:inherit;cursor:pointer";
  close.addEventListener("click", () => {
    try {
      localStorage.setItem(id, String(problem.seq));
    } catch {}
    box.remove();
  });
  box.append(text, close);
  doc.body.append(box);
}
