const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { createRequire } = require("node:module");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { MemoryConnectorRegistry } = require("@regenic/connector-test-utils");

test("npm tarball installs production-only and loads manifest contributions with require + real host", async (t) => {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "regenic-claude-pack-")));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const output = execFileSync("npm", [
    "pack", "--ignore-scripts", "--json", "--pack-destination", dir,
  ], { cwd: path.join(__dirname, ".."), encoding: "utf8", timeout: 30000 });
  const [packed] = JSON.parse(output);
  assert.ok(packed.files.some((f) => f.path === "dist/index.js"));
  assert.ok(!packed.files.some((f) => /test\/|fixtures\/|node_modules\//.test(f.path)));
  const prefix = path.join(dir, "installed");
  execFileSync("npm", [
    "install", "--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund",
    "--prefix", prefix, path.join(dir, packed.filename),
  ], { encoding: "utf8", timeout: 60000 });
  const requireInstalled = createRequire(path.join(prefix, "entry.cjs"));
  const pkg = requireInstalled("@regenic/connector-claude-code");
  const packageDir = path.dirname(requireInstalled.resolve("@regenic/connector-claude-code"));
  const manifest = JSON.parse(await fs.readFile(path.join(packageDir, "..", "package.json"), "utf8"));
  const contract = requireInstalled("@regenic/connector-contract");
  assert.equal(manifest.regenic.plugin, true);
  assert.equal(manifest.regenic.engines.regenic, contract.CONNECTOR_PROTOCOL);
  for (const name of manifest.regenic.contributes.drivers) {
    assert.equal(typeof pkg[name].install, "function");
    assert.equal(pkg[name].connector_protocol, contract.CONNECTOR_PROTOCOL);
  }
  for (const name of manifest.regenic.contributes.executors) {
    assert.equal(typeof pkg[name].start, "function");
    assert.equal(typeof pkg[name].cancel, "function");
  }
  assert.throws(() => pkg.claudeCodeDriver.install({
    id: "invalid", org_id: "org", config: {}, now: "2026-01-01",
  }), contract.ChannelDriverError);
  const dependencies = JSON.parse(execFileSync("npm", [
    "ls", "--prefix", prefix, "--omit=dev", "--all", "--json",
  ], { encoding: "utf8", timeout: 30000 }));
  const versions = [];
  function walk(deps) {
    for (const [name, value] of Object.entries(deps ?? {})) {
      if (name === "zod") versions.push(value.version);
      if (name === "@regenic/connector-contract") assert.equal(value.version, "0.3.0");
      walk(value.dependencies);
    }
  }
  walk(dependencies.dependencies);
  assert.ok(versions.length > 0 && versions.every((version) => Number(version.split(".")[0]) === 4));
  const root = path.join(dir, "projects");
  const project = "-synthetic";
  const session = "33333333-3333-4333-8333-333333333333";
  await fs.mkdir(path.join(root, project), { recursive: true });
  await fs.writeFile(path.join(root, project, `${session}.jsonl`), JSON.stringify({
    type: "user", uuid: "synthetic-entry", sessionId: session,
    timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: "Synthetic packed fixture" },
  }) + "\n");
  const host = await requireInstalled("@regenic/plugin-host").createHost();
  const connectors = new MemoryConnectorRegistry();
  host.provide("connectors", connectors);
  const connectorHost = {
    get: (name) => host.get(name), plugin: (plugin, config) => host.plugin(plugin, config),
    now: () => "2026-01-01T00:00:00.000Z", secrets: {},
  };
  const installation = {
    ...pkg.claudeCodeDriver.install({
      id: "packed", org_id: "org", now: "2026-01-01T00:00:00.000Z",
      config: { root, project, sessions: session, format: pkg.FORMAT, enabled: true },
    }), updated_at: "2026-01-01T00:00:00.000Z",
  };
  await pkg.claudeCodeDriver.startInstallation(installation, connectorHost);
  const streams = await pkg.claudeCodeDriver.resolveStreams(installation, connectorHost, {});
  assert.equal((await streams[0].connector.poll(null)).batch.records.length, 1);
  await pkg.claudeCodeDriver.stopInstallation(installation, connectorHost, {
    reason: "shutdown", signal: AbortSignal.timeout(2000),
  });
  assert.equal(connectors.listStreams("packed").length, 0);
  await host.dispose();
});
