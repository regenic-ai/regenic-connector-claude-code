import { channelRecord, type IngestRecord } from "@regenic/connector-contract";
import { digest, SOURCE } from "./config";
import { fail } from "./errors";

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function required(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 500) fail("invalid_journal_envelope");
  return value;
}

export function parseJournalLine(line: string, session: string, thread: string): IngestRecord[] {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    fail("malformed_journal_json");
  }
  const entry = object(raw);
  if (!entry || typeof entry.type !== "string") fail("invalid_journal_envelope");
  if (!["user", "assistant", "system", "progress", "attachment", "summary",
    "file-history-snapshot", "custom-title", "tag", "agent-name"].includes(entry.type)) {
    fail("unsupported_journal_entry");
  }
  if (entry.type !== "user" && entry.type !== "assistant" &&
      !(entry.type === "system" && entry.subtype === "compact_boundary")) return [];
  for (const flag of ["isSidechain", "isMeta", "isCompactSummary"]) {
    if (entry[flag] !== undefined && typeof entry[flag] !== "boolean") fail("invalid_journal_envelope");
  }
  if (entry.teamName !== undefined && typeof entry.teamName !== "string") fail("invalid_journal_envelope");
  if (entry.isSidechain || entry.teamName || entry.isMeta || entry.isCompactSummary) return [];
  if (required(entry.sessionId).toLowerCase() !== session.toLowerCase()) fail("journal_session_mismatch");
  const uuid = required(entry.uuid);
  const timestamp = required(entry.timestamp);
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?(?:Z|[+-]\d\d:\d\d)$/.test(timestamp) ||
      !Number.isFinite(Date.parse(timestamp))) {
    fail("invalid_journal_timestamp");
  }
  const occurred_at = new Date(timestamp).toISOString();
  const external = `${thread}:${digest(uuid)}`;
  const make = (suffix: string, text: string, kind: "user" | "assistant" | "system", type = "message") =>
    channelRecord({
      channel: SOURCE, kind, direction: kind === "user" ? "outbound" : "inbound", type,
      external_id: `${external}:${suffix}`, occurred_at,
      actor_id: `claude-code:${kind}`, actor_label: kind === "assistant" ? "Claude Code" : kind,
      scope_id: thread, thread_id: thread,
      conversation_kind: "session", thread_facet: "agent", text,
    });
  if (entry.type === "system") {
    return [make("compact", "Context compacted (summary not imported).", "system", "thread_status")];
  }
  const message = object(entry.message);
  if (!message || (message.role !== undefined && message.role !== entry.type)) fail("invalid_journal_message");
  const content = message.content;
  if (typeof content === "string") return content ? [make("text", content, entry.type)] : [];
  if (!Array.isArray(content)) fail("invalid_journal_content");
  const texts: string[] = [];
  const work: IngestRecord[] = [];
  for (const [index, rawBlock] of content.entries()) {
    const block = object(rawBlock);
    if (!block || typeof block.type !== "string") fail("invalid_content_block");
    if (block.type === "text") {
      if (typeof block.text !== "string") fail("invalid_text_block");
      texts.push(block.text);
    } else if (block.type === "tool_use") {
      if (entry.type !== "assistant") fail("invalid_tool_envelope");
      required(block.id);
      const name = required(block.name);
      if (!/^[a-zA-Z0-9_.:-]{1,120}$/.test(name)) fail("invalid_tool_name");
      const record = make(`tool:${index}`, `Tool requested: ${name}`, "system", "thread_status");
      record.attrs = { ...record.attrs, claude_tool_id: digest(required(block.id)), claude_tool_phase: "request" };
      work.push(record);
    } else if (block.type === "tool_result") {
      if (entry.type !== "user") fail("invalid_tool_envelope");
      if (block.is_error !== undefined && typeof block.is_error !== "boolean") fail("invalid_tool_result");
      required(block.tool_use_id);
      const record = make(
        `tool:${index}`, block.is_error === true ? "Tool failed." : "Tool completed.",
        "system", "thread_status",
      );
      record.attrs = { ...record.attrs, claude_tool_id: digest(required(block.tool_use_id)), claude_tool_phase: "result" };
      work.push(record);
    } else if (!["thinking", "redacted_thinking", "image", "document"].includes(block.type)) {
      fail("unsupported_content_block");
    }
  }
  return [...(texts.length ? [make("text", texts.join("\n"), entry.type)] : []), ...work];
}
