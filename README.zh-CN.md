# Claude Code 连接器

Regenic 的独立外部插件：显式选择本地 Claude Code 会话日志进行同步，并可单独启用本地 Agent 任务执行。不是内置连接器。同步不需要凭据、Claude SDK 或运行中的 Claude 进程；任务执行使用用户自行安装、认证的官方 `claude` CLI，可能产生费用。

[English](README.md)

## 安装与选择

需要 Node.js >=20 和支持 connector protocol `1.0` 的 Regenic。执行另外依赖 `@regenic/connector-contract@0.3.0` 新增的公共 host 安装 pin 与 `ChannelCapabilities.execute`，以及支持它们的 Regenic host；`0.2.0` 不能安全提供安装绑定。`@regenic/plugin-host@0.1.0` 已发布，contract `0.3.0` 当前为未发布候选：正式 registry 安装须等待该版本发布，不能静默降级或伪造 lockfile 的 registry 地址。以下 registry 构建安装流程适用于该版本发布之后：

```sh
npm install
npm run build
npm pack
```

将打包文件安装至一个专用插件目录，例如：

```sh
npm install --prefix /absolute/regenic-claude-plugin /absolute/regenic-connector-claude-code-0.1.0.tgz
```

启动 Regenic 时将 `REGENIC_CHANNEL_PLUGIN` 指向
`/absolute/regenic-claude-plugin/node_modules/@regenic/connector-claude-code`。
这是 core 的外部插件加载入口，不需要本地 core 源码路径。包提供同步 `require()` 入口及具名导出 `claudeCodeDriver` / `claudeCodeTaskExecutor`，manifest 同时声明 driver 和 executor。

插件目录、安装卡片、probe、options、安装配置本身都不会读取会话正文或启动 CLI。用户必须明确给出存储根目录、项目目录名及会话 UUID，并启用安装。没有默认扫描路径，也不会读取本机的真实会话来进行安装探测。

以下独立 API **仅在用户主动调用时**枚举文件名，不打开日志正文、项目源文件或子目录：

```js
const { discoverClaudeCode } = require("@regenic/connector-claude-code");
await discoverClaudeCode({ root: "/chosen/claude/projects" });
await discoverClaudeCode({
  root: "/chosen/claude/projects",
  project: "-exact-storage-directory-name",
});
```

`root` 是包含项目存储目录的根目录，不是源代码工作区；项目名称按不透明目录名处理，不逆向推断原始工作区路径。正常 Claude 存储位于 Claude 配置目录的 `projects/` 下，但插件不会推测配置目录或读取配置来寻找它。目录发现最多接受 10000 个直接子项。

在 Regenic 安装卡片或 driver 的 `install().config` 中配置：

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

会话可以使用逗号分隔的 UUID 或字符串数组，最多 1000 个。选择之后 host 才可调用 `startInstallation`、`bindSyncSource` / `resolveStreams` 并按自己的节奏 poll。目录页最多 100 个会话，消息页最多 200 条；没有后台 watcher 或内置定时采集。

## 数据来源与同步边界

本插件使用**非稳定的内部 JSONL 格式**，不是 Claude Code 的稳定导出 API。核实的官方资料：

- [官方 Python SDK 的 MIT session reader，固定源码版本](https://github.com/anthropics/claude-agent-sdk-python/blob/2146f9d8985513053e904b13200c8f744b36785a/src/claude_agent_sdk/_internal/sessions.py)。
- [对应官方合成测试](https://github.com/anthropics/claude-agent-sdk-python/blob/2146f9d8985513053e904b13200c8f744b36785a/tests/test_sessions.py)。
- [该源码的 bundled CLI 版本：2.1.316](https://github.com/anthropics/claude-agent-sdk-python/blob/2146f9d8985513053e904b13200c8f744b36785a/src/claude_agent_sdk/_cli_version.py)；这只是格式证据的版本，**并非真实 CLI 兼容性实测结论**。
- 官方 npm `@anthropic-ai/claude-agent-sdk@0.3.316` 的公开 `sdk.d.ts` 声明 `listSessions` / `getSessionMessages`。这些接口包含跨项目/工作树查找语义，返回的 `message` 为 unknown，且不提供原始时间戳；此插件不安装或执行该 SDK。

`claude-code-jsonl-v1` 是插件自身对上述已核实字段子集的标识，不是上游承诺的 schema 版本。升级后如遇不兼容字段/块类型，会显式报错；不能仅靠版本号判定可用。

同步的是所选文件的**追加日志时间线**，不是官方 session reader 重建的当前活动 parentUuid 分支，也不是完整历史。原始日志中的旧分支可能仍出现在时间线上，不据此推断任务完成或 Agent 当前运行状态：

| 日志内容 | 映射 |
|---|---|
| user / assistant 文本 | Regenic message；保留原始时间戳，user outbound / assistant inbound |
| 相同 `message.id` 的不同 assistant UUID 分片 | 各自稳定记录，不把合法分片错误去重 |
| tool_use / tool_result | system `thread_status` 请求/完成/失败标记；关联 ID 仅保留哈希，不导入参数或结果正文 |
| compact_boundary | system 标记，不遍历 logicalParentUuid |
| isCompactSummary / isMeta / sidechain / teamName | 排除，避免摘要重复注入或混入子代理/元数据 |
| thinking、图片、文档块 | 不导入正文，不下载 |
| 已知元数据类型 | 跳过，不作为用户消息 |
| 未知日志类型、未知内容块、损坏完整行、缺少必需字段 | 类型化错误，不伪装成成功空页 |

不扫描子代理目录、不解析工作区源文件、附件、工具参数中的路径或聊天提到的文件。工具结果正文即便已在日志中，也不导入。不会修改、删除或锁定源日志。禁用、删除、清理只停止本地采集，不清理 Claude 数据或登出。

历史从字节 0 顺序分批读取，读完后沿同一 cursor 增量拉取。cursor 可持久化并跨插件进程重启恢复，包含文件身份、已提交字节位置与前缀 SHA-256，不包含聊天正文或原路径。稳定外部 ID 基于项目键、session UUID、entry UUID 和块位置；跨页/重试去重由 Regenic source identity 完成，同一页不重复发同一身份。不是编辑/删除同步。

追加中的半行（包括 UTF-8 半字符）在换行到达前不提交、不忙循环。文件截断、替换、已提交前缀改写会明确要求重置 cursor；**不会自动跳过数据或自动重新导入**。用户检查源后可让 host 清除相应 cursor 从头读取；重复源身份仍相同。权限、缺失、坏 UTF-8、未知格式均为明确错误，错误不附带源路径、正文、stderr 或 token。正文一旦被用户选择同步，则可能自然包含用户原本写入的敏感信息；插件不是内容脱敏器。

上限：单文件 128 MiB、单行 1 MiB、每次读取窗口 2 MiB。每次校验已提交前缀，代价随历史长度线性增长。仅支持顺序历史/增量 poll；`older` / `latest` / before 窗口显式拒绝，安装不声明 hydrate-on-open。

路径边界：根目录本身、其下项目和日志不能是 symlink；日志必须为普通单硬链接文件。只允许显式根内的直接项目/UUID 文件，拒绝 `..`、路径分隔符和越界链接。用户显式根的系统级祖先路径可由操作系统解析（例如 macOS 临时目录）。打开时使用只读、no-follow、non-blocking 并比对文件身份/真实路径。此规则不是针对恶意并发替换祖先目录的 OS 沙箱；请使用自己控制的本地目录。

## 显式启用 Agent 任务

执行与同步的权限不同：同步保持只读；CLI 任务会按用户授权读取/编辑工作区，并向所配置的 Claude 服务提交任务和上下文。启用前自行完成 CLI 安装、认证、费用及目录/工具授权审查。插件不读取凭据文件、不登录、不自动安装 CLI，不使用远程调度。

在上述安装配置中增加：

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

三个目录必须预先存在且互不包含：日志根、任务工作区、插件执行状态目录。工作区/状态目录本身不能是 symlink；用户选定的 CLI 可为安装器创建的可执行文件链接。执行状态目录应仅限本用户访问。插件在其中写入 0600 的去重标记与最终状态，不保存 prompt、聊天正文、凭据或 CLI 输出。不要删除仍未确认结束的任务标记；它是防止重复收费执行的凭据，不是 Agent 的身份凭据。

在 Regenic 中选择该安装绑定的本地 executor。driver 仅对已启用且明确开启执行的安装声明 `execute: true`，不改变始终为 false 的 channel `create`/`reply`。配套 host 须同时核实安装 enabled、execute、已注册同 source TaskExecutor 及其 start 能力，才能安装 managed executor；不伪造会话创建或 channel 写回。由 host（不是配方数据）填写公开只读 `ExecutorContext.installation_id` pin。recipe 的 `executor_config` 只填写任务参数：

```json
{
  "prompt": "The explicit task instruction"
}
```

在配套 core 中使用 Engine → Executors → Local connector → Install，或以 `{"kind":"local_connector","config":{"installation_id":"connector-installation-id"}}` 调用 `POST /v1/me/executors`。recipe 的 `executor_type` 使用返回 executor 的 **id**，不在任务参数中放 connector ID 来选择执行安装。

executor type 为 `claude-code`。使用公开 TaskExecutor `start` / `status` / `resume` / `cancel` 契约；host 需先激活对应安装。四个入口都要求 host pin，未绑定的静态 executor 不能执行或访问 run。recipe 字段不能覆盖 pin；运行表和持久 ledger 的归属须与 pin 一致，同 org 两个活跃安装也不能互相操作 run。`start` 要求 host 传入持久化 `run_id`，启动后尽快返回 running，不等待任务结束。`status` 返回最新 assistant 文本、完成结果或明确错误；`resume` 仅重新观察已有 run，不重发任务或回答权限问题。没有 reply/create channel egress，不向已同步的历史会话发送 prompt。

执行路径来自[官方 CLI reference](https://code.claude.com/docs/en/cli-reference)与[headless 文档](https://code.claude.com/docs/en/headless)：通过无 shell 的 `spawn`，在显式 cwd 运行 `claude -p --output-format stream-json --verbose`，任务通过 stdin 发送，不放到命令行。严格区分：

- `--tools ""` 默认移除所有内置工具；另外 `--disallowedTools "mcp__*"` 拒绝 MCP，`--strict-mcp-config` 配空 MCP 表。
- `allowed_tools` 只接受 `Read,Glob,Grep,Edit,Write` 的明确子集。非空时同时作为 `--tools` 可用工具集和 `--allowedTools` 免审批授权。这是对这些工具的**自动批准**，特别是 Edit/Write，不只是展示选项；不要授予你不愿自动执行的工具。空值不传 `--allowedTools`。不支持 Bash、Agent、任意工具、模式或通配授权。
- 权限模式始终为 `default`，不使用 bypass/acceptEdits/auto 或危险跳过审批。用户/项目/本地设置来源为空，关闭非 managed hooks 与 skills、禁用会话持久化；不启用 MCP/子代理。CLI 的 `EndConversation` 特殊内置工具可能在非空工具集时保留，这是 CLI 的终止控制，不是文件/命令执行工具。
- CLI 版本若不支持这些参数，应非零退出并报错；不降级为更宽权限。没有交互审批通道：权限拒绝会作为任务失败显示，不能自动提权。stdout 的 `result.permission_denials` 为权威判断。

**cwd 不是文件系统/网络沙箱。** 用户授权的 Read/Edit/Write 不是强制 cwd 限定。CLI 自身可能读取工作区指令、认证和受管理策略并向模型提交上下文。[官方 hook 策略](https://code.claude.com/docs/en/hooks)明确：非 managed 设置中的 `disableAllHooks` 不能禁用 managed hooks。这些 hooks 可以独立于模型工具集执行，插件不会读取或覆盖组织策略；空工具集不表示受管理 CLI 不会执行其他操作。只在受信工作区使用受信 CLI。运行时只向子进程转交 PATH/HOME/USERPROFILE/临时目录/SystemRoot 以及标准 Anthropic/Claude 认证环境变量，不转交任意 CLI 控制、Node 注入、代理或远程服务变量；从不记录这些值。自定义提供商/代理和企业网络配置不在首版支持范围。

stdout 流式解析且有 4 MiB 总输出、1 MiB 单行上限，stderr 仅计数后丢弃。必须同时收到成功 result、无权限拒绝且进程成功退出，才报告 completed。无结果、坏流、半行、非零退出、认证/工具错误均失败。默认最多 10 个 Agent turns；超时配置范围 100–1800000 ms。启动握手最多等待 5 秒；不会在超时后悄悄启动任务。

同一 `run_id` 的并发/重复 start 不产生第二个进程，变更任务内容会报冲突。运行中状态丢失后，持久标记使 start/status/resume 明确报 `execution_state_unknown_no_automatic_restart`，**不会把未知当作失败然后重执行**。重启后已完成/失败/取消状态可以读取。内存运行缓存上限为 1000，达到容量时先回收最早已成功落盘的终态任务，不让历史任务占满活跃执行容量；回收的结果正文仅在 host 自己保存时可继续获取，持久标记仍阻止重复执行。进程崩溃后的孤儿 Agent 不会被新插件自动认领或杀死，需用户检查。

取消、超时、所有 installation stop 原因都会向拥有的 POSIX 进程组发 TERM，200ms 后按需 KILL；确认主进程/进程组退出后才完成停止，无法确认则失败并保持 fenced。cancel 自身最长等待 2 秒；stop 同时尊重 host AbortSignal。CLI/hook 若刻意新建独立 session，可能逃离该进程组；这不是对抗恶意进程的 OS 隔离。旧流/目录句柄不能在重启后复活。本地 executor 当前仅实现 POSIX 进程组，不支持 Windows 执行。未声明真实跨平台/真实账号兼容性。

## 验证与许可证

```sh
npm install
npm run typecheck
npm test
npm audit --omit=dev
npm pack
```

测试使用合成 JSONL 和 Node 假 CLI，覆盖公开 conformance、真实 plugin-host、分页/增量/重启、半行、轮转/损坏/越界链接、源文件不变、权限与日志隐私、工具 argv、任务去重/状态、取消/超时/进程树、host pin 安装隔离和生命周期。没有调用真实 Claude、读取真实用户数据、验证真实账号或执行收费请求。应在使用者授权的隔离测试工作区进行真实 CLI 验证后再部署。

包未捆绑 Anthropic SDK 或 Claude CLI。参考 Python SDK 为 MIT，TS SDK/Claude 的使用由其各自条款管理。实际 Regenic 依赖及 Zod 的许可证由 npm 依赖包保留；本插件为 MIT。开发依赖 test-utils 0.1.0 仅对其 contract 依赖做定向 override 至相同 contract 版本，以维持同实例错误类型与 Zod 4，不做全局覆盖。

registry lockfile 明确等待 contract 0.3.0 实际发布后生成。候选验证只在仓库外临时 consumer 中使用 core 产出的确切 tarball，不将候选包 vendor 进本仓库，不提交本机依赖路径。采用 `npm ci` 或发布插件前，须针对实际 registry artifact 生成和核实 lock。仅候选 pack 测试可通过 `REGENIC_CONTRACT_CANDIDATE` 指定该 tarball；生产插件不会读取此环境变量。
