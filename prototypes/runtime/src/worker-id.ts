import { randomUUID } from "node:crypto";
import { hostname } from "node:os";

/**
 * Lease-holder identity for this process. The default `hostname:port:<random>` is unique per
 * process, so two processes can never share a worker ID (for example a stale process still
 * running next to its replacement on the same port). A replacement after a crash therefore
 * recovers the conversations only once the old leases expire (the sweeper runs every lease
 * period). Set OWN_WORKER_ID to a stable, unique-per-slot value to opt into immediate
 * restart-slot reclaim instead.
 */
export function workerId(env: NodeJS.ProcessEnv = process.env): string {
  if (env.OWN_WORKER_ID) return env.OWN_WORKER_ID;
  return `${hostname()}:${env.OWN_PORT ?? 43220}:${randomUUID().slice(0, 12)}`;
}
