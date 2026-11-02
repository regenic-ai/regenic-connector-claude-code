const test = require("node:test");
const assert = require("node:assert/strict");
const { ChannelDriverError, surfaceFromParts } = require("@regenic/connector-contract");
const {
  verifyChannelDriverConformance, verifyPollConnectorConformance, verifyConnectorSourceMode,
} = require("@regenic/connector-test-utils");
const { discoverClaudeCode, parseJournalLine, createClaudeCodeIntegration, FORMAT } = require("../dist");
const { fs, path, setup, entry, jsonl, SESSION, OTHER, PROJECT, NOW } = require("./helpers.cjs");

function reason(expected) {
  return (error) => error instanceof ChannelDriverError && error.reason === expected;
}

test("published driver/poll conformance, genuine plugin-host mount, no egress", async (t) => {
  const s = await setup(t);
  verifyChannelDriverConformance({
    driver: s.driver, enabled: s.installation, disabled: { ...s.installation, status: "disabled" },
  });
  const stream = await s.stream();
  verifyConnectorSourceMode(stream.connector);
  const report = await verifyPollConnectorConformance({
    connector: stream.connector, cursor: null, connector_id: "installation", source: "claude-code",
  });
  assert.equal(report.record_count, 1);
  assert.equal(s.egress.get("installation", stream.stream_key), undefined);
  assert.equal(s.driver.bindEgress, undefined);
  assert.equal(s.driver.createThread, undefined);
  assert.equal(s.executor.executor_type, "claude-code");
});

test("catalog/probe/options/import/install never access user filesystem or execute CLI", async () => {
  const { driver } = createClaudeCodeIntegration({ spawn() { throw new Error("unexpected execution"); } });
  const env = new Proxy({}, { get() { throw new Error("unexpected environment access"); } });
  assert.ok(driver.installCatalog({ env }));
  assert.deepEqual(await driver.probeCatalog({ env }), { services: {} });
  assert.deepEqual(await driver.listCatalogFieldOptions({ env }), {});
  const installation = driver.install({
    id: "test", org_id: "org", now: NOW,
    config: { root: "/synthetic/nonexistent-root", project: PROJECT, sessions: SESSION, enabled: true, format: FORMAT },
  });
  assert.equal(installation.status, "enabled");
  assert.equal(driver.parseImport, undefined);
  assert.throws(() => driver.install({
    id: "test", org_id: "org", now: NOW, config: {},
  }), ChannelDriverError);
});

test("explicit metadata-only discovery, no transcript reads or recursive subagent/source scan", async (t) => {
  const s = await setup(t);
  await fs.writeFile(s.journal, "{ corrupt content, but discovery must not read it\n");
  await fs.mkdir(path.join(s.project, SESSION, "subagents"), { recursive: true });
  await fs.writeFile(path.join(s.project, SESSION, "subagents", "agent-fake.jsonl"), "never read");
  const root = await discoverClaudeCode({ root: s.root });
  assert.deepEqual(root, { projects: [PROJECT], sessions: [] });
  assert.deepEqual(await discoverClaudeCode({ root: s.root, project: PROJECT }), {
    projects: [PROJECT], sessions: [SESSION],
  });
  const directory = await s.driver.bindSyncSource(s.installation, s.connectorHost, {});
  assert.equal((await directory.listDirectory(null)).members.length, 1);
  await assert.rejects(() => (s.stream()).then((stream) => stream.connector.poll(null)), reason("malformed_journal_json"));
});

test("verified synthetic fragments, tool markers, compact boundary; no duplicate summaries/metadata", async (t) => {
  const s = await setup(t);
  const fixture = await fs.readFile(path.join(__dirname, "fixtures/session.jsonl"));
  await fs.writeFile(s.journal, fixture);
  const stream = await s.stream();
  const page = await stream.connector.poll(null);
  assert.equal(page.batch.records.length, 6);
  const text = JSON.stringify(page.batch.records);
  assert.match(text, /First fragment/);
  assert.match(text, /Second fragment/);
  assert.match(text, /Tool requested: Read/);
  assert.match(text, /Tool completed/);
  assert.match(text, /Context compacted/);
  assert.doesNotMatch(text, /Never import|Do not import|not-to-be-opened|trackedFileBackups/);
  const kinds = page.batch.records.map((r) => surfaceFromParts(r.content).kind);
  assert.deepEqual(kinds, ["user", "assistant", "system", "system", "assistant", "system"]);
  const directions = page.batch.records.map((r) => surfaceFromParts(r.content).direction);
  assert.deepEqual(directions, ["outbound", "inbound", "inbound", "inbound", "inbound", "inbound"]);
  assert.equal(new Set(page.batch.records.map((r) => r.external_id)).size, 6);
  assert.deepEqual(await fs.readFile(s.journal), fixture);
});

test("large journal paginates without gaps, stable replay, append and process-restart cursor", async (t) => {
  const entries = Array.from({ length: 2403 }, (_, i) => entry(i));
  const s = await setup(t, { entries });
  const stream = await s.stream();
  let cursor = null;
  const records = [];
  for (let pages = 0; pages < 30; pages++) {
    const page = await stream.connector.poll(cursor);
    records.push(...page.batch.records);
    cursor = { value: page.next_cursor };
    if (!page.has_more) break;
  }
  assert.equal(records.length, entries.length);
  assert.equal(new Set(records.map((r) => r.external_id)).size, entries.length);
  assert.equal((await stream.connector.poll(cursor)).batch.records.length, 0);
  await fs.appendFile(s.journal, jsonl([entry("new")]));
  const fresh = createClaudeCodeIntegration();
  await fresh.driver.startInstallation(s.installation, s.connectorHost);
  // A new host avoids reusing the old generation's registry binding.
  await s.stop("reconfigure");
  const freshStream = (await fresh.driver.resolveStreams(s.installation, s.connectorHost, {}))[0];
  const next = await freshStream.connector.poll(cursor);
  assert.equal(next.batch.records.length, 1);
  assert.match(JSON.stringify(next.batch.records), /message new/);
  const replay = await freshStream.connector.poll(cursor);
  assert.equal(replay.batch.delivery_id, next.batch.delivery_id);
  assert.deepEqual(replay.batch.records, next.batch.records);
  await fresh.driver.stopInstallation(s.installation, s.connectorHost, { reason: "shutdown", signal: AbortSignal.timeout(1000) });
});

test("partial UTF-8/JSON final line waits until newline and never commits half a record", async (t) => {
  const s = await setup(t, { entries: [] });
  await fs.writeFile(s.journal, "");
  const bytes = Buffer.from(jsonl([entry("partial", "Synthetic UTF-8: \u4f60")]));
  const stream = await s.stream();
  await fs.appendFile(s.journal, bytes.subarray(0, bytes.length - 4));
  const first = await stream.connector.poll(null);
  assert.equal(first.batch.records.length, 0);
  assert.equal(first.has_more, false);
  assert.equal(JSON.parse(first.next_cursor).offset, 0);
  await fs.appendFile(s.journal, bytes.subarray(bytes.length - 4));
  const second = await stream.connector.poll({ value: first.next_cursor });
  assert.equal(second.batch.records.length, 1);
  assert.match(JSON.stringify(second.batch.records), /\u4f60/);
});

test("duplicates share stable source identity; no repeated identities in a batch", async (t) => {
  const row = entry("repeat");
  const s = await setup(t, { entries: [row, row, entry("next")] });
  const page = await (await s.stream()).connector.poll(null);
  assert.equal(page.batch.records.length, 2);
});

test("truncation, replacement, same-inode rewrite, corrupt completed lines and invalid UTF-8 are explicit", async (t) => {
  for (const variant of ["truncate", "replace", "rewrite", "corrupt", "utf8"]) {
    await t.test(variant, async (t) => {
      const s = await setup(t);
      const connector = (await s.stream()).connector;
      const initial = await connector.poll(null);
      if (variant === "truncate") {
        await fs.truncate(s.journal, 0);
        await assert.rejects(() => connector.poll({ value: initial.next_cursor }), reason("source_truncated_reset_cursor_required"));
      } else if (variant === "replace") {
        const replacement = path.join(s.project, "replacement");
        await fs.writeFile(replacement, jsonl([entry("two")]));
        await fs.rename(replacement, s.journal);
        await assert.rejects(() => connector.poll({ value: initial.next_cursor }), reason("source_replaced_reset_cursor_required"));
      } else if (variant === "rewrite") {
        await fs.writeFile(s.journal, jsonl([entry("two")]));
        await assert.rejects(() => connector.poll({ value: initial.next_cursor }), reason("source_rewritten_reset_cursor_required"));
      } else {
        await fs.appendFile(s.journal, variant === "corrupt" ? "private-token /private/path invalid\n" : Buffer.from([255, 10]));
        await assert.rejects(() => connector.poll({ value: initial.next_cursor }), (error) => {
          assert.ok(error instanceof ChannelDriverError);
          assert.doesNotMatch(String(error.stack), /private-token|private\/path|regenic-claude-test/);
          return error.reason === (variant === "corrupt" ? "malformed_journal_json" : "invalid_journal_utf8");
        });
      }
    });
  }
});

test("root/project/journal symlinks, traversal, hardlinks, missing sources and unselected sessions reject", async (t) => {
  const s = await setup(t);
  for (const project of ["..", ".", "../other", "/tmp", "a\\b"]) {
    await assert.rejects(() => discoverClaudeCode({ root: s.root, project }), ChannelDriverError);
  }
  const outside = path.join(s.dir, "outside.jsonl");
  await fs.writeFile(outside, jsonl([entry("outside")]));
  await fs.unlink(s.journal);
  await fs.symlink(outside, s.journal);
  await assert.rejects(() => (s.stream()).then((stream) => stream.connector.poll(null)), reason("symlink_not_allowed"));
  await fs.unlink(s.journal);
  await fs.link(outside, s.journal);
  await assert.rejects(() => (s.stream()).then((stream) => stream.connector.poll(null)), reason("source_not_regular_single_link_file"));
  await fs.unlink(s.journal);
  await assert.rejects(() => (s.stream()).then((stream) => stream.connector.poll(null)), reason("source_missing"));
  await assert.rejects(() => s.driver.resolveThreadStream(s.installation, {
    source: "claude-code", target: OTHER,
  }, s.connectorHost, {}), reason("session_not_selected"));
  const alias = path.join(s.dir, "alias");
  await fs.symlink(s.root, alias);
  await assert.rejects(() => discoverClaudeCode({ root: alias }), reason("symlink_not_allowed"));
  const projectAlias = path.join(s.root, "-alias");
  await fs.symlink(s.workspace, projectAlias);
  await assert.rejects(() => discoverClaudeCode({ root: s.root, project: "-alias" }), reason("symlink_not_allowed"));
});

test("format/session/envelope validation and unknown content fail without exposing input", () => {
  const bad = [
    { ...entry("x"), sessionId: OTHER },
    { ...entry("x"), timestamp: "bad" },
    { ...entry("x"), uuid: undefined },
    entry("x", [{ type: "future-format", payload: "secret" }]),
  ];
  for (const row of bad) assert.throws(() => parseJournalLine(JSON.stringify(row), SESSION, "opaque"), ChannelDriverError);
  assert.throws(() => parseJournalLine('{"type":"unknown-new-format"}', SESSION, "opaque"), reason("unsupported_journal_entry"));
  assert.throws(() => parseJournalLine("private-token invalid", SESSION, "opaque"), (e) => {
    assert.doesNotMatch(e.message, /private-token/);
    return e instanceof ChannelDriverError;
  });
});

test("permission failures and file size/line limits are explicit", async (t) => {
  const s = await setup(t);
  const connector = (await s.stream()).connector;
  await fs.chmod(s.journal, 0);
  try {
    await assert.rejects(() => connector.poll(null), reason("source_permission_denied"));
  } finally { await fs.chmod(s.journal, 0o600); }
  await fs.writeFile(s.journal, "x".repeat(1024 * 1024 + 1));
  await assert.rejects(() => connector.poll(null), reason("journal_line_limit_exceeded"));
  await fs.truncate(s.journal, 128 * 1024 * 1024 + 1);
  await assert.rejects(() => connector.poll(null), reason("journal_size_limit_exceeded"));
});

test("invalid/cross-scope cursors and unsupported history windows reject", async (t) => {
  const s = await setup(t);
  const connector = (await s.stream()).connector;
  await assert.rejects(() => connector.poll({ value: "private-token" }), reason("invalid_cursor"));
  const first = await connector.poll(null);
  const invalid = JSON.parse(first.next_cursor);
  invalid.scope = "wrong";
  await assert.rejects(() => connector.poll({ value: JSON.stringify(invalid) }), reason("invalid_cursor"));
  await assert.rejects(() => connector.poll(null, { latest: true }), reason("unsupported_poll_window"));
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(() => connector.poll(null, { signal: abort.signal }), reason("operation_aborted"));
  assert.equal((await connector.poll(null, { media: true })).batch.records.length, 0);
});

test("all stop reasons fence stale streams/directory handles; re-enable creates a new generation", async (t) => {
  for (const reasonName of ["disable", "delete", "reconfigure", "clear", "shutdown"]) {
    await t.test(reasonName, async (t) => {
      const s = await setup(t);
      const stream = await s.stream();
      const directory = await s.driver.bindSyncSource(s.installation, s.connectorHost, {});
      const source = await fs.readFile(s.journal);
      await s.stop(reasonName);
      await s.stop(reasonName);
      assert.equal(s.connectors.listStreams("installation").length, 0);
      await assert.rejects(async () => stream.connector.poll(null), reason("installation_stopped"));
      await assert.rejects(async () => directory.listDirectory(null), reason("installation_stopped"));
      await s.driver.startInstallation(s.installation, s.connectorHost);
      const fresh = await s.stream();
      assert.equal((await fresh.connector.poll(null)).batch.records.length, 1);
      await assert.rejects(async () => stream.connector.poll(null), reason("installation_stopped"));
      assert.deepEqual(await fs.readFile(s.journal), source);
    });
  }
});

test("stop during an admitted poll aborts delivery and store clear fences all resources", async (t) => {
  const s = await setup(t, { entries: Array.from({ length: 5000 }, (_, i) => entry(i)) });
  const stream = await s.stream();
  const poll = stream.connector.poll(null);
  const caught = assert.rejects(() => poll, ChannelDriverError);
  await s.stop("disable");
  await caught;
  await s.driver.startInstallation(s.installation, s.connectorHost);
  const fresh = await s.stream();
  await s.driver.onStoreClear([s.installation], s.connectorHost);
  await assert.rejects(async () => fresh.connector.poll(null), reason("installation_stopped"));
});

test("directory pages include only selected sessions, with stable cursor and no body reads", async (t) => {
  const s = await setup(t);
  const sessions = Array.from({ length: 205 }, (_, i) =>
    `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
  for (const session of sessions) await fs.writeFile(path.join(s.project, `${session}.jsonl`), "not-a-body-to-read");
  const installation = {
    ...s.installation, id: "many", config: { ...s.installation.config, sessions },
  };
  await s.driver.startInstallation(installation, s.connectorHost);
  const directory = await s.driver.bindSyncSource(installation, s.connectorHost, {});
  const first = await directory.listDirectory(null);
  const second = await directory.listDirectory(first.next_cursor);
  const third = await directory.listDirectory(second.next_cursor);
  assert.equal(first.members.length, 100);
  assert.equal(second.members.length, 100);
  assert.equal(third.members.length, 5);
  assert.equal(first.complete, false);
  assert.equal(third.complete, true);
  assert.equal(third.next_cursor, undefined);
  assert.deepEqual(await directory.listDirectory(null), first);
  assert.ok(!first.members.some((member) => member.thread_id.endsWith(SESSION)));
  await assert.rejects(() => directory.listDirectory("wrong"), reason("invalid_directory_cursor"));
  await s.driver.stopInstallation(installation, s.connectorHost, { reason: "shutdown", signal: AbortSignal.timeout(1000) });
});

test("byte-window pagination across metadata and a split line advertises remaining history", async (t) => {
  const s = await setup(t);
  const metadata = JSON.stringify({ type: "progress", data: "x".repeat(900000) }) + "\n";
  await fs.writeFile(s.journal, metadata.repeat(3) + jsonl([entry("tail")]));
  const connector = (await s.stream()).connector;
  const first = await connector.poll(null);
  assert.equal(first.batch.records.length, 0);
  assert.equal(first.has_more, true);
  const second = await connector.poll({ value: first.next_cursor });
  assert.equal(second.batch.records.length, 1);
  assert.match(JSON.stringify(second.batch.records), /message tail/);
});

test("delayed mount is fenced by bounded stop and cannot later register resources", async (t) => {
  const s = await setup(t);
  const plugin = s.connectorHost.plugin;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let entered;
  const waiting = new Promise((resolve) => { entered = resolve; });
  s.connectorHost.plugin = async (...args) => { entered(); await gate; return plugin(...args); };
  const mounting = s.stream();
  const mountFailure = assert.rejects(() => mounting, reason("installation_stopped"));
  await waiting;
  await assert.rejects(() => s.stop("reconfigure", AbortSignal.timeout(10)), reason("stop_aborted"));
  await assert.rejects(() => s.driver.startInstallation(s.installation, s.connectorHost), reason("installation_stop_incomplete"));
  release();
  await mountFailure;
  await s.stop("reconfigure");
  assert.equal(s.connectors.listStreams("installation").length, 0);
  s.connectorHost.plugin = plugin;
  await s.driver.startInstallation(s.installation, s.connectorHost);
  assert.equal((await (await s.stream()).connector.poll(null)).batch.records.length, 1);
});

test("concurrent activation starts cannot replace a live generation; stop cancels pending start", async (t) => {
  const s = await setup(t, { activate: false });
  await Promise.all([
    s.driver.startInstallation(s.installation, s.connectorHost),
    s.driver.startInstallation(s.installation, s.connectorHost),
  ]);
  const stream = await s.stream();
  await s.stop();
  await assert.rejects(async () => stream.connector.poll(null), reason("installation_stopped"));
  const starting = s.driver.startInstallation(s.installation, s.connectorHost);
  const result = assert.rejects(() => starting, ChannelDriverError);
  await s.stop();
  await result;
  assert.equal(s.connectors.listStreams("installation").length, 0);
  const restarting = s.driver.startInstallation(s.installation, s.connectorHost);
  const cleared = assert.rejects(() => restarting, ChannelDriverError);
  await s.driver.onStoreClear([s.installation], s.connectorHost);
  await cleared;
  assert.equal(s.connectors.listStreams("installation").length, 0);
});

test("rewrites or replacement racing a read fail before a batch is delivered", async (t) => {
  for (const variant of ["rewrite-and-grow", "replace"]) {
    await t.test(variant, async (t) => {
      const s = await setup(t);
      const stream = await s.stream();
      const open = fs.open;
      let changed = false;
      t.mock.method(fs, "open", async (...args) => {
        const handle = await open(...args);
        const read = handle.read.bind(handle);
        handle.read = async (...input) => {
          const result = await read(...input);
          if (!changed) {
            changed = true;
            if (variant === "rewrite-and-grow") {
              await fs.writeFile(s.journal, jsonl([entry("replacement"), entry("additional")]));
            } else {
              const next = path.join(s.project, "next-source");
              await fs.writeFile(next, jsonl([entry("replacement")]));
              await fs.rename(next, s.journal);
            }
          }
          return result;
        };
        return handle;
      });
      await assert.rejects(() => stream.connector.poll(null), reason(
        variant === "replace" ? "source_replaced_reset_cursor_required" : "source_changed_retry",
      ));
    });
  }
});

test("selected filename case is preserved; canonical UUID identity remains stable", async (t) => {
  const s = await setup(t);
  const uppercase = "ABCDEF00-0000-4000-8000-000000000001";
  await fs.writeFile(path.join(s.project, `${uppercase}.jsonl`), jsonl([
    entry("upper", "Synthetic uppercase filename.", { sessionId: uppercase }),
  ]));
  assert.ok((await discoverClaudeCode({ root: s.root, project: PROJECT })).sessions.includes(uppercase));
  const installation = {
    ...s.installation, id: "upper", config: { ...s.installation.config, sessions: [uppercase] },
  };
  await s.driver.startInstallation(installation, s.connectorHost);
  const stream = (await s.driver.resolveStreams(installation, s.connectorHost, {}))[0];
  assert.equal((await stream.connector.poll(null)).batch.records.length, 1);
  assert.ok(stream.thread_id.endsWith(uppercase.toLowerCase()));
  await s.driver.stopInstallation(installation, s.connectorHost, { reason: "shutdown", signal: AbortSignal.timeout(1000) });
  assert.throws(() => s.driver.install({
    id: "bad", org_id: "org", now: NOW,
    config: { ...s.config, sessions: [uppercase, uppercase.toLowerCase()] },
  }), reason("duplicate_session_identity"));
});
