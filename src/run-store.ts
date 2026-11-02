import { constants } from "node:fs";
import { open, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { WorkRunStatus } from "@regenic/connector-contract";
import { checkedPath } from "./filesystem";
import { fail, filesystemError } from "./errors";

export interface StoredRun {
  version: 1;
  identity: string;
  fingerprint: string;
  installation: string;
  status: WorkRunStatus;
}

export class RunStore {
  constructor(readonly root: string, readonly key: string, readonly installation: string) {}

  private name() { return `${this.key}.json`; }

  async read(): Promise<StoredRun | undefined> {
    await checkedPath(this.root, []);
    let handle;
    try {
      const file = await checkedPath(this.root, [this.name()]);
      handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 4096) fail("invalid_execution_state");
      const value: unknown = JSON.parse(await handle.readFile("utf8"));
      if (!value || typeof value !== "object") fail("invalid_execution_state");
      const v = value as Partial<StoredRun>;
      if (v.version !== 1 || v.identity !== this.key || typeof v.fingerprint !== "string" ||
          typeof v.installation !== "string" ||
          !["running", "completed", "failed", "cancelled"].includes(v.status ?? "")) {
        fail("invalid_execution_state");
      }
      if (v.installation !== this.installation) fail("execution_installation_mismatch");
      return v as StoredRun;
    } catch (error) {
      if (error !== null && typeof error === "object" &&
          "reason" in error && error.reason === "source_missing") return undefined;
      if (error instanceof SyntaxError) fail("invalid_execution_state");
      return filesystemError(error);
    } finally {
      await handle?.close();
    }
  }

  async claim(fingerprint: string): Promise<boolean> {
    let handle;
    try {
      const root = await checkedPath(this.root, []);
      handle = await open(path.join(root, this.name()), "wx", 0o600);
      await handle.writeFile(JSON.stringify({
        version: 1, identity: this.key, installation: this.installation, fingerprint, status: "running",
      } satisfies StoredRun));
      await handle.sync();
      return true;
    } catch (error) {
      if (error !== null && typeof error === "object" && "code" in error && error.code === "EEXIST") return false;
      return filesystemError(error);
    } finally {
      await handle?.close();
    }
  }

  async finish(fingerprint: string, status: WorkRunStatus): Promise<void> {
    const root = await checkedPath(this.root, []);
    const temporary = path.join(root, `${this.key}.${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await open(temporary, "wx", 0o600);
      await handle.writeFile(JSON.stringify({
        version: 1, identity: this.key, installation: this.installation, fingerprint, status,
      } satisfies StoredRun));
      await handle.sync();
      await handle.close();
      handle = undefined;
      await checkedPath(this.root, [this.name()]);
      await rename(temporary, path.join(root, this.name()));
    } catch (error) {
      filesystemError(error);
    } finally {
      await handle?.close();
      try {
        await unlink(temporary);
      } catch (error) {
        if (!(error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
          filesystemError(error);
        }
      }
    }
  }
}
