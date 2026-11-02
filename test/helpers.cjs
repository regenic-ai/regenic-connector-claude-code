const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createHost } = require("@regenic/plugin-host");
const { MemoryConnectorRegistry, MemoryEgressRegistry } = require("@regenic/connector-test-utils");
const { createClaudeCodeIntegration, FORMAT } = require("../dist");

const SESSION = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const PROJECT = "-synthetic-project";
const NOW = "2026-01-01T00:00:00.000Z";

function entry(id, content = `message ${id}`, extra = {}) {
  const type = extra.type ?? "user";
  return {
    type, uuid: `synthetic-${id}`, parentUuid: null, sessionId: SESSION,
    timestamp: NOW, message: { role: type, content }, ...extra,
  };
}
function jsonl(entries) { return entries.map((e) => JSON.stringify(e)).join("\n") + "\n"; }

async function setup(t, options = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "regenic-claude-test-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const root = path.join(dir, "projects");
  const project = path.join(root, PROJECT);
  const workspace = path.join(dir, "workspace");
  const state = path.join(dir, "state");
  for (const directory of [project, workspace, state]) await fs.mkdir(directory, { recursive: true });
  const journal = path.join(project, `${SESSION}.jsonl`);
  await fs.writeFile(journal, jsonl(options.entries ?? [entry("one")]));
  const integration = createClaudeCodeIntegration(options);
  const host = await createHost();
  const connectors = new MemoryConnectorRegistry();
  const egress = new MemoryEgressRegistry();
  host.provide("connectors", connectors);
  host.provide("egress", egress);
  const connectorHost = {
    get: (name) => host.get(name),
    plugin: (plugin, config) => host.plugin(plugin, config),
    now: () => NOW,
    secrets: { read() { throw new Error("must not read secrets"); }, write() { throw new Error("must not write secrets"); } },
  };
  const config = {
    root, project: PROJECT, sessions: SESSION, enabled: true, format: FORMAT,
    execution_enabled: false, execution_cwd: workspace,
    execution_state_dir: state, cli_path: process.execPath,
    ...(options.config ?? {}),
  };
  const installed = integration.driver.install({ id: "installation", org_id: "org", config, now: NOW });
  const installation = { ...installed, updated_at: NOW };
  const stop = async (reason = "shutdown", signal = AbortSignal.timeout(3000)) =>
    integration.driver.stopInstallation(installation, connectorHost, { reason, signal });
  t.after(async () => { await stop(); await host.dispose(); });
  if (options.activate !== false) await integration.driver.startInstallation(installation, connectorHost);
  return {
    ...integration, dir, root, project, journal, workspace, state, host,
    connectorHost, connectors, egress, config, installation, stop,
    async stream() {
      return (await integration.driver.resolveStreams(installation, connectorHost, {}))[0];
    },
  };
}

function executionInput(id = "run-one", extra = {}) {
  return {
    run_id: id,
    work_item: { id: "work", thread_id: "source:thread", record_class: "message", thread_facet: "agent" },
    recipe: { id: "recipe", executor_config: {} },
    evidence_text: "Synthetic task only; not a real agent request.",
    ...extra,
  };
}
function run(id = "run-one", handle = {}) {
  return {
    id, org_id: "org", work_item_id: "work", recipe_id: "recipe",
    executor_type: "claude-code", status: "running",
    created_at: NOW, updated_at: NOW, ...handle,
  };
}
function context() {
  return {
    org_id: "org", installation_id: "installation", env: {},
    spawnSysout() { throw new Error("not DSH"); },
    writeStdin() { throw new Error("not DSH"); },
    listPrompts() { throw new Error("not DSH"); },
    readTranscript() { throw new Error("not DSH"); },
  };
}
async function eventually(fn, predicate, timeout = 4000) {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await fn();
    if (predicate(value)) return value;
    if (Date.now() >= end) throw new Error("condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

module.exports = { fs, path, setup, entry, jsonl, SESSION, OTHER, PROJECT, NOW, executionInput, run, context, eventually };
