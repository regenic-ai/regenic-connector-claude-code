import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import {
  type ExecutorContext, type ExecutorRunHandle, type ExecutorStartInput,
  type TaskExecutor, type WorkRun,
} from "@regenic/connector-contract";
import { digest, SOURCE, type Config } from "./config";
import { bounded, checkAbort, fail, filesystemError } from "./errors";
import { checkedPath, contains } from "./filesystem";
import { RunStore } from "./run-store";
import { type Activation, Runtime } from "./runtime";

export type SpawnClaude = (
  file: string, args: readonly string[], options: {
    cwd: string; env: NodeJS.ProcessEnv; detached: boolean; shell: false; stdio: "pipe";
  },
) => ChildProcessWithoutNullStreams;

const MAX_OUTPUT = 4 * 1024 * 1024;
const MAX_LINE = 1024 * 1024;
const MAX_RUNS = 1000;

interface Running {
  key: string;
  org: string;
  installation: string;
  fingerprint: string;
  handle: ExecutorRunHandle;
  done: Promise<void>;
  stop: () => Promise<void>;
  snapshot: () => ExecutorRunHandle;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function cliEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const keys = [
    "PATH", "HOME", "USERPROFILE", "TMPDIR", "TEMP", "SystemRoot",
    "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN",
  ];
  return Object.fromEntries(keys.flatMap((key) => env[key] === undefined ? [] : [[key, env[key]]]));
}

export function claudeArguments(config: Config): string[] {
  const args = [
    "-p", "--output-format", "stream-json", "--verbose",
    "--permission-mode", "default",
    "--tools", config.tools.join(","),
    "--disallowedTools", "mcp__*",
    "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
    "--setting-sources", "",
    "--settings", '{"disableAllHooks":true}',
    "--disable-slash-commands", "--no-session-persistence",
    "--max-turns", "10",
  ];
  if (config.tools.length) args.push("--allowedTools", config.tools.join(","));
  return args;
}

async function validateExecution(config: Config): Promise<string> {
  if (process.platform === "win32") fail("execution_requires_posix", "invalid_config");
  try {
    const cwd = await checkedPath(config.execution_cwd, []);
    const state = await checkedPath(config.execution_state_dir, []);
    const source = await checkedPath(config.root, []);
    if (contains(source, cwd) || contains(cwd, source) ||
        contains(source, state) || contains(state, source) ||
        contains(cwd, state) || contains(state, cwd)) {
      fail("execution_directories_must_be_disjoint", "invalid_config");
    }
    const binary = await lstat(config.cli_path);
    // Operator-selected executable symlinks (e.g. npm bin links) are intentional.
    if (!binary.isFile() && !binary.isSymbolicLink()) fail("invalid_cli_executable", "invalid_config");
    await realpath(config.cli_path);
    return cwd;
  } catch (error) {
    filesystemError(error);
  }
}

export function createTaskExecutor(
  runtime: Runtime,
  spawnClaude: SpawnClaude = (file, args, options) => spawn(file, [...args], options),
): TaskExecutor {
  const runs = new Map<string, Running>();
  const completed = new Set<string>();
  const admissions = new Map<string, {
    installation: string;
    fingerprint: string;
    promise: Promise<ExecutorRunHandle>;
  }>();

  function identity(org: string, id: string): string {
    return digest(`${org}\0${id}`);
  }

  function pin(ctx: ExecutorContext): string {
    if (!ctx.installation_id) fail("host_installation_pin_required", "invalid_config");
    return ctx.installation_id;
  }

  function assertRun(run: WorkRun, ctx: ExecutorContext): string {
    pin(ctx);
    if (run.org_id !== ctx.org_id) fail("execution_identity_mismatch");
    const key = identity(ctx.org_id, run.id);
    if (run.external_run_id && run.external_run_id !== `claude-code-run:${key}`) fail("execution_identity_mismatch");
    return key;
  }

  async function recovered(run: WorkRun, ctx: ExecutorContext): Promise<ExecutorRunHandle> {
    const key = assertRun(run, ctx);
    const installationId = pin(ctx);
    const current = runs.get(key);
    if (current) {
      if (current.installation !== installationId) fail("execution_installation_mismatch");
      return current.snapshot();
    }
    const activation = runtime.activations.get(`${ctx.org_id}\0${installationId}`);
    if (!activation) fail("installation_not_started");
    if (!activation.config.execution_enabled) fail("execution_not_enabled", "invalid_config");
    const stored = await new RunStore(activation.config.execution_state_dir, key, installationId).read();
    if (stored) {
      if (stored.status === "running") fail("execution_state_unknown_no_automatic_restart");
      return { external_run_id: `claude-code-run:${key}`, status: stored.status };
    }
    fail("execution_state_unknown_no_automatic_restart");
  }

  async function start(input: ExecutorStartInput, ctx: ExecutorContext): Promise<ExecutorRunHandle> {
    if (!input.run_id || input.run_id.length > 200) fail("durable_run_id_required", "invalid_config");
    const installationId = pin(ctx);
    const activation = runtime.forExecution(ctx.org_id, installationId);
    const key = identity(ctx.org_id, input.run_id);
    const config = activation.config;
    const prompt = input.recipe.executor_config.prompt;
    if (prompt !== undefined && typeof prompt !== "string") fail("invalid_executor_prompt", "invalid_config");
    const text = [prompt, input.evidence_text].filter(Boolean).join("\n\n");
    if (!text || Buffer.byteLength(text) > MAX_LINE) fail("invalid_executor_input", "invalid_config");
    const fingerprint = digest(JSON.stringify([activation.installation.id, config, text]));
    const existing = runs.get(key);
    if (existing) {
      if (existing.installation !== installationId) fail("execution_installation_mismatch");
      if (existing.fingerprint !== fingerprint) fail("run_id_conflict", "invalid_config");
      return existing.snapshot();
    }
    const admission = admissions.get(key);
    if (admission) {
      if (admission.installation !== installationId) fail("execution_installation_mismatch");
      if (admission.fingerprint !== fingerprint) fail("run_id_conflict", "invalid_config");
      return bounded(admission.promise, AbortSignal.timeout(5000), "startup_aborted_or_timed_out");
    }
    while (runs.size + admissions.size >= MAX_RUNS && completed.size) {
      const oldest = completed.values().next().value;
      if (oldest === undefined) break;
      completed.delete(oldest);
      runs.delete(oldest);
    }
    if (runs.size + admissions.size >= MAX_RUNS) fail("execution_run_limit_exceeded");
    const startup = new AbortController();
    const timer = setTimeout(() => startup.abort(), 5000);
    const activationAbort = () => startup.abort();
    activation.controller.signal.addEventListener("abort", activationAbort, { once: true });
    const pending = activation.run(async () => {
      const signal = startup.signal;
      const cwd = await validateExecution(config);
      checkAbort(signal);
      const store = new RunStore(config.execution_state_dir, key, installationId);
      if (!await store.claim(fingerprint)) {
        const stored = await store.read();
        if (!stored || stored.fingerprint !== fingerprint) fail("run_id_conflict", "invalid_config");
        if (stored.status === "running") fail("execution_state_unknown_no_automatic_restart");
        return { external_run_id: `claude-code-run:${key}`, status: stored.status };
      }
      if (signal.aborted) {
        await store.finish(fingerprint, "cancelled");
        checkAbort(signal);
      }
      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawnClaude(config.cli_path, claudeArguments(config), {
          cwd, env: cliEnvironment(ctx.env), detached: true, shell: false, stdio: "pipe",
        });
      } catch {
        await store.finish(fingerprint, "failed");
        fail("cli_spawn_failed");
      }
      const running = supervise(child, key, fingerprint, activation, store, config.timeout_ms);
      runs.set(key, running);
      running.done.then(
        () => completed.add(key),
        () => undefined,
      );
      child.stdin.end(text);
      return running.snapshot();
    });
    admissions.set(key, { installation: installationId, fingerprint, promise: pending });
    pending.then(
      () => admissions.delete(key),
      () => admissions.delete(key),
    );
    try {
      return await bounded(pending, startup.signal, "startup_aborted_or_timed_out");
    } finally {
      clearTimeout(timer);
      activation.controller.signal.removeEventListener("abort", activationAbort);
    }
  }

  return {
    executor_type: SOURCE,
    capabilities() {
      return { start: true, resume: true, status: true, prompts: false, local_workspace: false, wait: false };
    },
    catalog() {
      return {
        executor_type: SOURCE, source: SOURCE, attach: "absentee",
        label: { literal: "Claude Code" },
        description: { literal: "Opt-in local CLI tasks. No automatic permission escalation or restart." },
        fields: [
          { key: "prompt", label: { literal: "Task instruction" }, kind: "textarea" },
        ],
      };
    },
    start,
    async status(run, ctx) { return recovered(run, ctx); },
    async resume(input, ctx) {
      if (input.answer) fail("interactive_approval_not_supported", "unsupported_channel");
      return recovered(input.run, ctx);
    },
    async cancel(run, ctx) {
      const key = assertRun(run, ctx);
      const current = runs.get(key);
      if (!current) {
        const handle = await recovered(run, ctx);
        if (handle.status === "completed" || handle.status === "failed" || handle.status === "cancelled") return;
        fail("execution_state_unknown_no_automatic_restart");
      }
      if (current.installation !== pin(ctx)) fail("execution_installation_mismatch");
      await current.stop();
    },
  };
}

function supervise(
  child: ChildProcessWithoutNullStreams, key: string, fingerprint: string,
  activation: Activation, store: RunStore, timeout: number,
): Running {
  const handle: ExecutorRunHandle = { external_run_id: `claude-code-run:${key}`, status: "running" };
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const done = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  // Completion failures are surfaced on status/cancel/stop, never as unhandled rejections.
  void done.catch(() => undefined);
  let persistenceError: unknown;
  let finished = false;
  let closed = false;
  let stopping = false;
  let signalFailure = false;
  let failure: string | undefined;
  let terminal: { ok: boolean; text?: string; denied: boolean } | undefined;
  let buffer = Buffer.alloc(0);
  let outputBytes = 0;
  let killTimer: ReturnType<typeof setTimeout> | undefined;

  function group(signal: NodeJS.Signals) {
    if (!child.pid) return;
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if (!(error !== null && typeof error === "object" && "code" in error && error.code === "ESRCH")) {
        // A newly spawned POSIX group can reject TERM before exec completes.
        // Escalation plus exit confirmation, not signal delivery, decides cleanup.
        signalFailure = true;
      }

    }
  }

  async function confirmGroupStopped() {
    if (!child.pid) return;
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        process.kill(-child.pid, 0);
      } catch (error) {
        if (error !== null && typeof error === "object" && "code" in error && error.code === "ESRCH") return;
        fail("process_tree_stop_unconfirmed");
      }
      await new Promise<void>((yes) => setTimeout(yes, 10));
    }
    fail("process_tree_stop_unconfirmed");
  }

  function stopWith(reason?: string) {
    if (finished || closed) return;
    if (reason) failure ??= reason;
    stopping = true;
    group("SIGTERM");
    if (!killTimer) killTimer = setTimeout(() => group("SIGKILL"), 200);
  }

  function frame(line: Buffer) {
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line));
    } catch {
      stopWith("invalid_cli_stream");
      return;
    }
    const event = object(value);
    if (!event || typeof event.type !== "string") {
      stopWith("invalid_cli_stream");
      return;
    }
    if (event.type === "assistant") {
      const message = object(event.message);
      if (!message || !Array.isArray(message.content)) return stopWith("invalid_cli_stream");
      const text = message.content.flatMap((item) => {
        const block = object(item);
        return block?.type === "text" && typeof block.text === "string" ? [block.text] : [];
      }).join("\n");
      if (text) handle.transcript = { kind: "assistant", activity: "working", text };
    } else if (event.type === "result") {
      if (terminal || typeof event.subtype !== "string" || typeof event.is_error !== "boolean" ||
          !Array.isArray(event.permission_denials)) return stopWith("invalid_cli_result");
      terminal = {
        ok: event.subtype === "success" && event.is_error === false,
        text: typeof event.result === "string" ? event.result : undefined,
        denied: event.permission_denials.length > 0,
      };
      if (terminal.ok && terminal.text === undefined) stopWith("invalid_cli_result");
    }
  }

  child.stdout.on("data", (chunk: Buffer) => {
    if (closed || finished || stopping) return;
    outputBytes += chunk.length;
    if (outputBytes > MAX_OUTPUT) return stopWith("cli_output_limit_exceeded");
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const end = buffer.indexOf(10);
      if (end < 0) break;
      if (end > MAX_LINE) return stopWith("cli_line_limit_exceeded");
      const line = buffer.subarray(0, end);
      buffer = buffer.subarray(end + 1);
      if (line.length) frame(line);
    }
    if (buffer.length > MAX_LINE) stopWith("cli_line_limit_exceeded");
  });
  child.stderr.on("data", (chunk: Buffer) => {
    if (closed || finished || stopping) return;
    outputBytes += chunk.length;
    if (outputBytes > MAX_OUTPUT) stopWith("cli_output_limit_exceeded");
  });
  child.stdin.on("error", () => { if (!stopping) stopWith("cli_stdin_failed"); });
  child.stdout.on("error", () => { if (!stopping) stopWith("cli_stdout_failed"); });
  child.stderr.on("error", () => { if (!stopping) stopWith("cli_stderr_failed"); });
  child.on("error", () => { if (!stopping) stopWith("cli_spawn_failed"); });

  const timer = setTimeout(() => stopWith("execution_timeout"), timeout);
  const abort = () => stopWith();
  activation.controller.signal.addEventListener("abort", abort, { once: true });

  const stop = async () => {
    if (!finished) stopWith();
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        done,
        new Promise<never>((_resolve, no) => {
          deadline = setTimeout(() => {
            try {
              fail(signalFailure ? "process_tree_signal_failed" : "process_tree_stop_unconfirmed");
            } catch (error) { no(error); }
          }, 2000);
        }),
      ]);
    } finally {
      if (deadline) clearTimeout(deadline);
    }
    if (persistenceError) throw persistenceError;
  };
  activation.executions.add(stop);

  child.once("close", async (code) => {
    closed = true;
    clearTimeout(timer);
    if (killTimer) clearTimeout(killTimer);
    // The CLI can exit before a grandchild; clean the owned process group too.
    group("SIGKILL");
    activation.controller.signal.removeEventListener("abort", abort);
    if (buffer.length && !stopping) failure ??= "incomplete_cli_stream";
    if (terminal?.denied) failure ??= "permission_denied";
    const settled: ExecutorRunHandle = { external_run_id: handle.external_run_id, status: failure ? "failed" : stopping ? "cancelled" :
      code === 0 && terminal?.ok ? "completed" : "failed",
    };
    if (settled.status === "completed") {
      settled.result = { summary: terminal!.text! };
      settled.transcript = { kind: "assistant", text: terminal!.text!, turn: { state: "ended", ok: true } };
    } else {
      const reason = failure ?? (stopping ? "execution_cancelled" : code === 0 ? "cli_result_missing_or_failed" : "cli_exit_failed");
      settled.result = { summary: `Claude Code: ${reason}` };
      settled.transcript = { kind: "system", text: `Claude Code: ${reason}`, turn: { state: "ended", ok: false } };
    }
    try {
      await confirmGroupStopped();
      await store.finish(fingerprint, settled.status);
      Object.assign(handle, settled);
      finished = true;
      activation.executions.delete(stop);
      resolve();
    } catch (error) {
      persistenceError = error;
      handle.status = "failed";
      handle.result = { summary: "Claude Code: execution_cleanup_or_state_write_failed" };
      reject(error);
    }
  });
  return {
    key, org: activation.installation.org_id, installation: activation.installation.id,
    fingerprint, handle, done, stop,
    snapshot() {
      if (persistenceError) throw persistenceError;
      return structuredClone(handle);
    },
  };
}
