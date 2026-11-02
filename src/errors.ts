import { ChannelDriverError } from "@regenic/connector-contract";

export function fail(reason: string, code: ChannelDriverError["code"] = "sync_failed"): never {
  throw new ChannelDriverError(code, `Claude Code: ${reason}`, reason);
}

export function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) fail("operation_aborted");
}

export function filesystemError(error: unknown): never {
  if (error instanceof ChannelDriverError) throw error;
  const code = error !== null && typeof error === "object" && "code" in error
    ? String(error.code) : "";
  const reasons: Record<string, string> = {
    ENOENT: "source_missing",
    EACCES: "source_permission_denied",
    EPERM: "source_permission_denied",
    ELOOP: "symlink_not_allowed",
    ENOTDIR: "source_not_directory",
  };
  fail(reasons[code] ?? "source_io_error");
}

export async function bounded<T>(
  pending: Promise<T>, signal: AbortSignal, reason = "stop_aborted",
): Promise<T> {
  checkAbort(signal);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new ChannelDriverError(
      "sync_failed", `Claude Code: ${reason}`, reason,
    ));
    signal.addEventListener("abort", abort, { once: true });
    pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
