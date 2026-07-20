/**
 * Per-agent model selection.
 *
 * Caracal lets you assign, to each agent, any model accessible through
 * opencode (this is the analogue of CAI's per-agent `CAI_<AGENT>_MODEL`).
 *
 * Mechanism (validated against opencode 1.17.x):
 *   - opencode deep-merges the global config (baked into the image) with the
 *     project config at the workspace root (`<workspace>/opencode.json`).
 *   - A per-agent model is set via `agent.<name>.model`; the session default via
 *     top-level `model`. The global plugin + permissions keep applying.
 *   - We therefore write/merge the workspace `opencode.json` at launch and do
 *     NOT pass `--model` (which would override every agent).
 *
 * Selections are stored in `caracal.models.json` next to where you run the
 * launcher, so they persist and can be edited or version-controlled.
 */
import { spawnSync } from "node:child_process"
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { createInterface } from "node:readline"
import { resolve } from "node:path"

export interface ModelSelection {
  /** Session default + fallback for any agent without an explicit choice. */
  default: string
  /** agentName -> model id. */
  agents: Record<string, string>
}

const SELECTION_FILE = "caracal.models.json"

/** Discover assignable agent names from runtime/agent/*.md (future-proof). */
export function discoverAgentNames(repoRoot: string): string[] {
  const dir = resolve(repoRoot, "runtime", "agent")
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.slice(0, -3))
    .sort()
}

export function selectionPath(cwd: string): string {
  return resolve(cwd, SELECTION_FILE)
}

export function loadSelection(cwd: string, fallbackDefault: string): ModelSelection {
  const path = selectionPath(cwd)
  if (existsSync(path)) {
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<ModelSelection>
      return {
        default: raw.default || fallbackDefault,
        agents: raw.agents ?? {},
      }
    } catch {
      // fall through to default on parse error
    }
  }
  return { default: fallbackDefault, agents: {} }
}

export function saveSelection(cwd: string, sel: ModelSelection): void {
  writeFileSync(selectionPath(cwd), JSON.stringify(sel, null, 2) + "\n", "utf8")
}

/** Effective model for each agent = explicit choice or the default. */
export function resolveModels(agents: string[], sel: ModelSelection): Record<string, string> {
  const out: Record<string, string> = {}
  for (const a of agents) out[a] = sel.agents[a] || sel.default
  return out
}

/** List models accessible through opencode on this host. Empty on failure. */
export function listAccessibleModels(): string[] {
  const r = spawnSync("opencode", ["models"], { encoding: "utf8" })
  if (r.status !== 0 || !r.stdout) return []
  return r.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^[\w.-]+\/[\w.:@-]+$/.test(l))
    .sort()
}

/**
 * Merge the resolved models into the workspace opencode.json, preserving any
 * other keys the user may have added. Sets top-level `model` (default) and
 * `agent.<name>.model` for each agent.
 */
export function writeWorkspaceModelConfig(
  workspace: string,
  defaultModel: string,
  agentModels: Record<string, string>,
): void {
  const path = resolve(workspace, "opencode.json")
  let cfg: Record<string, unknown> = {}
  if (existsSync(path)) {
    try {
      cfg = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>
    } catch {
      cfg = {}
    }
  }
  cfg["$schema"] = "https://opencode.ai/config.json"
  cfg["model"] = defaultModel
  const agentCfg = (cfg["agent"] as Record<string, Record<string, unknown>> | undefined) ?? {}
  for (const [name, model] of Object.entries(agentModels)) {
    agentCfg[name] = { ...(agentCfg[name] ?? {}), model }
  }
  cfg["agent"] = agentCfg
  writeFileSync(path, JSON.stringify(cfg, null, 2) + "\n", "utf8")
}

// ---------------------------------------------------------------------------
// Interactive selector (`caracal models`)
// ---------------------------------------------------------------------------

function ask(rl: ReturnType<typeof createInterface>, q: string): Promise<string> {
  return new Promise((res) => rl.question(q, (a) => res(a.trim())))
}

/**
 * Resolve a user's free-text answer to a concrete model id.
 * - empty            -> keep `current`
 * - exact match      -> use it
 * - single substring -> use it
 * - many substrings  -> show a few and re-ask
 * - none             -> accept as-is (with a warning) so custom ids still work
 */
async function resolveAnswer(
  rl: ReturnType<typeof createInterface>,
  answer: string,
  current: string,
  models: string[],
): Promise<string> {
  let a = answer
  for (;;) {
    if (!a) return current
    if (models.includes(a)) return a
    const matches = models.filter((m) => m.toLowerCase().includes(a.toLowerCase()))
    if (matches.length === 1) return matches[0]!
    if (matches.length === 0) {
      const ok = await ask(rl, `  "${a}" not in the catalog. Use it anyway? [y/N] `)
      if (ok.toLowerCase() === "y") return a
      a = await ask(rl, "  model: ")
      continue
    }
    console.log(`  ${matches.length} matches:`)
    for (const m of matches.slice(0, 20)) console.log(`    ${m}`)
    if (matches.length > 20) console.log(`    … and ${matches.length - 20} more`)
    a = await ask(rl, "  refine: ")
  }
}

export async function runInteractiveSelector(
  cwd: string,
  agents: string[],
  fallbackDefault: string,
): Promise<ModelSelection> {
  const models = listAccessibleModels()
  const sel = loadSelection(cwd, fallbackDefault)
  const rl = createInterface({ input: process.stdin, output: process.stdout })

  console.log(
    `\nAssign a model to each agent. ${models.length ? `${models.length} models accessible` : "(could not list models — type ids manually)"}.`,
  )
  console.log("Type part of a name to search, or press Enter to keep the current value.\n")

  sel.default = await resolveAnswer(
    rl,
    await ask(rl, `default model [${sel.default}]: `),
    sel.default,
    models,
  )

  for (const agent of agents) {
    const current = sel.agents[agent] || sel.default
    const chosen = await resolveAnswer(
      rl,
      await ask(rl, `${agent} [${current}]: `),
      current,
      models,
    )
    // Only store an override if it differs from the default.
    if (chosen === sel.default) delete sel.agents[agent]
    else sel.agents[agent] = chosen
  }

  rl.close()
  saveSelection(cwd, sel)
  return sel
}
