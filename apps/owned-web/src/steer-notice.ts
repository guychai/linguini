// Owned affordance for stale steering. The handoff rule: a steer that can no longer reach
// the run it targeted is rejected, never silently turned into a new run. The user decides
// whether to send the text as a new message. Rendered outside the upstream T3 tree so no
// upstream component has to change.
import type { Conversation } from "./adapter.ts";

export interface RejectedSteer {
  threadId: string;
  steerId: string;
  text: string;
}
const handledKey = (steer: RejectedSteer) =>
  `owned-steer-handled:${steer.threadId}:${steer.steerId}`;
/** Deterministic command ID: a double click or retry cannot send the message twice. */
export const resendCommandId = (steer: RejectedSteer) => `resend-${steer.steerId}`.slice(0, 200);

export function rejectedSteers(c: Conversation): RejectedSteer[] {
  const resent = new Set(c.jobs.map((j) => j.id));
  return c.events
    .filter((e) => e.type === "steering.rejected" && typeof e.data.jobId === "string")
    .map((e) => ({
      threadId: c.id,
      steerId: String(e.data.jobId),
      text: String(e.data.text ?? c.jobs.find((j) => j.id === e.data.jobId)?.text ?? ""),
    }))
    .filter((s) => s.text && !resent.has(resendCommandId(s)));
}

export function showSteerNotice(
  steer: RejectedSteer,
  send: (steer: RejectedSteer) => Promise<void>,
  doc: Document = document,
) {
  if (sessionStorage.getItem(handledKey(steer))) return;
  const id = `owned-steer-notice-${steer.steerId}`.replace(/[^a-zA-Z0-9_-]/g, "_");
  if (doc.getElementById(id)) return;
  const box = doc.createElement("div"),
    message = doc.createElement("p"),
    quote = doc.createElement("q"),
    actions = doc.createElement("div");
  const resend = doc.createElement("button"),
    dismiss = doc.createElement("button"),
    status = doc.createElement("span");
  box.id = id;
  box.setAttribute("role", "alert");
  box.dataset.ownedSteerNotice = steer.steerId;
  box.style.cssText =
    "position:fixed;right:16px;bottom:16px;z-index:2147483647;max-width:380px;padding:12px 14px;border-radius:10px;background:#1f1f23;color:#f5f5f5;border:1px solid #f59e0b;font:13px/1.4 system-ui,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.35)";
  message.textContent = "Steer not applied: the run it targeted is no longer active.";
  message.style.margin = "0 0 6px";
  quote.textContent = steer.text.length > 160 ? `${steer.text.slice(0, 157)}…` : steer.text;
  quote.style.cssText = "display:block;margin:0 0 8px;opacity:.85";
  actions.style.cssText = "display:flex;gap:8px;align-items:center";
  resend.type = dismiss.type = "button";
  resend.textContent = "Send as new message";
  dismiss.textContent = "Dismiss";
  for (const b of [resend, dismiss])
    b.style.cssText =
      "padding:4px 10px;border-radius:6px;border:1px solid #555;background:#2d2d33;color:inherit;cursor:pointer";
  const close = () => {
    sessionStorage.setItem(handledKey(steer), "1");
    box.remove();
  };
  dismiss.addEventListener("click", close);
  resend.addEventListener("click", () => {
    resend.disabled = dismiss.disabled = true;
    status.textContent = "Sending…";
    send(steer).then(close, (error: unknown) => {
      status.textContent = `Failed: ${String(error instanceof Error ? error.message : error)}`;
      resend.disabled = dismiss.disabled = false;
    });
  });
  actions.append(resend, dismiss, status);
  box.append(message, quote, actions);
  doc.body.append(box);
}
