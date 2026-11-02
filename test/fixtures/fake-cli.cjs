// Protocol fixture only. Never invokes an agent, provider, or user's executable.
const { spawn } = require("node:child_process");
const scenario = process.argv[2] ?? "success";
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
function emit(event) { process.stdout.write(JSON.stringify(event) + "\n"); }
function result(extra = {}) {
  return {
    type: "result", subtype: "success", is_error: false, result: "Synthetic result.",
    permission_denials: [], ...extra,
  };
}
process.stdin.on("end", () => {
  if (!input) process.exit(2);
  if (scenario === "hang" || scenario === "tree") {
    process.on("SIGTERM", () => {});
    if (scenario === "tree") {
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
      emit({ type: "system", subtype: "synthetic_child", pid: child.pid });
    }
    emit({ type: "assistant", message: { content: [{ type: "text", text: "Synthetic working." }] } });
    setInterval(() => {}, 1000);
    return;
  }
  process.stderr.write("PRIVATE_SYNTHETIC_TOKEN /synthetic/private/path\n");
  if (scenario === "invalid") return process.stdout.write("PRIVATE_SYNTHETIC_TOKEN invalid-json\n");
  if (scenario === "partial") return process.stdout.write('{"type":"result"');
  if (scenario === "oversized") return process.stdout.write("x".repeat(1024 * 1024 + 1));
  if (scenario === "missing") return emit({ type: "system", subtype: "init" });
  if (scenario === "denied") return emit(result({ permission_denials: [{ tool_name: "Write", input: { token: "PRIVATE_SYNTHETIC_TOKEN" } }] }));
  if (scenario === "error") return emit(result({ subtype: "error_during_execution", is_error: true, errors: ["PRIVATE_SYNTHETIC_TOKEN"] }));
  if (scenario === "nonzero") {
    emit(result());
    process.exitCode = 4;
    return;
  }
  const assistant = JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Synthetic answer." }] } }) + "\n";
  process.stdout.write(assistant.slice(0, 13));
  setTimeout(() => {
    process.stdout.write(assistant.slice(13));
    emit(result());
  }, 20);
});
