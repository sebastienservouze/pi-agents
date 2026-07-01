/**
 * Persisted extension config, stored at ~/.pi/pi-agents.json.
 *
 * Currently holds the default agent that auto-activates at session start.
 * Persists across pi restarts — unlike an environment variable.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

interface AgentsConfig {
  /** Name of the agent auto-activated once at session start. */
  defaultAgent?: string;
}

function configDir(): string {
  return path.join(os.homedir(), ".pi");
}

function configPath(): string {
  return path.join(configDir(), "pi-agents.json");
}

/** Reads the config file. Returns an empty config if missing or unreadable. */
export function readConfig(): AgentsConfig {
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath(), "utf-8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** Writes the config file, creating ~/.pi if needed. */
function writeConfig(config: AgentsConfig): void {
  fs.mkdirSync(configDir(), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(config, null, 2) + "\n", "utf-8");
}

/**
 * Name of the default agent to auto-activate at startup.
 * PI_DEFAULT_AGENT (env) takes precedence over the persisted config.
 */
export function getDefaultAgentName(): string | undefined {
  return process.env.PI_DEFAULT_AGENT || readConfig().defaultAgent || undefined;
}

/** Sets (or clears, when name is undefined) the persisted default agent. */
export function setDefaultAgentName(name: string | undefined): void {
  const config = readConfig();
  if (name) config.defaultAgent = name;
  else delete config.defaultAgent;
  writeConfig(config);
}
