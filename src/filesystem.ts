import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { component, UUID } from "./config";
import { checkAbort, fail, filesystemError } from "./errors";

export function contains(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) &&
    relative !== ".." && !path.isAbsolute(relative));
}

export async function checkedPath(root: string, parts: readonly string[]): Promise<string> {
  try {
    if (!path.isAbsolute(root)) fail("absolute_root_required", "invalid_config");
    const rootStat = await lstat(root);
    if (rootStat.isSymbolicLink()) fail("symlink_not_allowed");
    if (!rootStat.isDirectory()) fail("source_not_directory");
    const canonical = await realpath(root);
    let candidate = canonical;
    for (const part of parts) {
      candidate = path.join(candidate, component(part));
      const stat = await lstat(candidate);
      if (stat.isSymbolicLink()) fail("symlink_not_allowed");
    }
    if (!contains(canonical, await realpath(candidate))) fail("source_outside_root");
    return candidate;
  } catch (error) {
    filesystemError(error);
  }
}

export async function openJournal(
  root: string, project: string, session: string, signal?: AbortSignal,
): Promise<FileHandle> {
  checkAbort(signal);
  let handle: FileHandle | undefined;
  try {
    const candidate = await checkedPath(root, [project, `${session}.jsonl`]);
    handle = await open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await handle.stat();
    const current = await lstat(await checkedPath(root, [project, `${session}.jsonl`]));
    if (!stat.isFile() || stat.nlink !== 1) fail("source_not_regular_single_link_file");
    if (stat.dev !== current.dev || stat.ino !== current.ino) fail("source_replaced");
    checkAbort(signal);
    return handle;
  } catch (error) {
    if (handle) await handle.close();
    filesystemError(error);
  }
}

/** Explicit, metadata-only discovery. Does not open any transcript or project source. */
export async function discoverClaudeCode(input: {
  root: string;
  project?: string;
}): Promise<{ projects: string[]; sessions: string[] }> {
  try {
    const root = await checkedPath(input.root, []);
    if (input.project === undefined) {
      const entries = await readdir(root, { withFileTypes: true });
      if (entries.length > 10_000) fail("directory_limit_exceeded");
      if (entries.some((entry) => entry.isSymbolicLink())) fail("symlink_not_allowed");
      return {
        projects: entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort(),
        sessions: [],
      };
    }
    const directory = await checkedPath(root, [input.project]);
    const entries = await readdir(directory, { withFileTypes: true });
    if (entries.length > 10_000) fail("directory_limit_exceeded");
    const sessions: string[] = [];
    for (const entry of entries) {
      if (!entry.name.endsWith(".jsonl") || !UUID.test(entry.name.slice(0, -6))) continue;
      if (entry.isSymbolicLink()) fail("symlink_not_allowed");
      if (!entry.isFile()) fail("source_not_regular_single_link_file");
      sessions.push(entry.name.slice(0, -6));
    }
    return { projects: [input.project], sessions: sessions.sort() };
  } catch (error) {
    filesystemError(error);
  }
}
