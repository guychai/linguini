// Owned, non-blocking notice for a Files-panel save that failed (T3's save coordinator keeps the
// edit unsaved but shows only the tab's dirty dot). Rendered outside the upstream T3 tree.
const ID = "owned-file-save-notice";

/** Show `text` (replacing any previous save notice), or remove the notice with null. */
export function showFileNotice(text: string | null, doc: Document = document) {
  const existing = doc.getElementById(ID);
  if (!text) return existing?.remove();
  if (existing?.dataset.text === text) return;
  existing?.remove();
  const box = doc.createElement("div"),
    span = doc.createElement("span"),
    close = doc.createElement("button");
  box.id = ID;
  box.dataset.text = text;
  box.setAttribute("role", "alert");
  box.style.cssText =
    "position:fixed;left:50%;transform:translateX(-50%);top:12px;z-index:2147483646;max-width:560px;padding:10px 14px;border-radius:10px;background:#1f1f23;color:#f5f5f5;border:1px solid #ef4444;font:13px/1.4 system-ui,sans-serif;display:flex;gap:10px;align-items:center";
  span.textContent = text;
  close.type = "button";
  close.textContent = "Dismiss";
  close.style.cssText =
    "padding:2px 8px;border-radius:6px;border:1px solid #555;background:#2d2d33;color:inherit;cursor:pointer";
  close.addEventListener("click", () => box.remove());
  box.append(span, close);
  doc.body.append(box);
}
