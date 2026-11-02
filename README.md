# Claude Code connector

An external Regenic plugin for explicitly selected local Claude Code journals and separately opted-in local Agent tasks. Not a built-in connector. Journal sync needs no credentials, Claude SDK, or running Agent. Execution uses an operator-installed, authenticated official `claude` CLI and may incur charges.

[简体中文](README.zh-CN.md)

## Install and select data

Requires Node.js >=20 and Regenic connector protocol `1.0`. Task execution additionally requires the public host installation pin and `ChannelCapabilities.execute` introduced in `@regenic/connector-contract@0.3.0`, and a matching Regenic host; `0.2.0` cannot safely provide this binding. `@regenic/plugin-host@0.1.0` is published. Contract `0.3.0` is currently a release candidate, not an available registry release: registry-based installation remains blocked until it is published. Do not silently downgrade the contract or fabricate a lockfile resolution. The following registry workflow applies after that release:

```sh
npm install
npm run build
npm pack
npm install --prefix /absolute/regenic-claude-plugin /absolute/regenic-connector-claude-code-0.1.0.tgz
```

Launch Regenic with `REGENIC_CHANNEL_PLUGIN` pointing to
`/absolute/regenic-claude-plugin/node_modules/@regenic/connector-claude-code`.
This is core's external plugin entry point; no local core checkout is needed.
The package synchronously loads with `require()`. Its manifest contributes the named `claudeCodeDriver` and `claudeCodeTaskExecutor` exports.

Catalog, probe, options, module loading, and install-config validation neither read transcript bodies nor execute a CLI. No default root, environment-based discovery, recursive background scan, or automatic collection. Explicit metadata-only discovery is available when the operator chooses to call it:

```js
const { discoverClaudeCode } = require("@regenic/connector-claude-code");
await discoverClaudeCode({ root: "/chosen/claude/projects" });
await discoverClaudeCode({
  root: "/chosen/claude/projects",
  project: "-exact-storage-directory-name",
});
```

Discovery lists immediate project directory names or direct session UUID filenames, not summaries or prompts. It does not open transcripts, source projects, or subagent directories. Maximum 10000 direct entries. `root` is the storage directory containing project directories, **not** a code workspace. Project names are opaque: the plugin never decodes them into paths. Claude normally uses a `projects/` directory beneath its configuration directory; this plugin neither assumes that configuration directory nor reads configuration to locate it.

Supply these fields through the Regenic installation card or `driver.install().config`:

```json
{
  "root": "/chosen/claude/projects",
  "project": "-exact-storage-directory-name",
  "sessions": "11111111-1111-4111-8111-111111111111",
  "format": "claude-code-jsonl-v1",
  "enabled": true,
  "execution_enabled": false
}
```

`sessions` accepts comma-separated UUIDs or an array of strings (maximum 1000).
Only after explicit configuration and enablement may the host call `startInstallation`, `bindSyncSource` / `resolveStreams`, then poll. Directory pages contain up to 100 selected sessions; record pages up to 200 records. Scheduling belongs to the host; there are no watchers or internal sync timers.

## Verified source and sync semantics

Local JSONL is an **unstable internal format**, not a stable Claude export/API:

- [Official MIT Python session reader, pinned revision](https://github.com/anthropics/claude-agent-sdk-python/blob/2146f9d8985513053e904b13200c8f744b36785a/src/claude_agent_sdk/_internal/sessions.py).
- [Official synthetic session-reader tests](https://github.com/anthropics/claude-agent-sdk-python/blob/2146f9d8985513053e904b13200c8f744b36785a/tests/test_sessions.py).
- [Bundled CLI version at that revision: 2.1.316](https://github.com/anthropics/claude-agent-sdk-python/blob/2146f9d8985513053e904b13200c8f744b36785a/src/claude_agent_sdk/_cli_version.py). This identifies the evidence, **not** a live CLI compatibility test.
- Official npm `@anthropic-ai/claude-agent-sdk@0.3.316`, public `sdk.d.ts`, declares `listSessions` and `getSessionMessages`. Those APIs include cross-project/worktree lookup, expose `message: unknown`, and omit original entry timestamps. This plugin does not depend on or execute that SDK.

`claude-code-jsonl-v1` is this plugin's identifier for its verified field subset, not an upstream schema guarantee. New versions require format verification; unfamiliar entry/block shapes fail explicitly.

Sync is an **append-journal timeline**, not the official reader's current active `parentUuid` branch and not complete history. Old branches present in a journal can remain visible; journal speech is not evidence that an Agent task exited:

| Journal data | Mapping |
|---|---|
| User/assistant text | Regenic message with original timestamp; user outbound, assistant inbound |
| Distinct assistant UUID fragments sharing `message.id` | Separate stable records; valid fragments are not wrongly collapsed |
| Tool use/result | System `thread_status` request/completion/failure markers; hashed correlation ID, no arguments or result bodies |
| `compact_boundary` | System marker; never follow `logicalParentUuid` |
| `isCompactSummary`, `isMeta`, sidechains, team entries | Excluded, avoiding duplicate summaries and metadata/subagent contamination |
| Thinking, images, documents | Not imported/downloaded |
| Known metadata envelopes | Ignored, never user messages |
| Unknown entry/content types, malformed completed lines, missing required fields | Typed errors, not success-shaped empty pages |

No source/attachment reads, path following from messages or tool arguments, subagent directory scans, credential/configuration reads, or source writes/deletes/locks. Tool-result bodies are omitted even when embedded in the journal. Disabling/deleting/clearing stops local collection, never logs out or deletes Claude data.

History pages start at byte zero, then the same cursor tails appended data. Persist the returned cursor to resume after plugin-process restart. It contains file identity, committed offset and prefix SHA-256, not message bodies or source paths. Stable external IDs use project key, session UUID, entry UUID and block position. Regenic's source-identity deduplication handles cross-page/retry replay; a batch never repeats an identity. No edit/tombstone propagation.

A partial last line, including split UTF-8, waits for its newline without advancing or requesting a busy catch-up loop. Truncation, rotation/replacement and committed-prefix rewrites explicitly require a cursor reset; **nothing automatically skips or reimports data**. After inspecting the source, the operator can reset the affected host cursor and replay from the beginning with the same stable IDs. Missing files, permissions, invalid UTF-8 and unsupported shapes are explicit redacted errors. Errors/logs never include original paths, source text, stderr, or tokens. Opted-in message bodies may themselves contain sensitive user content: this is not a content sanitizer.

Limits: 128 MiB/file, 1 MiB/line, 2 MiB read window, 200 records/page. Prefix verification costs linear I/O in committed history. Only sequential history/incremental polls are supported; `older` / `latest` / before-window requests fail explicitly. The driver does not advertise hydrate-on-open.

Path boundary: root itself, child project and journal must not be symlinks; journals must be regular single-hardlink files. Traversal/separators and out-of-root links are rejected. OS-level ancestors of the explicit root may be resolved (for example macOS temporary-directory aliases). Opens are read-only/no-follow/non-blocking and check identity/real paths. This is not an OS sandbox against hostile concurrent ancestor-directory replacement: use locally controlled directories.

## Opt in to Agent tasks

Execution has a different trust boundary from read-only sync: an authorized CLI task can access/edit its workspace and send task/context data to the configured Claude service. Install/authenticate the CLI yourself and review cost, directory, and tool permissions first. The plugin does not inspect credential files, log in, install the CLI, or schedule remote tasks.

Extend the installation config:

```json
{
  "execution_enabled": true,
  "execution_cwd": "/chosen/task-workspace",
  "cli_path": "/absolute/path/to/claude",
  "execution_state_dir": "/chosen/private-claude-run-state",
  "allowed_tools": "",
  "timeout_ms": 120000
}
```

Storage root, task workspace and private execution-state directory must already exist and be mutually disjoint (neither containing another). Workspace/state themselves cannot be symlinks. The explicitly selected CLI may be an installer-created executable symlink. Restrict state-directory access to your user. The plugin writes 0600 deduplication claims and terminal statuses there, never prompts, chat bodies, credentials or CLI output. Do not remove claims for unconfirmed runs: they prevent duplicate execution/charges.

Select the installation's managed local executor in Regenic. The enabled driver declares `execute: true` only when execution is explicitly enabled, independently of its always-false channel `create`/`reply` capabilities. The matching host requires an enabled installation, `execute`, and a registered same-source TaskExecutor with start capability before allowing the managed executor to be installed. No synthetic conversation creation or channel write-back is needed. The host, not recipe data, supplies the public readonly `ExecutorContext.installation_id` pin. Set only task parameters in the recipe's `executor_config`:

```json
{
  "prompt": "The explicit task instruction"
}
```

In the matching core, use Engine → Executors → Local connector → Install, or `POST /v1/me/executors` with `{"kind":"local_connector","config":{"installation_id":"connector-installation-id"}}`. Use the returned executor's **id** as the recipe's `executor_type`; do not put a connector ID in task parameters to route execution.

Executor type: `claude-code`. Uses the public TaskExecutor `start` / `status` / `resume` / `cancel` contract, after the host activates that installation. All four calls require the host pin; an unpinned static executor cannot execute or access a run. Recipe fields cannot override the pin. In-memory run ownership and durable state must match the pinned installation, including between two active installations in the same organization. `start` requires a durable host `run_id` and quickly returns running rather than awaiting the task. `status` exposes latest assistant text, final result or an explicit error. `resume` observes an existing run, never resubmits a task or answers permissions. The channel intentionally has no reply/create egress: imported historical conversations cannot receive prompts through sync.

Execution follows the official [CLI reference](https://code.claude.com/docs/en/cli-reference) and [headless guide](https://code.claude.com/docs/en/headless): shell-free `spawn`, explicit cwd, `claude -p --output-format stream-json --verbose`; task text goes through stdin, not argv.

- `--tools ""` removes all built-in tools by default. `--disallowedTools "mcp__*"` denies MCP, also using strict empty MCP configuration.
- `allowed_tools` accepts only an explicit subset of `Read,Glob,Grep,Edit,Write`. Nonempty selection becomes both the available `--tools` set and the `--allowedTools` automatic-approval list. This **preapproves** those tools, especially edits/writes; it is not merely a display preference. Empty selection never supplies `--allowedTools`. Bash, Agent, wildcard/pattern authorization and arbitrary tools are unsupported.
- Permission mode is always `default`, never bypass/acceptEdits/auto or dangerous skip. User/project/local settings sources are empty, non-managed hooks and skills are disabled and sessions are not persisted; no MCP/subagents are enabled. CLI's special `EndConversation` termination control may remain with a nonempty tool set; it is not a file/command execution tool.
- Unsupported flags/CLI versions fail instead of retrying with weaker restrictions. There is no interactive permission UI: denials fail the task, never escalate. `result.permission_denials` is authoritative.

**cwd is not a filesystem/network sandbox.** Authorized Read/Edit/Write are not forcibly cwd-scoped. The CLI itself may read workspace instructions, authentication and managed policies, and send context to its model provider. Per the [official hook policy](https://code.claude.com/docs/en/hooks), `disableAllHooks` outside managed settings cannot disable managed hooks. Those hooks can execute independently of the model's tool set; the plugin neither reads nor overrides organizational policy. An empty tool set is not a promise that a policy-managed CLI performs no other actions. Use a trusted CLI in a trusted workspace. Only PATH/HOME/USERPROFILE/temp/SystemRoot and standard Anthropic/Claude authentication environment variables are forwarded, not arbitrary CLI control, Node injection, proxy or remote-provider variables; values are never logged. Custom providers/proxies and enterprise network setups are outside the first version's supported scope.

The stream parser bounds total output at 4 MiB and lines at 1 MiB, counts/discards stderr, and requires a successful terminal result, no denials, and successful process exit before reporting completion. Missing results, malformed/partial streams, nonzero exits and auth/tool errors fail. Tasks allow at most 10 Agent turns; configurable timeout is 100–1800000 ms (default 120000). Startup admission waits at most 5 seconds and cannot secretly spawn after timing out.

Concurrent/repeated start with the same run ID never spawns twice; conflicting input fails. After loss of in-process running state, durable claims make start/status/resume raise `execution_state_unknown_no_automatic_restart`, **not** mark unknown execution failed and run it again. Terminal statuses survive restart. The in-memory run cache is bounded at 1000 entries and evicts the oldest successfully persisted terminal entries before rejecting active-run capacity; evicted result text remains available only if retained by the host. Durable claims still prevent re-execution after eviction. Orphaned Agents after a plugin crash are not automatically adopted or killed by the new process: inspect them yourself.

Cancel, timeout and all installation stop reasons TERM the owned POSIX process group and escalate to KILL after 200ms when needed. Stop succeeds only after child/group exit confirmation; inability to confirm fails and leaves the installation fenced. Cancel waits at most 2 seconds; stop also honors the host AbortSignal. A CLI/hook deliberately creating an unrelated session can escape that process group; this is not adversarial process containment. Old streams/directory handles never reactivate. Execution currently implements POSIX process groups only, not Windows execution. No untested cross-platform or live-account compatibility is claimed.

## Verification and licensing

```sh
npm install
npm run typecheck
npm test
npm audit --omit=dev
npm pack
```

Tests use synthetic journals and a Node fake CLI: published conformance, genuine plugin-host mounting, paging/incremental/restart/partial lines, corruption/rotation/path boundaries, unchanged sources, permission/error privacy, exact tool argv, run dedup/status/cancellation/timeouts/process groups, host-pinned installation isolation and lifecycle. They do not run real Claude, read real user data, validate an account or make paid requests. Validate your installed CLI in an explicitly authorized isolated workspace before deployment.

No Anthropic SDK or CLI is bundled. The reference Python SDK is MIT; TS SDK/Claude use remains governed by their own terms. npm dependencies retain their actual Regenic/Zod licenses; this plugin is MIT. Development test-utils 0.1.0 receives only a targeted contract override to the same pinned contract version, preserving one error-class instance and Zod 4, not a global override.

The registry lockfile is deliberately pending the real contract 0.3.0 publication. Candidate validation uses the exact core-produced tarball in a temporary consumer outside this repository; no vendored candidate or machine-local dependency paths are shipped. Generate/verify the lock against the actual registry artifact before adopting `npm ci` or releasing the plugin. For candidate pack tests only, `REGENIC_CONTRACT_CANDIDATE` can point to that tarball; this variable is never read by the production plugin.
