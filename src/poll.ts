import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import type {
  ChannelConnector, ConnectorCursor, ConnectorPollOptions, IngestRecord, PollResult,
} from "@regenic/connector-contract";
import { digest, SOURCE, target, type Config } from "./config";
import { checkAbort, fail, filesystemError } from "./errors";
import { checkedPath, openJournal } from "./filesystem";
import { parseJournalLine } from "./parser";

const MAX_FILE = 128 * 1024 * 1024;
const MAX_PAGE = 2 * 1024 * 1024;
const MAX_LINE = 1024 * 1024;
const PAGE_RECORDS = 200;

interface Cursor {
  v: 1;
  scope: string;
  file: string;
  offset: number;
  hash: string;
}

export interface PollRuntime {
  run<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T>;
}

function decode(cursor: ConnectorCursor | null, scope: string): Cursor | undefined {
  if (!cursor) return undefined;
  try {
    if (cursor.value.length > 2048) fail("invalid_cursor");
    const value: unknown = JSON.parse(cursor.value);
    if (!value || typeof value !== "object") fail("invalid_cursor");
    const v = value as Partial<Cursor>;
    if (v.v !== 1 || v.scope !== scope || typeof v.file !== "string" ||
        !Number.isSafeInteger(v.offset) || v.offset! < 0 ||
        v.offset! > MAX_FILE || typeof v.hash !== "string" || !/^[0-9a-f]{64}$/.test(v.hash)) {
      fail("invalid_cursor");
    }
    return v as Cursor;
  } catch {
    fail("invalid_cursor");
  }
}

async function prefix(handle: FileHandle, size: number, signal: AbortSignal) {
  const hash = createHash("sha256");
  const buffer = Buffer.alloc(64 * 1024);
  for (let offset = 0; offset < size;) {
    checkAbort(signal);
    const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, size - offset), offset);
    if (!bytesRead) fail("source_truncated");
    hash.update(buffer.subarray(0, bytesRead));
    offset += bytesRead;
  }
  return hash;
}

export class ClaudeCodePollConnector implements ChannelConnector {
  readonly source = SOURCE;
  readonly source_mode = "poll" as const;

  constructor(
    private readonly config: Config,
    private readonly session: string,
    private readonly connectorId: string,
    private readonly orgId: string,
    private readonly runtime: PollRuntime,
    private readonly now: () => string,
  ) {}

  capabilities() {
    return {
      webhook: false, poll: true, backfill: true, member_sync: false,
      edits: false, tombstones: false, attachments: false,
    };
  }

  poll(cursor: ConnectorCursor | null, options?: ConnectorPollOptions): Promise<PollResult> {
    return this.runtime.run(async (activationSignal) => {
      const controller = new AbortController();
      const abort = () => controller.abort();
      const signals = [activationSignal, options?.signal].filter((s): s is AbortSignal => Boolean(s));
      for (const signal of signals) {
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      }
      try {
        return await this.read(cursor, options, controller.signal);
      } finally {
        for (const signal of signals) signal.removeEventListener("abort", abort);
      }
    });
  }

  private async read(
    cursor: ConnectorCursor | null, options: ConnectorPollOptions | undefined, signal: AbortSignal,
  ): Promise<PollResult> {
    checkAbort(signal);
    if (options?.older || options?.latest || options?.before || options?.before_external_id) {
      fail("unsupported_poll_window");
    }
    const thread = target(this.config, this.session);
    const scope = digest(`${this.config.root}\0${thread}`);
    const previous = decode(cursor, scope);
    let handle: FileHandle | undefined;
    try {
      handle = await openJournal(this.config.root, this.config.project, this.session, signal);
      const stat = await handle.stat();
      if (stat.size > MAX_FILE) fail("journal_size_limit_exceeded");
      const file = `${stat.dev}:${stat.ino}`;
      if (previous && previous.file !== file) fail("source_replaced_reset_cursor_required");
      const offset = previous?.offset ?? 0;
      if (stat.size < offset) fail("source_truncated_reset_cursor_required");
      const hash = await prefix(handle, offset, signal);
      if (previous && hash.copy().digest("hex") !== previous.hash) fail("source_rewritten_reset_cursor_required");
      const buffer = Buffer.alloc(Math.min(MAX_PAGE, stat.size - offset));
      let total = 0;
      while (total < buffer.length) {
        checkAbort(signal);
        const { bytesRead } = await handle.read(buffer, total, buffer.length - total, offset + total);
        if (!bytesRead) fail("source_truncated");
        total += bytesRead;
      }
      const records: IngestRecord[] = [];
      const seen = new Set<string>();
      let consumed = 0;
      let completeLines = false;
      if (options?.media !== true) {
        for (;;) {
          checkAbort(signal);
          const end = buffer.indexOf(10, consumed);
          if (end < 0) {
            if (buffer.length - consumed > MAX_LINE) fail("journal_line_limit_exceeded");
            break;
          }
          if (end - consumed > MAX_LINE) fail("journal_line_limit_exceeded");
          const bytes = buffer.subarray(consumed, end);
          let line: string;
          try {
            line = new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim();
          } catch {
            fail("invalid_journal_utf8");
          }
          const mapped = line ? parseJournalLine(line, this.session, thread) : [];
          if (mapped.length > PAGE_RECORDS) fail("journal_record_limit_exceeded");
          if (records.length + mapped.length > PAGE_RECORDS) {
            completeLines = true;
            break;
          }
          for (const record of mapped) {
            if (!seen.has(record.external_id)) records.push(record);
            seen.add(record.external_id);
          }
          consumed = end + 1;
          if (records.length >= PAGE_RECORDS) {
            completeLines = buffer.indexOf(10, consumed) >= 0 || offset + buffer.length < stat.size;
            break;
          }
        }
      }
      hash.update(buffer.subarray(0, consumed));
      const after = await handle.stat();
      if (after.size < stat.size || (after.size === stat.size && after.mtimeMs !== stat.mtimeMs)) {
        fail("source_changed_retry");
      }
      if (after.size > MAX_FILE) fail("journal_size_limit_exceeded");
      if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) {
        const verified = await prefix(handle, offset + consumed, signal);
        if (verified.digest("hex") !== hash.copy().digest("hex")) fail("source_changed_retry");
      }
      const current = await lstat(await checkedPath(this.config.root, [
        this.config.project, `${this.session}.jsonl`,
      ]));
      if (current.dev !== stat.dev || current.ino !== stat.ino) fail("source_replaced_reset_cursor_required");
      checkAbort(signal);
      const next: Cursor = {
        v: 1, scope, file, offset: offset + consumed, hash: hash.digest("hex"),
      };
      const next_cursor = JSON.stringify(next);
      const has_more = options?.media === true ? false :
        completeLines || offset + buffer.length < stat.size;
      return {
        batch: {
          schema_version: "1.0", connector_id: this.connectorId, org_id: this.orgId,
          delivery_id: digest(`${this.connectorId}\0${thread}\0${next_cursor}\0${records.map((r) => r.external_id).join("\0")}`),
          records, received_at: this.now(), next_cursor,
        },
        next_cursor, has_more, media_pending: false,
        poll_hint: { live_seeded: !has_more, history_pending: has_more },
      };
    } catch (error) {
      return filesystemError(error);
    } finally {
      await handle?.close();
    }
  }
}
