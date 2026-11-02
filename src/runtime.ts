import type { ConnectorHost, ConnectorInstallation } from "@regenic/connector-contract";
import type { PluginHandle } from "@regenic/plugin-host";
import { digest, parseConfig, type Config } from "./config";
import { bounded, checkAbort, fail } from "./errors";
import type { PollRuntime } from "./poll";

export class Activation implements PollRuntime {
  readonly controller = new AbortController();
  readonly inflight = new Set<Promise<unknown>>();
  readonly handles = new Map<string, PluginHandle>();
  readonly streams = new Map<string, Promise<void>>();
  readonly executions = new Set<() => Promise<void>>();
  readonly fingerprint: string;
  state: "active" | "stopping" | "stopped" = "active";

  constructor(
    readonly config: Config,
    readonly installation: ConnectorInstallation,
    readonly host: ConnectorHost,
  ) {
    this.fingerprint = digest(JSON.stringify(config));
  }

  assert(): void {
    if (this.state !== "active") fail("installation_stopped");
    checkAbort(this.controller.signal);
  }

  run<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    this.assert();
    const pending = Promise.resolve().then(async () => {
      this.assert();
      const value = await work(this.controller.signal);
      this.assert();
      return value;
    });
    this.inflight.add(pending);
    pending.then(
      () => this.inflight.delete(pending),
      () => this.inflight.delete(pending),
    );
    return pending;
  }

  async stop(signal: AbortSignal): Promise<void> {
    if (this.state === "stopped") return;
    this.state = "stopping";
    this.controller.abort();
    // Admission is fenced before awaiting mounts, polls, or child-process cleanup.
    const drain = async () => {
      const executions = await Promise.allSettled([...this.executions].map((stop) => stop()));
      await Promise.allSettled([...this.inflight]);
      const handles = await Promise.allSettled([...this.handles.values()].map((h) => h.dispose()));
      for (const result of [...executions, ...handles]) {
        if (result.status === "rejected") throw result.reason;
      }
      this.handles.clear();
      this.streams.clear();
    };
    await bounded(drain(), signal);
    this.state = "stopped";
  }
}

export class Runtime {
  readonly activations = new Map<string, Activation>();
  readonly starts = new Map<string, { promise: Promise<void>; controller: AbortController }>();

  key(installation: Pick<ConnectorInstallation, "id" | "org_id">): string {
    return `${installation.org_id}\0${installation.id}`;
  }

  get(installation: ConnectorInstallation): Activation {
    const current = this.activations.get(this.key(installation));
    if (!current) fail("installation_not_started");
    current.assert();
    if (installation.status !== "enabled" ||
        digest(JSON.stringify(parseConfig(installation.config))) !== current.fingerprint) {
      fail("installation_requires_reconfigure");
    }
    return current;
  }

  forExecution(orgId: string, installationId: string): Activation {
    const current = this.activations.get(`${orgId}\0${installationId}`);
    if (!current) fail("installation_not_started", "invalid_config");
    current.assert();
    if (!current.config.execution_enabled) fail("execution_not_enabled", "invalid_config");
    return current;
  }
}
