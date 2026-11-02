import path from "node:path";
import { createHash } from "node:crypto";
import { fail } from "./errors";

export const SOURCE = "claude-code";
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const TOOLS = ["Read", "Glob", "Grep", "Edit", "Write"] as const;
export const FORMAT = "claude-code-jsonl-v1";

export interface Config {
  root: string;
  project: string;
  sessions: string[];
  format: string;
  enabled: boolean;
  execution_enabled: boolean;
  execution_cwd: string;
  cli_path: string;
  execution_state_dir: string;
  tools: string[];
  timeout_ms: number;
}

export function digest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function component(value: string): string {
  if (!value || value === "." || value === ".." || /[/\\\0]/.test(value)) {
    fail("invalid_project", "invalid_config");
  }
  return value;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function bool(value: unknown): boolean {
  if (value === true || value === "true") return true;
  if (value === undefined || value === false || value === "false") return false;
  fail("invalid_boolean", "invalid_config");
}

export function parseConfig(input: Record<string, unknown>): Config {
  const root = text(input.root);
  if (!root || !path.isAbsolute(root) || root.includes("\0")) fail("absolute_root_required", "invalid_config");
  const project = component(text(input.project));
  const raw = input.sessions;
  const sessions = [...new Set(
    (Array.isArray(raw) ? raw : text(raw).split(",")).map((s) => text(s)),
  )];
  if (!sessions.length || sessions.length > 1000 || sessions.some((s) => !UUID.test(s))) {
    fail("explicit_sessions_required", "invalid_config");
  }
  if (new Set(sessions.map((s) => s.toLowerCase())).size !== sessions.length) {
    fail("duplicate_session_identity", "invalid_config");
  }
  if (input.format !== FORMAT) fail("explicit_format_required", "invalid_config");
  if (input.allowed_tools !== undefined && typeof input.allowed_tools !== "string") {
    fail("invalid_tool_selection", "invalid_config");
  }
  const tools = text(input.allowed_tools).split(",").map((s) => s.trim()).filter(Boolean);
  if (tools.some((tool) => !TOOLS.some((allowed) => allowed === tool))) {
    fail("unsupported_tool", "invalid_config");
  }
  const execution_enabled = bool(input.execution_enabled);
  const execution_cwd = text(input.execution_cwd);
  const cli_path = text(input.cli_path);
  const execution_state_dir = text(input.execution_state_dir);
  if (execution_enabled && (
    !path.isAbsolute(execution_cwd) || !path.isAbsolute(cli_path) ||
    !path.isAbsolute(execution_state_dir) || execution_state_dir.includes("\0") ||
    execution_cwd.includes("\0") || cli_path.includes("\0")
  )) fail("explicit_execution_paths_required", "invalid_config");
  const timeout_ms = input.timeout_ms === undefined ? 120_000 : Number(input.timeout_ms);
  if (!Number.isInteger(timeout_ms) || timeout_ms < 100 || timeout_ms > 1_800_000) {
    fail("invalid_timeout", "invalid_config");
  }
  return {
    root: path.resolve(root), project, sessions, format: FORMAT,
    enabled: bool(input.enabled), execution_enabled,
    execution_cwd, cli_path, execution_state_dir, tools: [...new Set(tools)], timeout_ms,
  };
}

export function target(config: Config, session: string): string {
  return `${digest(config.project).slice(0, 20)}:${session.toLowerCase()}`;
}

export function streamKey(config: Config, session: string): string {
  return `session:${target(config, session)}`;
}
