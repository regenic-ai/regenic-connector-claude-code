import { createDriver } from "./driver";
import { createTaskExecutor, type SpawnClaude } from "./executor";
import { Runtime } from "./runtime";

export { discoverClaudeCode } from "./filesystem";
export { parseJournalLine } from "./parser";
export { FORMAT, SOURCE } from "./config";
export type { SpawnClaude } from "./executor";

export function createClaudeCodeIntegration(options: { spawn?: SpawnClaude } = {}) {
  const runtime = new Runtime();
  return {
    driver: createDriver(runtime),
    executor: createTaskExecutor(runtime, options.spawn),
  };
}

const integration = createClaudeCodeIntegration();
export const claudeCodeDriver = integration.driver;
export const claudeCodeTaskExecutor = integration.executor;
