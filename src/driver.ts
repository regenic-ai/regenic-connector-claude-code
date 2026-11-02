import { definePlugin } from "@regenic/plugin-host";
import {
  CONNECTOR_PROTOCOL,
  type ChannelDriver, type ConnectorHost, type ConnectorInstallation, type ConnectorStream,
} from "@regenic/connector-contract";
import { FORMAT, parseConfig, SOURCE, streamKey, target } from "./config";
import { bounded, checkAbort, fail } from "./errors";
import { checkedPath } from "./filesystem";
import { ClaudeCodePollConnector } from "./poll";
import { Activation, Runtime } from "./runtime";

async function mount(
  activation: Activation, session: string, host: ConnectorHost,
): Promise<ConnectorStream> {
  const config = activation.config;
  const stream_key = streamKey(config, session);
  let pending = activation.streams.get(stream_key);
  if (!pending) {
    pending = activation.run(async () => {
      const handle = await host.plugin(definePlugin({
        name: `claude-code:${stream_key}`,
        inject: ["connectors"],
        apply(ctx) {
          activation.assert();
          ctx.effect(() => ctx.get("connectors").register(
            activation.installation.id,
            new ClaudeCodePollConnector(
              config, session, activation.installation.id,
              activation.installation.org_id, activation, () => host.now(),
            ),
            { stream_key, thread_id: `${SOURCE}:${target(config, session)}`, label: session },
          ));
        },
      }));
      if (activation.controller.signal.aborted) {
        await handle.dispose();
        fail("installation_stopped");
      }
      activation.handles.set(stream_key, handle);
      await handle.ready();
    });
    activation.streams.set(stream_key, pending);
    pending.catch(() => activation.streams.delete(stream_key));
  }
  await pending;
  activation.assert();
  const stream = host.get("connectors").getStream(activation.installation.id, stream_key);
  if (!stream) fail("connector_mount_failed");
  return stream;
}

export function createDriver(runtime: Runtime): ChannelDriver {
  function selected(installation: ConnectorInstallation, value: string): string | undefined {
    const config = parseConfig(installation.config);
    return config.sessions.find((session) => target(config, session) === value);
  }

  async function stop(installation: ConnectorInstallation, signal: AbortSignal) {
    const key = runtime.key(installation);
    const starting = runtime.starts.get(key);
    if (starting) {
      starting.controller.abort();
      await bounded(Promise.allSettled([starting.promise]), signal);
    }
    const activation = runtime.activations.get(key);
    if (activation) await activation.stop(signal);
  }

  return {
    connector_type: SOURCE, source: SOURCE, source_mode: "poll", connector_protocol: CONNECTOR_PROTOCOL,
    install(input) {
      const config = parseConfig(input.config);
      if (!config.enabled) fail("explicit_enable_required", "invalid_config");
      return {
        id: input.id, org_id: input.org_id, connector_type: SOURCE,
        status: "enabled", created_at: input.now,
        config: {
          root: config.root, project: config.project, sessions: config.sessions,
          format: config.format, enabled: config.enabled,
          execution_enabled: config.execution_enabled, execution_cwd: config.execution_cwd,
          cli_path: config.cli_path, execution_state_dir: config.execution_state_dir,
          allowed_tools: config.tools.join(","), timeout_ms: config.timeout_ms,
        },
      };
    },
    capabilities(installation) {
      if (installation.status !== "enabled") {
        return { sync: false, reply: false, create: false, execute: false, list_title: "conversation" };
      }
      const config = parseConfig(installation.config);
      return {
        sync: config.enabled, reply: false, create: false,
        execute: config.enabled && config.execution_enabled, list_title: "conversation",
      };
    },
    matchesThread(installation, thread) {
      return installation.status === "enabled" && thread.source === SOURCE &&
        selected(installation, thread.target) !== undefined;
    },
    ownsThread(installation, thread) {
      return thread.source === SOURCE && selected(installation, thread.target) !== undefined;
    },
    async startInstallation(installation, host) {
      if (installation.status !== "enabled") fail("installation_disabled");
      const config = parseConfig(installation.config);
      if (!config.enabled) fail("explicit_enable_required", "invalid_config");
      const key = runtime.key(installation);
      const current = runtime.activations.get(key);
      if (current?.state === "active") {
        runtime.get(installation);
        return;
      }
      if (current?.state === "stopping") fail("installation_stop_incomplete");
      const admitted = runtime.starts.get(key);
      if (admitted) {
        await admitted.promise;
        runtime.get(installation);
        return;
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      const pending = (async () => {
        await checkedPath(config.root, [config.project]);
        checkAbort(controller.signal);
        runtime.activations.set(key, new Activation(config, installation, host));
      })();
      runtime.starts.set(key, { promise: pending, controller });
      pending.then(
        () => runtime.starts.delete(key),
        () => runtime.starts.delete(key),
      );
      try {
        await bounded(pending, controller.signal, "startup_aborted_or_timed_out");
      } finally {
        clearTimeout(timer);
      }
    },
    async stopInstallation(installation, _host, context) {
      await stop(installation, context.signal);
    },
    async onStoreClear(installations) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2000);
      try {
        await Promise.all(installations.map(async (installation) => {
          await stop(installation, controller.signal);
        }));
      } finally {
        clearTimeout(timer);
      }
    },
    async resolveStreams(installation, host) {
      const activation = runtime.get(installation);
      return Promise.all(activation.config.sessions.map((session) => mount(activation, session, host)));
    },
    async resolveThreadStream(installation, thread, host) {
      const activation = runtime.get(installation);
      const session = thread.source === SOURCE ? selected(installation, thread.target) : undefined;
      if (!session) fail("session_not_selected", "unsupported_channel");
      return mount(activation, session, host);
    },
    async bindSyncSource(installation) {
      const activation = runtime.get(installation);
      return {
        listDirectory(cursor) {
          return activation.run(async (signal) => {
            const config = activation.config;
            const signature = activation.fingerprint.slice(0, 20);
            let offset = 0;
            if (cursor !== null) {
              const match = new RegExp(`^${signature}:([0-9]+)$`).exec(cursor);
              if (!match) fail("invalid_directory_cursor");
              offset = Number(match[1]);
              if (!Number.isSafeInteger(offset) || offset > config.sessions.length) fail("invalid_directory_cursor");
            }
            const sessions = config.sessions.slice(offset, offset + 100);
            for (const session of sessions) {
              checkAbort(signal);
              await checkedPath(config.root, [config.project, `${session}.jsonl`]);
            }
            const next = offset + sessions.length;
            return {
              members: sessions.map((session) => ({
                stream_key: streamKey(config, session),
                thread_id: `${SOURCE}:${target(config, session)}`, label: session, kind: "session",
              })),
              complete: next >= config.sessions.length,
              ...(next < config.sessions.length ? { next_cursor: `${signature}:${next}` } : {}),
            };
          });
        },
      };
    },
    installCatalog() {
      return {
        title: { literal: "Claude Code" },
        channel_label: { literal: "Claude Code" },
        description: { literal: "Selected local JSONL journals; optional explicitly enabled CLI task execution." },
        credential_hint: { literal: "Sync needs no credentials. Opt-in CLI tasks use the operator's Claude authentication and may incur charges." },
        fields: [
          { key: "root", label: { literal: "Absolute projects storage root" }, required: true },
          { key: "project", label: { literal: "Exact project directory name (no path decoding)" }, required: true },
          { key: "sessions", label: { literal: "Selected session UUIDs (comma-separated)" }, required: true, multiple: true },
          { key: "format", label: { literal: "Explicit internal format acknowledgement" }, required: true,
            options: [{ value: FORMAT, label: { literal: FORMAT } }] },
          { key: "enabled", label: { literal: "Enable selected journal sync" }, required: true,
            options: [{ value: "true", label: { literal: "Enable" } }] },
          { key: "execution_enabled", label: { literal: "Enable local CLI task execution (separate consent)" },
            default: "false", options: [
              { value: "false", label: { literal: "Disabled" } },
              { value: "true", label: { literal: "Enabled" } },
            ] },
          { key: "execution_cwd", label: { literal: "Absolute task workspace (not a sandbox)" } },
          { key: "cli_path", label: { literal: "Absolute installed claude executable" } },
          { key: "execution_state_dir", label: { literal: "Existing private task-state directory (outside workspace/storage)" } },
          { key: "allowed_tools", label: { literal: "Explicit tool names: Read,Glob,Grep,Edit,Write; empty removes all tools" } },
          { key: "timeout_ms", label: { literal: "Task timeout in milliseconds (100-1800000)" }, default: "120000" },
        ],
      };
    },
    async probeCatalog() { return { services: {} }; },
    async listCatalogFieldOptions() { return {}; },
    presentInstall() {
      return { label: { literal: "Claude Code" }, detail: { literal: "Explicitly selected local journals" } };
    },
  };
}
