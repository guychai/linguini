/**
 * Durable thread settlement, mirroring T3 orchestration-v2 semantics
 * (apps/server/src/orchestration-v2/Orchestrator.ts):
 * - settle: explicit "settled" override, settledAt (kept when already settled), clears pin
 *   and Active order slot.
 * - unsettle: explicit "active" override (keeps the thread out of automatic settlement).
 * - pin: promotes a settled thread back to "active".
 * - a new user message clears any override (back to automatic).
 * Automatic (inactivity/merge) settlement is not implemented; the capability is not advertised.
 */
export type SettledOverride = "settled" | "active" | null;
export interface SettlementMeta {
  settledOverride?: SettledOverride;
  settledAt?: string | null;
  unsettledAt?: string | null;
  pinnedAt?: string | null;
  pinOrderKey?: string | null;
  activeOrderKey?: string | null;
}
export const SETTLE_ACTIONS = ["settled", "active"] as const;
export type SettleAction = (typeof SETTLE_ACTIONS)[number];

export function applySettle(meta: SettlementMeta, action: SettleAction, now: string) {
  if (action === "settled") {
    const already =
      meta.settledOverride === "settled" && meta.settledAt != null && meta.pinnedAt == null;
    meta.settledOverride = "settled";
    meta.settledAt = already ? meta.settledAt! : now;
    meta.unsettledAt = null;
    meta.pinnedAt = null;
    meta.pinOrderKey = null;
    meta.activeOrderKey = null;
  } else {
    const already = meta.settledOverride === "active";
    meta.settledOverride = "active";
    meta.settledAt = null;
    meta.unsettledAt = already ? (meta.unsettledAt ?? null) : now;
  }
}
/** Pinning is a promotion: an explicit settle becomes an explicit "active". */
export function promoteOnPin(meta: SettlementMeta) {
  if (meta.settledOverride === "settled") {
    meta.settledOverride = "active";
    meta.settledAt = null;
  }
}
/** A new user message returns the thread to automatic settlement. Returns true when changed. */
export function clearOnMessage(meta: SettlementMeta | undefined, now: string) {
  if (!meta || meta.settledOverride == null) return false;
  if (meta.settledOverride === "settled") meta.unsettledAt = now;
  meta.settledOverride = null;
  meta.settledAt = null;
  return true;
}
