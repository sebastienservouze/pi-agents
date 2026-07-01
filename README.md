# @nerisma/pi-agents

Système d'agents spécialisés pour pi. Permet de déléguer des sous-tâches à des agents configurés via des fichiers `.md` (frontmatter YAML + system prompt). Chaque agent tourne en contexte isolé et retourne un résumé ciblé.

## Installation

```bash
pi install npm:@nerisma/pi-agents
```

## Usage

- **Outil `delegate`** : le LLM peut déléguer une tâche à un agent spécialisé (`delegate agent=<nom> task=<tâche>`).
- **Commande `/agent`** : sélecteur interactif pour activer/désactiver un agent manuellement.
- **Raccourci `Alt+A`** : ouvre le sélecteur d'agent.

## Structure des agents

Les agents sont définis dans des fichiers `.md` avec un frontmatter YAML :

- `.pi/agents/*.md` — agents projet (prioritaires)
- `~/.pi/agent/agents/*.md` — agents globaux

Champs supportés : `name`, `description`, `tools`, `model`, `thinkingLevel`, `outputFormat`, `useAgentFile`.

## License

MIT
