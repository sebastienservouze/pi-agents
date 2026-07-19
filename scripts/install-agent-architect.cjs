const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const BUNDLED_AGENTS = [
  { source: "AGENT-ARCHITECT.md", target: "agent-architect.md" },
  { source: "AGENT-SESSION-REVIEWER.md", target: "agent-session-reviewer.md" },
  { source: "AGENT-TOOL-CREATOR.md", target: "agent-tool-creator.md" },
  { source: "AGENT-SKILL-CREATOR.md", target: "agent-skill-creator.md" },
];

function installAgents(agentDir, bundledAgents) {
  const settingsPath = path.join(agentDir, "settings.json");
  const settings = fs.existsSync(settingsPath) ? JSON.parse(fs.readFileSync(settingsPath, "utf8")) : {};
  const model = typeof settings.defaultProvider === "string" && typeof settings.defaultModel === "string"
    ? `model: ${JSON.stringify(`${settings.defaultProvider}/${settings.defaultModel}`)}`
    : "";
  const agentsDir = path.join(agentDir, "agents");
  fs.mkdirSync(agentsDir, { recursive: true });

  return bundledAgents.map(({ source, target: filename }) => {
    const template = fs.readFileSync(path.join(__dirname, "..", "agents", source), "utf8");
    const content = source === "AGENT-ARCHITECT.md"
      ? template.replace("model: __PI_DEFAULT_MODEL__", model)
      : template;
    const target = path.join(agentsDir, filename);
    const backup = path.join(agentsDir, filename.replace(/\.md$/, "-old"));
    const temporary = `${target}.${process.pid}.tmp`;

    fs.writeFileSync(temporary, content);
    try {
      if (fs.existsSync(target)) fs.copyFileSync(target, backup);
      fs.renameSync(temporary, target);
    } finally {
      fs.rmSync(temporary, { force: true });
    }

    return { target, backup: fs.existsSync(backup) ? backup : undefined };
  });
}

function resolveAgentDir(agentDir) {
  return agentDir || process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
}

function installBundledAgents(agentDir) {
  return installAgents(resolveAgentDir(agentDir), BUNDLED_AGENTS);
}

// Conserve le périmètre historique de l'API publique.
function installAgentArchitect(agentDir) {
  return installAgents(resolveAgentDir(agentDir), [BUNDLED_AGENTS[0]])[0];
}

if (require.main === module) {
  for (const { target, backup } of installBundledAgents()) {
    console.log(`pi-agents: installed ${target}${backup ? ` (backup: ${backup})` : ""}`);
  }
}

module.exports = { installAgentArchitect, installBundledAgents };
