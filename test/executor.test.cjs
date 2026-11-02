const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const { createHash } = require("node:crypto");
const { ChannelDriverError } = require("@regenic/connector-contract");
const { createClaudeCodeIntegration } = require("../dist");
const { fs, path, setup, executionInput, run, context, eventually } = require("./helpers.cjs");

const fixture = path.join(__dirname, "fixtures/fake-cli.cjs");
function spawning(scenario = "success", captures = []) {
  return (file, args, options) => {
    const child = spawn(process.execPath, [fixture, scenario], options);
    captures.push({ file, args, options, child });
    return child;
  };
}
function reason(expected) {
  return (error) => error instanceof ChannelDriverError && error.reason === expected;
}
async function terminal(s, id = "run-one", ctx = context()) {
  return eventually(() => s.executor.status(run(id), ctx), (h) => h.status !== "running");
}

test("execution is disabled by default; no task before explicit activation/configuration", async (t) => {
  let count = 0;
  const s = await setup(t, { spawn() { count++; throw new Error("not allowed"); } });
  assert.equal(s.driver.capabilities(s.installation).execute, false);
  await assert.rejects(() => s.executor.start(executionInput(), context()), reason("execution_not_enabled"));
  assert.equal(count, 0);
  const noPin = context();
  delete noPin.installation_id;
  await assert.rejects(() => s.executor.start(executionInput(), noPin), reason("host_installation_pin_required"));
  const noId = executionInput();
  delete noId.run_id;
  await assert.rejects(() => s.executor.start(noId, context()), reason("durable_run_id_required"));
});

test("official CLI argv restricts tools independently of approval; prompt only on stdin; bounded result", async (t) => {
  const captures = [];
  const s = await setup(t, {
    spawn: spawning("success", captures),
    config: { execution_enabled: true },
  });
  const ctx = context();
  assert.equal(s.driver.capabilities(s.installation).execute, true);
  assert.equal(s.driver.capabilities(s.installation).create, false);
  assert.equal(s.driver.createThread, undefined);
  assert.equal(s.driver.capabilities({ ...s.installation, status: "disabled" }).execute, false);
  ctx.env = {
    PATH: "/synthetic/path", ANTHROPIC_API_KEY: "PRIVATE_SYNTHETIC_TOKEN",
    CLAUDE_CODE_USE_BEDROCK: "1", NODE_OPTIONS: "--require unsafe", UNRELATED: "secret",
  };
  const handle = await s.executor.start(executionInput(), ctx);
  assert.equal(handle.status, "running");
  const { args, options, file } = captures[0];
  assert.equal(file, process.execPath);
  assert.equal(args[args.indexOf("--tools") + 1], "");
  assert.equal(args[args.indexOf("--disallowedTools") + 1], "mcp__*");
  assert.equal(args[args.indexOf("--permission-mode") + 1], "default");
  assert.equal(args[args.indexOf("--setting-sources") + 1], "");
  assert.equal(args[args.indexOf("--mcp-config") + 1], '{"mcpServers":{}}');
  assert.equal(args[args.indexOf("--settings") + 1], '{"disableAllHooks":true}');
  assert.ok(args.includes("--strict-mcp-config") && args.includes("--disable-slash-commands"));
  assert.ok(args.includes("--no-session-persistence"));
  assert.ok(!args.includes("--allowedTools"));
  assert.doesNotMatch(JSON.stringify(args), /Synthetic task|PRIVATE_SYNTHETIC_TOKEN|bypass|dangerously/);
  assert.equal(options.shell, false);
  assert.equal(options.detached, true);
  assert.equal(options.cwd, await fs.realpath(s.workspace));
  assert.deepEqual(options.env, { PATH: "/synthetic/path", ANTHROPIC_API_KEY: "PRIVATE_SYNTHETIC_TOKEN" });
  const result = await terminal(s, "run-one", ctx);
  assert.equal(result.status, "completed");
  assert.equal(result.result.summary, "Synthetic result.");
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_SYNTHETIC_TOKEN|synthetic\/private/);
  assert.deepEqual(await s.executor.resume({
    run: run(), recipe: executionInput().recipe, work_item: executionInput().work_item,
  }, ctx), result);
  assert.equal(captures.length, 1);
});

test("limited tools require explicit selection, no Bash/Agent/MCP/wildcard permission bypass", async (t) => {
  const captures = [];
  const s = await setup(t, {
    spawn: spawning("success", captures),
    config: { execution_enabled: true, allowed_tools: "Read,Edit,Write" },
  });
  await s.executor.start(executionInput(), context());
  assert.equal(captures[0].args[captures[0].args.indexOf("--tools") + 1], "Read,Edit,Write");
  assert.equal(captures[0].args[captures[0].args.indexOf("--allowedTools") + 1], "Read,Edit,Write");
  await terminal(s);
  for (const tools of ["Bash", "Agent", "mcp__*", "*", "default", "Read(*)"]) {
    assert.throws(() => s.driver.install({
      id: "bad", org_id: "org", now: "2026-01-01",
      config: { ...s.config, allowed_tools: tools },
    }), reason("unsupported_tool"));
  }
});

test("same run start is idempotent and concurrent starts never duplicate; changed input rejects", async (t) => {
  const captures = [];
  const s = await setup(t, { spawn: spawning("success", captures), config: { execution_enabled: true } });
  const [first, second] = await Promise.all([
    s.executor.start(executionInput(), context()), s.executor.start(executionInput(), context()),
  ]);
  assert.deepEqual(second, first);
  assert.equal(captures.length, 1);
  await terminal(s);
  assert.equal((await s.executor.start(executionInput(), context())).status, "completed");
  assert.equal(captures.length, 1);
  await assert.rejects(() => s.executor.start(
    executionInput("run-one", { evidence_text: "Different task" }), context(),
  ), reason("run_id_conflict"));
});

test("persistent claim blocks automatic rerun after process restart; completed state remains observable", async (t) => {
  const captures = [];
  const s = await setup(t, { spawn: spawning("hang", captures), config: { execution_enabled: true } });
  await s.executor.start(executionInput(), context());
  const fresh = createClaudeCodeIntegration({ spawn() { throw new Error("must not restart"); } });
  await fresh.driver.startInstallation(s.installation, s.connectorHost);
  await assert.rejects(() => fresh.executor.start(executionInput(), context()), reason("execution_state_unknown_no_automatic_restart"));
  await assert.rejects(() => fresh.executor.status(run(), context()), reason("execution_state_unknown_no_automatic_restart"));
  await assert.rejects(() => fresh.executor.resume({
    run: run(), recipe: executionInput().recipe, work_item: executionInput().work_item,
  }, context()), reason("execution_state_unknown_no_automatic_restart"));
  await s.executor.cancel(run(), context());
  assert.equal((await terminal(s)).status, "cancelled");
  assert.equal((await fresh.executor.status(run(), context())).status, "cancelled");
  const replay = await Promise.all([
    fresh.executor.start(executionInput(), context()), fresh.executor.start(executionInput(), context()),
  ]);
  assert.ok(replay.every((handle) => handle.status === "cancelled"));
  assert.equal(captures.length, 1);
  const stateFiles = await fs.readdir(s.state);
  assert.equal(stateFiles.length, 1);
  const stored = await fs.readFile(path.join(s.state, stateFiles[0]), "utf8");
  assert.doesNotMatch(stored, /Synthetic task|workspace|PRIVATE_SYNTHETIC_TOKEN/);
  await fresh.driver.stopInstallation(s.installation, s.connectorHost, { reason: "shutdown", signal: AbortSignal.timeout(2000) });
});

test("CLI auth/error/permission-denied/malformed/missing/nonzero output never claims success or leaks stderr", async (t) => {
  for (const scenario of ["denied", "error", "invalid", "partial", "missing", "nonzero", "oversized"]) {
    await t.test(scenario, async (t) => {
      const s = await setup(t, {
        spawn: spawning(scenario), config: { execution_enabled: true },
      });
      await s.executor.start(executionInput(), context());
      const result = await terminal(s);
      assert.equal(result.status, "failed");
      assert.doesNotMatch(JSON.stringify(result), /PRIVATE_SYNTHETIC_TOKEN|synthetic\/private/);
      if (scenario === "denied") assert.match(result.result.summary, /permission_denied/);
    });
  }
});

test("missing executable becomes explicit failed result and never logs OS paths", async (t) => {
  const s = await setup(t, {
    spawn: (_file, _args, options) => spawn("/synthetic/private/nonexistent-claude", [], options),
    config: { execution_enabled: true },
  });
  await s.executor.start(executionInput(), context());
  const result = await terminal(s);
  assert.equal(result.status, "failed");
  assert.match(result.result.summary, /cli_spawn_failed/);
  assert.doesNotMatch(JSON.stringify(result), /private\/nonexistent/);
});

test("cancel terminates owned child process group; timeout reports failure", async (t) => {
  for (const scenario of ["cancel", "timeout"]) {
    await t.test(scenario, async (t) => {
      const captures = [];
      const s = await setup(t, {
        spawn: spawning("hang", captures),
        config: { execution_enabled: true, timeout_ms: scenario === "timeout" ? 100 : 5000 },
      });
      await s.executor.start(executionInput(), context());
      await eventually(() => s.executor.status(run(), context()), (h) => h.transcript?.activity === "working");
      if (scenario === "cancel") await s.executor.cancel(run(), context());
      const result = await terminal(s);
      assert.equal(result.status, scenario === "cancel" ? "cancelled" : "failed");
      if (scenario === "timeout") assert.match(result.result.summary, /execution_timeout/);
      assert.throws(() => process.kill(-captures[0].child.pid, 0), { code: "ESRCH" });
    });
  }
});

test("installation stop cancels tasks and descendants before reporting success", async (t) => {
  const captures = [];
  const s = await setup(t, { spawn: spawning("tree", captures), config: { execution_enabled: true } });
  await s.executor.start(executionInput(), context());
  await eventually(() => s.executor.status(run(), context()), (h) => h.transcript?.activity === "working");
  await s.stop("disable");
  assert.equal((await s.executor.status(run(), context())).status, "cancelled");
  assert.throws(() => process.kill(-captures[0].child.pid, 0), { code: "ESRCH" });
  await assert.rejects(() => s.executor.start(executionInput("new-run"), context()), reason("installation_stopped"));
});

test("execution workspace/storage/state must be disjoint; no symlink workspace or implicit cwd", async (t) => {
  const s = await setup(t, { config: { execution_enabled: true, execution_cwd: undefined } }).catch((error) => {
    assert.equal(error.reason, "explicit_execution_paths_required");
    return undefined;
  });
  assert.equal(s, undefined);
  const fixtureState = await setup(t, { spawn: spawning(), config: { execution_enabled: true } });
  const invalid = {
    ...fixtureState.installation, config: { ...fixtureState.installation.config, execution_cwd: fixtureState.root },
  };
  const fresh = createClaudeCodeIntegration();
  await fresh.driver.startInstallation(invalid, fixtureState.connectorHost);
  await assert.rejects(() => fresh.executor.start(executionInput(), context()), reason("execution_directories_must_be_disjoint"));
  await fresh.driver.stopInstallation(invalid, fixtureState.connectorHost, { reason: "shutdown", signal: AbortSignal.timeout(1000) });
  assert.deepEqual(await fs.readdir(fixtureState.state), []);
});

test("unknown run or unsupported approval answer does not start anything; org identity enforced", async (t) => {
  const captures = [];
  const s = await setup(t, { spawn: spawning("success", captures), config: { execution_enabled: true } });
  await assert.rejects(() => s.executor.status(run("unknown"), context()), reason("execution_state_unknown_no_automatic_restart"));
  await assert.rejects(() => s.executor.status({ ...run(), org_id: "different" }, context()), reason("execution_identity_mismatch"));
  await assert.rejects(() => s.executor.resume({
    run: run(), recipe: executionInput().recipe, work_item: executionInput().work_item, answer: {},
  }, context()), reason("interactive_approval_not_supported"));
  assert.equal(captures.length, 0);
});

test("corrupt durable state blocks execution instead of resetting claim", async (t) => {
  const captures = [];
  const s = await setup(t, { spawn: spawning("success", captures), config: { execution_enabled: true } });
  const key = createHash("sha256").update("org\0run-one").digest("hex");
  await fs.writeFile(path.join(s.state, `${key}.json`), "PRIVATE_SYNTHETIC_TOKEN invalid");
  await assert.rejects(() => s.executor.start(executionInput(), context()), reason("invalid_execution_state"));
  assert.equal(captures.length, 0);
});

test("managed-host-style drain then disable stops a returned running task; concurrent cancel is safe", async (t) => {
  const captures = [];
  const s = await setup(t, { spawn: spawning("hang", captures), config: { execution_enabled: true } });
  let admitted;
  const admission = s.executor.start(executionInput(), context()).then((handle) => { admitted = handle; return handle; });
  await admission;
  assert.equal(admitted.status, "running");
  // The host drains start first; stop must not depend on start waiting for exit.
  const managedRun = { ...run(), executor_type: "local:installation:claude-code" };
  await Promise.all([s.executor.cancel(managedRun, context()), s.stop("disable")]);
  const cancelled = await s.executor.status(managedRun, context());
  assert.equal(cancelled.status, "cancelled", JSON.stringify(cancelled));
  assert.throws(() => process.kill(-captures[0].child.pid, 0), { code: "ESRCH" });
  await s.executor.cancel(run(), context());
  await s.stop("disable");
  await s.driver.startInstallation(s.installation, s.connectorHost);
  assert.equal((await s.executor.start(executionInput(), context())).status, "cancelled");
  assert.equal(captures.length, 1);
});

test("startup timeout cannot spawn a late CLI when slow metadata validation resumes", async (t) => {
  const captures = [];
  const s = await setup(t, { spawn: spawning("success", captures), config: { execution_enabled: true } });
  const original = fs.lstat;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  t.mock.method(fs, "lstat", async (...args) => {
    if (args[0] === s.workspace) await gate;
    return original(...args);
  });
  const pending = s.executor.start(executionInput(), context());
  await assert.rejects(() => pending, reason("startup_aborted_or_timed_out"));
  release();
  await s.stop("shutdown");
  assert.equal(captures.length, 0);
  assert.deepEqual(await fs.readdir(s.state), []);
});

test("host pin defeats recipe routing, scopes all operations and cannot access a second active installation's run", async (t) => {
  const captures = [];
  const s = await setup(t, { spawn: spawning("success", captures), config: { execution_enabled: true } });
  const stateB = path.join(s.dir, "state-b");
  const workspaceB = path.join(s.dir, "workspace-b");
  await fs.mkdir(stateB);
  await fs.mkdir(workspaceB);
  const installB = {
    ...s.driver.install({
      id: "installation-b", org_id: "org", now: "2026-01-01",
      config: { ...s.config, execution_state_dir: stateB, execution_cwd: workspaceB },
    }), updated_at: "2026-01-01",
  };
  await s.driver.startInstallation(installB, s.connectorHost);
  t.after(() => s.driver.stopInstallation(installB, s.connectorHost, {
    reason: "shutdown", signal: AbortSignal.timeout(2000),
  }));
  const ctxB = { ...context(), installation_id: "installation-b" };
  const input = executionInput();
  input.recipe.executor_config.installation_id = "installation-b";
  await s.executor.start(input, context());
  assert.equal(captures[0].options.cwd, await fs.realpath(s.workspace));
  const completed = await terminal(s);
  assert.equal(completed.status, "completed");
  await assert.rejects(() => s.executor.start(input, ctxB), reason("execution_installation_mismatch"));
  await assert.rejects(() => s.executor.status(run(), ctxB), reason("execution_installation_mismatch"));
  await assert.rejects(() => s.executor.cancel(run(), ctxB), reason("execution_installation_mismatch"));
  await assert.rejects(() => s.executor.resume({
    run: run(), recipe: input.recipe, work_item: input.work_item,
  }, ctxB), reason("execution_installation_mismatch"));
  const noPin = context();
  delete noPin.installation_id;
  for (const action of [
    () => s.executor.status(run(), noPin), () => s.executor.cancel(run(), noPin),
    () => s.executor.start(input, noPin),
    () => s.executor.resume({ run: run(), recipe: input.recipe, work_item: input.work_item }, noPin),
  ]) await assert.rejects(action, reason("host_installation_pin_required"));
  const second = executionInput("run-b");
  second.recipe.executor_config.installation_id = "installation";
  await s.executor.start(second, ctxB);
  assert.equal(captures[1].options.cwd, await fs.realpath(workspaceB));
  await terminal(s, "run-b", ctxB);
  assert.equal(captures.length, 2);
  const [file] = await fs.readdir(s.state);
  await fs.copyFile(path.join(s.state, file), path.join(stateB, file));
  const fresh = createClaudeCodeIntegration({ spawn() { throw new Error("never restart"); } });
  await fresh.driver.startInstallation(s.installation, s.connectorHost);
  await fresh.driver.startInstallation(installB, s.connectorHost);
  await assert.rejects(() => fresh.executor.status(run(), ctxB), reason("execution_installation_mismatch"));
  await assert.rejects(() => fresh.executor.cancel(run(), ctxB), reason("execution_installation_mismatch"));
  await assert.rejects(() => fresh.executor.start(executionInput(), ctxB), reason("execution_installation_mismatch"));
  assert.equal((await fresh.executor.status(run(), context())).status, "completed");
  for (const installation of [s.installation, installB]) await fresh.driver.stopInstallation(installation, s.connectorHost, {
    reason: "shutdown", signal: AbortSignal.timeout(2000),
  });
});

test("reconfigure never restarts an old run and stale executor config cannot reopen its activation", async (t) => {
  const captures = [];
  const s = await setup(t, { spawn: spawning("success", captures), config: { execution_enabled: true } });
  await s.executor.start(executionInput(), context());
  await terminal(s);
  await s.stop("reconfigure");
  const changed = {
    ...s.installation, config: { ...s.installation.config, timeout_ms: 5000 },
  };
  await s.driver.startInstallation(changed, s.connectorHost);
  await assert.rejects(() => s.executor.start(executionInput(), context()), reason("run_id_conflict"));
  await assert.rejects(() => s.driver.resolveStreams(s.installation, s.connectorHost, {}), reason("installation_requires_reconfigure"));
  assert.equal((await s.executor.status(run(), context())).status, "completed");
  assert.equal(captures.length, 1);
});

test("turning execution off revokes execute metadata and cannot start another task", async (t) => {
  const captures = [];
  const s = await setup(t, { spawn: spawning("hang", captures), config: { execution_enabled: true } });
  await s.executor.start(executionInput(), context());
  await s.stop("reconfigure");
  const readonly = {
    ...s.installation, config: { ...s.installation.config, execution_enabled: false },
  };
  await s.driver.startInstallation(readonly, s.connectorHost);
  assert.equal(s.driver.capabilities(readonly).execute, false);
  assert.equal(s.driver.capabilities(readonly).sync, true);
  await assert.rejects(() => s.executor.start(executionInput("next"), context()), reason("execution_not_enabled"));
  assert.equal(captures.length, 1);
});

test("terminal cache eviction permits more than 1000 tasks without losing durable deduplication", async (t) => {
  let spawned = 0;
  const s = await setup(t, {
    config: { execution_enabled: true },
    spawn() {
      spawned++;
      const child = new EventEmitter();
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.stdin.on("finish", () => {
        child.stdout.write(JSON.stringify({
          type: "result", subtype: "success", is_error: false,
          result: "Synthetic cached result.", permission_denials: [],
        }) + "\n");
        child.emit("close", 0);
      });
      return child;
    },
  });
  for (let index = 0; index < 1002; index++) {
    const id = `cache-${index}`;
    await s.executor.start(executionInput(id), context());
    for (;;) {
      const handle = await s.executor.status(run(id), context());
      if (handle.status !== "running") {
        assert.equal(handle.status, "completed");
        break;
      }
      await new Promise((resolve) => setImmediate(resolve));
    }
  }
  assert.equal(spawned, 1002);
  const oldest = await s.executor.status(run("cache-0"), context());
  assert.equal(oldest.status, "completed");
  assert.equal(oldest.result, undefined);
  assert.equal((await s.executor.start(executionInput("cache-0"), context())).status, "completed");
  assert.equal(spawned, 1002);
  await assert.rejects(() => s.executor.start(
    executionInput("cache-0", { evidence_text: "Changed evicted task" }), context(),
  ), reason("run_id_conflict"));
});
