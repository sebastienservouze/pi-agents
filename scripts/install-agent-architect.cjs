const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function installAgentArchitect(agentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent")) {
  const template = fs.readFileSync(path.join(__dirname, "..", "agents", "AGENT-ARCHITECT.md"), "utf8");
  const settingsPath = path.join(agentDir, "settings.json");
  const settings = fs.existsSync(settingsPath) ? JSON.parse(fs.readFileSync(settingsPath, "utf8")) : {};
  const model = typeof settings.defaultProvider === "string" && typeof settings.defaultModel === "string"
    ? `model: ${JSON.stringify(`${settings.defaultProvider}/${settings.defaultModel}`)}`
    : "";
  const content = template.replace("model: __PI_DEFAULT_MODEL__", model);
  const agentsDir = path.join(agentDir, "agents");
  const target = path.join(agentsDir, "agent-architect.md");
  const backup = path.join(agentsDir, "agent-architect-old");
  const temporary = `${target}.${process.pid}.tmp`;

  fs.mkdirSync(agentsDir, { recursive: true });
  fs.writeFileSync(temporary, content);
  try {
    if (fs.existsSync(target)) fs.copyFileSync(target, backup);
    fs.renameSync(temporary, target);
  } finally {
    fs.rmSync(temporary, { force: true });
  }

  return { target, backup: fs.existsSync(backup) ? backup : undefined };
}

if (require.main === module) {
  const { target, backup } = installAgentArchitect();
  console.log(`pi-agents: installed ${target}${backup ? ` (backup: ${backup})` : ""}`);
}

module.exports = { installAgentArchitect };
