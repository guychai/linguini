// Owned affordance for unknown tool outcomes. A non-idempotent tool call that was
// interrupted mid-flight may or may not have taken effect; the backend blocks further work
// in the conversation until someone checks the destination and marks it applied or not
// applied. Rendered outside the upstream T3 tree, like the steer notice.
import type { Conversation, UnknownOutcome } from "./adapter.ts";

export type Outcome = "applied" | "not-applied";
export type ResolveOutcome = (threadId: string, execId: string, outcome: Outcome) => Promise<void>;

const bannerId = (threadId: string) => `owned-outcome-${threadId}`.replace(/[^a-zA-Z0-9_-]/g, "_");
const buttonStyle =
  "padding:4px 10px;border-radius:6px;border:1px solid #555;background:#2d2d33;color:inherit;cursor:pointer";

/** Tool-call status from the journal: unknown until a resolution event arrives. */
export function ledgerStates(c: Conversation) {
  const states = new Map<string, { state: "unknown" } | { state: "resolved"; outcome: Outcome }>();
  for (const e of c.events)
    if (e.type === "tool.outcome_unknown") states.set(String(e.data.callId), { state: "unknown" });
    else if (e.type === "tool.outcome_resolved")
      states.set(String(e.data.callId), {
        state: "resolved",
        outcome: e.data.outcome === "applied" ? "applied" : "not-applied",
      });
  return states;
}

/** Shows (or refreshes, or removes) the conversation's blocked banner. */
export function syncOutcomeNotice(
  c: Conversation,
  resolve: ResolveOutcome,
  doc: Document = document,
) {
  const unknown = c.toolOutcomesUnknown ?? [];
  const existing = doc.getElementById(bannerId(c.id));
  const key = unknown.map((u) => u.execId).join(",");
  if (!unknown.length) return existing?.remove();
  if (existing?.dataset.ownedOutcomes === key) return;
  existing?.remove();
  const box = doc.createElement("div"),
    heading = doc.createElement("p"),
    detail = doc.createElement("p");
  box.id = bannerId(c.id);
  box.setAttribute("role", "alert");
  box.dataset.ownedOutcomes = key;
  box.style.cssText =
    "position:fixed;left:50%;transform:translateX(-50%);top:12px;z-index:2147483647;max-width:520px;padding:12px 14px;border-radius:10px;background:#1f1f23;color:#f5f5f5;border:1px solid #ef4444;font:13px/1.4 system-ui,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.35)";
  heading.textContent = "Conversation blocked: tool outcome unknown";
  heading.style.cssText = "margin:0 0 4px;font-weight:600";
  detail.textContent =
    "A tool call was interrupted and may or may not have taken effect. Check the destination, then mark it. New messages wait until then.";
  detail.style.margin = "0 0 8px";
  box.append(heading, detail);
  for (const u of unknown) box.append(row(c.id, u, resolve, doc));
  doc.body.append(box);
}

function row(threadId: string, u: UnknownOutcome, resolve: ResolveOutcome, doc: Document) {
  const item = doc.createElement("div"),
    label = doc.createElement("div"),
    actions = doc.createElement("div"),
    status = doc.createElement("span");
  item.dataset.ownedOutcome = u.execId;
  item.style.cssText = "border-top:1px solid #333;padding-top:6px;margin-top:6px";
  label.textContent = `${u.tool} (${u.destination}), call ${u.callId}`;
  item.append(label);
  for (const evidence of u.lateObservations ?? []) {
    const note = doc.createElement("div");
    note.textContent = `Late report from epoch ${evidence.epoch} (evidence only): ${evidence.text.slice(0, 200)}`;
    note.style.cssText = "opacity:.8;font-size:12px";
    item.append(note);
  }
  actions.style.cssText = "display:flex;gap:8px;align-items:center;margin-top:4px";
  const buttons = (["applied", "not-applied"] as const).map((outcome) => {
    const b = doc.createElement("button");
    b.type = "button";
    b.textContent = outcome === "applied" ? "Mark applied" : "Mark not applied";
    b.style.cssText = buttonStyle;
    b.addEventListener("click", () => {
      for (const each of buttons) each.disabled = true;
      status.textContent = "Saving…";
      resolve(threadId, u.execId, outcome).then(
        () => {
          const box = item.parentElement;
          item.remove();
          if (box && !box.querySelector("[data-owned-outcome]")) box.remove();
        },
        (error: unknown) => {
          status.textContent = `Failed: ${String(error instanceof Error ? error.message : error)}`;
          for (const each of buttons) each.disabled = false;
        },
      );
    });
    return b;
  });
  actions.append(...buttons, status);
  item.append(actions);
  return item;
}
