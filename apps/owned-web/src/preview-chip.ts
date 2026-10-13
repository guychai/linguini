// Owned Preview chip: lists the conversation's shared preview ports (opened in a new tab; the
// first request starts the sandbox if it is stopped), lets the user unshare one or share a port.
// Rendered outside the upstream T3 tree, like the other owned notices.
import type { Conversation, PreviewPort } from "./adapter.ts";

export interface PreviewApi {
  previews(id: string): Promise<PreviewPort[]>;
  sharePort(id: string, port: number, label?: string): Promise<void>;
  unsharePort(id: string, port: number): Promise<void>;
}
const CHIP_ID = "owned-preview-chip";
let shownFor: { id: string; key: string } | null = null;

/** Seq of the latest preview share/unshare event: refetch only when it changes. */
export function previewVersion(c: Conversation) {
  const e = c.events
    .filter((x) => x.type === "preview.shared" || x.type === "preview.unshared")
    .at(-1);
  return `${c.id}:${e?.seq ?? 0}`;
}

export async function syncPreviewChip(c: Conversation, api: PreviewApi, doc: Document = document) {
  const key = previewVersion(c);
  if (shownFor?.id === c.id && shownFor.key === key && doc.getElementById(CHIP_ID)) return;
  shownFor = { id: c.id, key };
  const ports = await api.previews(c.id).catch(() => [] as PreviewPort[]);
  render(c.id, ports, api, doc);
}

function render(id: string, ports: PreviewPort[], api: PreviewApi, doc: Document) {
  doc.getElementById(CHIP_ID)?.remove();
  if (!ports.length || (shownFor && shownFor.id !== id)) return;
  const box = doc.createElement("div");
  box.id = CHIP_ID;
  box.dataset.thread = id;
  box.style.cssText =
    "position:fixed;right:16px;bottom:150px;z-index:2147483640;display:flex;flex-direction:column;gap:4px;align-items:flex-end;font:12px/1.3 system-ui,sans-serif";
  for (const p of ports) {
    const chip = doc.createElement("div");
    chip.dataset.port = String(p.port);
    chip.style.cssText =
      "display:flex;gap:6px;align-items:center;padding:4px 8px;border-radius:999px;background:#1f1f23;color:#f5f5f5;border:1px solid #3b82f6;box-shadow:0 2px 10px rgba(0,0,0,.3)";
    const link = doc.createElement("a");
    link.href = p.url ?? `/preview/${id}/${p.port}/`;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = `Preview ${p.label ? `${p.label} ` : ""}:${p.port}${p.cspSandbox ? "" : " (same-origin)"}`;
    link.style.cssText = "color:inherit;text-decoration:none";
    const close = doc.createElement("button");
    close.type = "button";
    close.title = "Stop sharing";
    close.textContent = "×";
    close.style.cssText =
      "border:0;background:none;color:inherit;cursor:pointer;font-size:14px;padding:0 2px";
    close.addEventListener("click", () => {
      close.disabled = true;
      void api.unsharePort(id, p.port).then(
        () => chip.remove(),
        () => (close.disabled = false),
      );
    });
    chip.append(link, close);
    box.append(chip);
  }
  doc.body.append(box);
}

/** Removes the chip when the user leaves the thread. */
export function clearPreviewChip(threadId: string, doc: Document = document) {
  const chip = doc.getElementById(CHIP_ID);
  if (chip && chip.dataset.thread !== threadId) return; // another thread's chip
  chip?.remove();
  if (shownFor?.id === threadId) shownFor = null;
}
