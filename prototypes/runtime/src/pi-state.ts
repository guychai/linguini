import { SessionManager, type FileEntry } from "@earendil-works/pi-coding-agent";
import type { Conversation } from "./store.ts";

export function recordPiOutcome(c: Conversation, jobId: string, status: string) {
  if (!c.piEntries) return;
  const manager = SessionManager.inMemory("/workspace", undefined, c.piEntries);
  manager.appendCustomEntry("owned.turn_outcome", { jobId, status });
  c.piEntries = [manager.getHeader()!, ...manager.getEntries()];
}
export function recoverPiState(c: Conversation) {
  if (!c.piEntries) return;
  const manager = SessionManager.inMemory("/workspace", undefined, c.piEntries);
  const messages = manager.buildSessionContext().messages;
  const results = new Set(messages.filter((m) => m.role === "toolResult").map((m) => m.toolCallId));
  for (const message of messages)
    if (message.role === "assistant") {
      for (const block of message.content)
        if (block.type === "toolCall" && !results.has(block.id)) {
          const receipt = c.jobs.map((j) => c.receipts[`tool:${j.id}:${block.id}`]).find(Boolean)
            ?.result as { text?: string; productionData?: boolean } | null | undefined;
          const entry = Object.values(c.ledger ?? {}).find((e) =>
            c.jobs.some((j) => e.callId === `${j.id}:${block.id}`),
          );
          const pending =
            entry?.status === "intent"
              ? `Worker interrupted. This ${entry.replay} call (execution ${entry.execId}) is recovered by the tool ledger, not replayed by the model; its result is recorded as a tool.result event.`
              : entry?.status === "unknown"
                ? `Worker interrupted. Tool outcome is unknown (execution ${entry.execId}); it was not replayed, and the conversation is blocked until the outcome is resolved.`
                : "Worker interrupted. Tool outcome is uncertain; it was not replayed. Inspect durable tool receipts before explicitly continuing.";
          // Confirmed receipts restore the actual result; uncertain outcomes stay errors.
          manager.appendMessage({
            role: "toolResult",
            toolCallId: block.id,
            toolName: block.name,
            content: [{ type: "text", text: receipt?.text ?? pending }],
            isError: !receipt,
            timestamp: Date.now(),
          });
        }
    }
  for (const job of c.jobs)
    if (job.status === "running" || job.status === "cancelled") {
      const entries = manager.getEntries();
      if (
        entries.some(
          (e) =>
            e.type === "custom" &&
            e.customType === "owned.turn_recovery" &&
            (e.data as { jobId?: string })?.jobId === job.id,
        )
      )
        continue;
      const start = entries.findLastIndex(
        (e) =>
          e.type === "custom" &&
          e.customType === "owned.turn_started" &&
          (e.data as { jobId?: string })?.jobId === job.id,
      );
      const tail = entries.slice(start < 0 ? 0 : start + 1);
      if (!tail.some((e) => e.type === "message" && e.message.role === "user"))
        manager.appendMessage({
          role: "user",
          content: [{ type: "text", text: job.text }],
          timestamp: Date.now(),
        });
      const partial = c.events
        .filter((e) => e.data.jobId === job.id && e.type === "assistant.delta")
        .map((e) => String(e.data.text ?? ""))
        .join("");
      if (
        partial &&
        !tail.some(
          (e) =>
            e.type === "message" &&
            e.message.role === "assistant" &&
            e.message.content.some((b) => b.type === "text"),
        )
      ) {
        manager.appendMessage({
          role: "assistant",
          content: [{ type: "text", text: partial }],
          api: "anthropic-messages",
          provider: "anthropic",
          model: "claude-sonnet-4-5",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "aborted",
          timestamp: Date.now(),
        });
      }
      manager.appendCustomEntry("owned.turn_recovery", {
        jobId: job.id,
        status: job.status,
        text: job.text,
      });
    }
  c.piEntries = [manager.getHeader()!, ...manager.getEntries()] as FileEntry[];
}

// Old prototype journals never contained native model metadata. Import their
// available structure explicitly, rather than silently dropping or flattening it.
export function importLegacyPiState(c: Conversation, excludeJobId?: string) {
  if (c.piEntries) return;
  const manager = SessionManager.inMemory("/workspace");
  manager.appendCustomEntry("owned.legacy_import", {
    syntheticMetadata: true,
    source: "durable-journal",
    missingNativeMetadata: true,
  });
  const assistant = (content: any[], aborted = false) =>
    manager.appendMessage({
      role: "assistant",
      content,
      api: "anthropic-messages",
      provider: process.env.PI_PROVIDER ?? "anthropic",
      model: process.env.PI_MODEL ?? "claude-sonnet-4-5",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: aborted
        ? "aborted"
        : content.some((b) => b.type === "toolCall")
          ? "toolUse"
          : "stop",
      timestamp: Date.now(),
    });
  for (const job of c.jobs) {
    if (job.id === excludeJobId || job.status === "queued") continue;
    manager.appendMessage({
      role: "user",
      content: [{ type: "text", text: job.text }],
      timestamp: Date.now(),
    });
    const events = c.events.filter((e) => e.data.jobId === job.id),
      outputs = events.filter((e) => e.type === "tool.output");
    for (const start of events.filter((e) => e.type === "tool.started")) {
      const callId = String(start.data.callId ?? `legacy-${job.id}-${start.seq}`),
        name = String(start.data.tool);
      const result = outputs.find((e) =>
        start.data.callId ? e.data.callId === start.data.callId : e.data.tool === start.data.tool,
      );
      assistant([{ type: "toolCall", id: callId, name, arguments: start.data.args ?? {} }]);
      manager.appendMessage({
        role: "toolResult",
        toolCallId: callId,
        toolName: name,
        content: [
          {
            type: "text",
            text: result
              ? String(result.data.text)
              : "Legacy tool outcome uncertain; not replayed.",
          },
        ],
        isError: !result || result.data.isError === true,
        timestamp: Date.now(),
      });
    }
    const text = events
      .filter((e) => e.type === "assistant.delta")
      .map((e) => String(e.data.text ?? ""))
      .join("");
    if (text) assistant([{ type: "text", text }], job.status !== "done");
    manager.appendCustomEntry("owned.turn_outcome", {
      jobId: job.id,
      status: job.status,
      legacy: true,
    });
  }
  c.piEntries = [manager.getHeader()!, ...manager.getEntries()];
}
