#!/usr/bin/env node
/**
 * caracal — host launcher.
 *
 * Brings up opencode with the Caracal architecture (plugin + agents + HITL).
 * By default this happens inside a hardened Docker sandbox; pass --local to
 * run directly on the host instead (no container isolation — see `caracal
 * --help` and docs/sandbox.md before using it).
 *
 *   caracal                 build (if needed) + start sandbox + open opencode (active target)
 *   caracal --local         same, but runs directly on the host (no Docker, no isolation)
 *   caracal target [name]   show / create+select the active target (engagement)
 *   caracal targets         list saved targets
 *   caracal rm <name>       delete a target and all its files (dry-run; --force to confirm)
 *   caracal build           (re)build the sandbox image
 *   caracal shell           open a bash shell inside the sandbox
 *   caracal status          show docker / image / container / target state
 *   caracal reset [name]    wipe a target's session/context (keeps its files)
 *   caracal stop            stop the sandbox container
 *   caracal down            stop and remove the sandbox container
 *   caracal --help
 */
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs"
import { createInterface } from "node:readline/promises"
import { resolve } from "node:path"
import { loadConfig, type CaracalConfig, type RunMode } from "./config.js"
import * as docker from "./docker.js"
import * as local from "./local.js"
import * as targets from "./targets.js"
import {
  discoverAgentNames,
  listAccessibleModels,
  loadSelection,
  resolveModels,
  runInteractiveSelector,
  selectionPath,
  writeWorkspaceModelConfig,
} from "./models.js"

/**
 * Last-resort default model if the user never ran `caracal models` and never
 * set CARACAL_MODEL. Assumes Ollama Cloud is authenticated on the host — if
 * it isn't (nor any other provider that exposes this exact id), launch will
 * warn via warnIfModelUnavailable() rather than fail silently.
 */
const FALLBACK_MODEL = "ollama-cloud/qwen3-coder:480b"

const RESET = "\x1b[0m"
const BOLD = "\x1b[1m"
const DIM = "\x1b[2m"
const RED = "\x1b[31m"
const GREEN = "\x1b[32m"
const YELLOW = "\x1b[33m"
const CYAN = "\x1b[36m"
const DARKRED = "\x1b[38;5;88m" // deep blood-red (256-color) for the banner

const log = (m: string) => console.log(m)
const info = (m: string) => console.log(`${CYAN}›${RESET} ${m}`)
const ok = (m: string) => console.log(`${GREEN}✓${RESET} ${m}`)
const warn = (m: string) => console.log(`${YELLOW}!${RESET} ${m}`)
const fail = (m: string) => console.error(`${RED}✗ ${m}${RESET}`)

/** Print the Caracal ASCII banner (best-effort; never fatal). */
function printBanner(cfg: CaracalConfig): void {
  try {
    const art = readFileSync(resolve(cfg.repoRoot, "assets", "caracal-banner.txt"), "utf8")
    log(BOLD + DARKRED + art + RESET)
  } catch {
    // Banner is cosmetic — ignore if the asset is missing.
    log(`${BOLD}${DARKRED}CARACAL${RESET} — multi-agent offensive security, under control`)
  }
  if (cfg.mode === "local") {
    log(`${BOLD}${YELLOW}LOCAL MODE${RESET} ${DIM}— running on the host, no container isolation${RESET}`)
  }
}

function version(cfg: CaracalConfig): string {
  try {
    const pkg = JSON.parse(readFileSync(resolve(cfg.repoRoot, "package.json"), "utf8"))
    return String(pkg.version ?? "0.0.0")
  } catch {
    return "0.0.0"
  }
}

function printHelp(cfg: CaracalConfig): void {
  log(`${BOLD}caracal${RESET} ${DIM}v${version(cfg)}${RESET} — multi-agent pentesting on opencode

${BOLD}Usage${RESET}
  caracal [command] [--local | --sandbox] [--yolo]

${BOLD}Commands${RESET}
  ${CYAN}(default)${RESET}      build if needed, start the sandbox, open opencode on the active target
  ${CYAN}target${RESET} [name]  show, or create+select, the active target (engagement)
  ${CYAN}targets${RESET}        list saved targets
  ${CYAN}rm${RESET} <name>      delete a target and all its files (dry-run; --force to confirm)
  ${CYAN}build${RESET}          (re)build the sandbox image
  ${CYAN}models${RESET}         assign a model to each agent (interactive); 'models list' prints all
  ${CYAN}shell${RESET}          open a bash shell inside the running sandbox
  ${CYAN}status${RESET}         show docker / image / container / target state
  ${CYAN}reset${RESET} [name]   wipe a target's opencode session/context (keeps engagement files)
  ${CYAN}stop${RESET}           stop the sandbox container
  ${CYAN}down${RESET}           stop and remove the sandbox container (not the target's files)
  ${CYAN}help${RESET}           show this help

${BOLD}Run mode${RESET} ${DIM}(sandbox is the default and the recommended mode)${RESET}
  ${CYAN}--sandbox${RESET}  run inside the hardened Docker sandbox ${DIM}(default)${RESET}
  ${CYAN}--local${RESET}    run opencode directly on this machine — ${YELLOW}no container isolation${RESET}.
             The model's shell tool then runs with your own user, network and
             filesystem access. Only use this if you understand and accept
             that risk (e.g. you already work inside your own VM/lab). Applies
             to the default launch and to 'shell'. Persist with CARACAL_MODE=local.

${BOLD}Bypassing HITL prompts${RESET}
  ${CYAN}--yolo${RESET}     shorthand for HITL=auto: ${YELLOW}no approval prompts at all${RESET} for this
             launch (recon, exploitation, credential attacks, file edits, ...
             all run unattended). The destructive/escape command blocklist is
             a hard floor and still applies — it cannot be bypassed by any
             flag or mode. Asks for interactive y/N confirmation first, same
             as --local; skip that with CARACAL_YES=1 for scripted use.
             Equivalent to (and overridden by) CARACAL_HITL=auto — see below.

${BOLD}Targets${RESET} ${DIM}(each is a persistent, separate engagement)${RESET}
  Files + opencode session live per target under ${DIM}~/.caracal/targets/<name>/${RESET}.
  Switching targets recreates a clean sandbox; resuming one restores files + context.
    caracal target acme   # create/select 'acme'
    caracal               # launch it
    caracal target old    # switch back to a previous target (restores its session)

${BOLD}Key settings${RESET} ${DIM}(env or .env)${RESET}
  CARACAL_MODE       sandbox | local   (default sandbox; overridden by --local/--sandbox)
  CARACAL_HOME       caracal state dir: targets, active pointer, model selection (default ~/.caracal)
  CARACAL_WORKSPACE  pin a raw workspace dir (advanced; bypasses targets, ephemeral sessions)
  CARACAL_HITL       strict | guided | auto   (default strict; auto is capped to guided in --local)
  CARACAL_MODEL      default model, e.g. ollama-cloud/qwen3-coder:480b
                      ${DIM}(per-agent models: 'caracal models')${RESET}
  CARACAL_IMAGE      image tag   (default caracal:latest)
  CARACAL_CONTAINER  container name (default caracal-sandbox)

${DIM}Offensive-security tool — authorized testing only. See DISCLAIMER.${RESET}`)
}

/** Verify Docker is present and the daemon is up; exit otherwise. */
function requireDocker(): void {
  if (!docker.isDockerInstalled()) {
    fail("Docker is required but was not found on PATH.")
    log(`${DIM}Install Docker, then re-run, or use --local to run without a sandbox.${RESET}`)
    process.exit(1)
  }
  if (!docker.isDockerRunning()) {
    fail("Docker is installed but the daemon is not running (or you lack permission).")
    log(`${DIM}Start Docker (e.g. 'sudo systemctl start docker') and try again.${RESET}`)
    process.exit(1)
  }
}

/** Verify opencode is on PATH for local mode; exit otherwise. */
function requireOpencodeLocal(): void {
  if (!local.isOpencodeInstalled()) {
    fail("opencode was not found on PATH.")
    log(`${DIM}Install it (https://opencode.ai) and authenticate ('opencode auth login'), then re-run.${RESET}`)
    process.exit(1)
  }
}

/**
 * Local mode has no container isolation: the model's bash tool runs with the
 * operator's real user, network, and filesystem access. Refuse to proceed
 * without an explicit, interactive "yes" — this cannot be skipped via a flag.
 */
async function confirmLocalMode(): Promise<void> {
  warn(`${BOLD}LOCAL MODE${RESET}${YELLOW} — no container isolation.${RESET}`)
  log(
    `${DIM}The model will run shell commands directly on this machine, with your user's\n` +
      `privileges, network access, and filesystem (outside the engagement workspace is\n` +
      `still off-limits to file tools, but bash is not sandboxed). Only continue if you\n` +
      `understand and accept that risk. See docs/sandbox.md.${RESET}`,
  )
  if (process.env.CARACAL_YES === "1") return
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const answer = await rl.question(`Continue in local mode? [y/N] `)
  rl.close()
  if (answer.trim().toLowerCase() !== "y") {
    fail("Aborted. Run without --local to use the sandboxed (default) mode.")
    process.exit(1)
  }
}

/**
 * --yolo sets HITL to `auto`: the plugin's permission.ask stops prompting
 * entirely (see runtime/plugin/caracal.ts). The hard safety floor
 * (tool.execute.before — destructive/escape commands, and the sandbox/local
 * launch-marker check) is NOT affected by HITL mode and keeps applying
 * regardless. Require the same explicit confirmation as --local.
 */
async function confirmYolo(cfg: CaracalConfig): Promise<void> {
  warn(`${BOLD}YOLO${RESET}${YELLOW} — HITL prompts are disabled (--yolo -> CARACAL_HITL=auto).${RESET}`)
  log(
    `${DIM}Every agent action (recon, exploitation, credential attacks, file edits, ...)\n` +
      `will run without asking for approval. The destructive/escape command blocklist\n` +
      `still applies and cannot be bypassed, but nothing else will pause for you.${RESET}`,
  )
  if (cfg.mode === "local") {
    warn(`${YELLOW}Combined with --local (no container isolation), this is the least contained` +
      ` mode Caracal offers.${RESET}`)
  }
  if (process.env.CARACAL_YES === "1") return
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const answer = await rl.question(`Continue with HITL disabled? [y/N] `)
  rl.close()
  if (answer.trim().toLowerCase() !== "y") {
    fail("Aborted. Run without --yolo to keep the HITL policy active.")
    process.exit(1)
  }
}

function ensureImage(cfg: CaracalConfig, force = false): void {
  if (!force && docker.imageExists(cfg.image)) {
    ok(`Image ${cfg.image} present.`)
    return
  }
  info(
    `Building sandbox image ${cfg.image} (opencode ${cfg.opencodeVersion}) — first build takes a few minutes…`,
  )
  const code = docker.buildImage({
    image: cfg.image,
    context: cfg.repoRoot,
    dockerfile: resolve(cfg.repoRoot, "docker", "Dockerfile"),
    opencodeVersion: cfg.opencodeVersion,
  })
  if (code !== 0) {
    fail("Image build failed.")
    process.exit(code)
  }
  ok(`Built ${cfg.image}.`)
}

/** Build the mount list + env for the container based on auth mode. */
function authWiring(cfg: CaracalConfig): {
  mounts: Array<[string, string, boolean?]>
  env: Record<string, string>
} {
  const mounts: Array<[string, string, boolean?]> = []
  const env: Record<string, string> = {}
  if (cfg.authMode === "mount") {
    if (existsSync(cfg.hostAuthFile)) {
      mounts.push([cfg.hostAuthFile, "/root/.local/share/opencode/auth.json", true])
    } else {
      warn(
        `No host opencode auth found at ${cfg.hostAuthFile}. ` +
          `Run 'opencode auth login' on the host, or set CARACAL_AUTH_MODE=env.`,
      )
    }
  } else {
    for (const key of [
      "OLLAMA_API_KEY",
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
      "OPENROUTER_API_KEY",
      "GOOGLE_GENERATIVE_AI_API_KEY",
    ]) {
      const v = process.env[key]
      if (v) env[key] = v
    }
    if (Object.keys(env).length === 0) {
      warn("CARACAL_AUTH_MODE=env but no provider API keys found in the environment.")
    }
  }
  return { mounts, env }
}

function ensureContainer(cfg: CaracalConfig): void {
  const desired = resolve(cfg.workspace)
  const state = docker.containerState(cfg.container)
  if (state !== "absent") {
    const bound = docker.containerWorkspace(cfg.container)
    if (bound && resolve(bound) !== desired) {
      // The existing sandbox belongs to a different target — recreate it so each
      // target gets a clean container bound to its own files + opencode session.
      info(`Switching target — recreating sandbox (was bound to ${bound}).`)
      docker.removeContainer(cfg.container)
    } else if (state === "running") {
      ok(`Sandbox ${cfg.container} is running.`)
      return
    } else {
      info(`Starting existing sandbox ${cfg.container}…`)
      if (docker.startContainer(cfg.container) !== 0) {
        fail("Failed to start the existing container. Try 'caracal down' then retry.")
        process.exit(1)
      }
      return
    }
  }
  // absent or just-removed -> create
  mkdirSync(cfg.workspace, { recursive: true })
  if (cfg.dataDir) mkdirSync(cfg.dataDir, { recursive: true })
  info(`Creating sandbox ${cfg.container} (host network, NET_ADMIN/NET_RAW)…`)
  const { mounts, env } = authWiring(cfg)
  if (
    docker.runContainer({
      image: cfg.image,
      container: cfg.container,
      workspace: cfg.workspace,
      dataDir: cfg.dataDir,
      hitl: cfg.hitl,
      mounts,
      env,
    }) !== 0
  ) {
    fail("Failed to start the sandbox container.")
    process.exit(1)
  }
  ok(`Sandbox up. Workspace: ${cfg.workspace} -> /root/engagement`)
}

/**
 * Warn (best-effort, never fatal) when the resolved default model doesn't
 * match anything opencode can currently see on this host. The Caracal fallback
 * (FALLBACK_MODEL) assumes Ollama Cloud is authenticated; if it isn't — and no
 * other provider (OpenRouter, Anthropic, ...) is either — every agent that
 * doesn't have an explicit per-agent override will fail at first prompt with
 * an opaque "model is not valid" error from opencode itself. Catch that here
 * with a clearer, actionable message instead.
 */
function warnIfModelUnavailable(defaultModel: string): void {
  const available = listAccessibleModels()
  if (available.length === 0) return // couldn't query — opencode not installed/auth'd; other checks already cover this
  if (available.includes(defaultModel)) return
  warn(`Default model '${defaultModel}' is not accessible with your current opencode auth.`)
  log(
    `${DIM}Caracal's built-in fallback assumes Ollama Cloud is logged in. If you use a\n` +
      `different provider (OpenRouter, Anthropic, OpenAI, a local/free opencode model, ...),\n` +
      `set it explicitly:\n` +
      `  opencode auth login              # authenticate a provider, then\n` +
      `  caracal models                   # assign a model per agent (interactive), or\n` +
      `  CARACAL_MODEL=<provider/model>   # set the default via env/.env\n` +
      `Accessible right now: ${available.slice(0, 6).join(", ")}${available.length > 6 ? ", …" : ""}${RESET}`,
  )
}

/**
 * Resolve per-agent models and write them into the workspace opencode.json.
 * We do NOT pass `--model` to opencode (it would override every agent); the
 * merged workspace config drives both the default and per-agent models.
 */
function applyModels(cfg: CaracalConfig): { default: string; agents: Record<string, string> } {
  mkdirSync(cfg.workspace, { recursive: true })
  const agents = discoverAgentNames(cfg.repoRoot)
  const sel = loadSelection(targets.caracalHome(), cfg.model ?? FALLBACK_MODEL)
  const agentModels = resolveModels(agents, sel)
  writeWorkspaceModelConfig(cfg.workspace, sel.default, agentModels)
  warnIfModelUnavailable(sel.default)
  return { default: sel.default, agents: agentModels }
}

function openOpencode(
  cfg: CaracalConfig,
  models: { default: string; agents: Record<string, string> },
): never {
  const orchestrator = models.agents["orchestrator"] ?? models.default
  info(`Opening opencode (HITL=${cfg.hitl}, orchestrator=${orchestrator})…`)
  log(
    DIM +
      "models per agent are set in <workspace>/opencode.json — edit with 'caracal models'" +
      RESET,
  )
  log(DIM + "─".repeat(60) + RESET)
  // Start on the orchestrator. No --model: per-agent models come from config.
  const code = docker.execInteractive({
    container: cfg.container,
    env: { CARACAL_HITL: cfg.hitl },
    command: ["opencode", "--agent", "orchestrator"],
  })
  process.exit(code)
}

/** Local-mode equivalent of openOpencode: runs opencode directly on the host. */
function openOpencodeLocal(
  cfg: CaracalConfig,
  models: { default: string; agents: Record<string, string> },
): never {
  const orchestrator = models.agents["orchestrator"] ?? models.default
  info(`Opening opencode locally (HITL=${cfg.hitl}, orchestrator=${orchestrator})…`)
  log(
    DIM +
      "models per agent are set in <workspace>/opencode.json — edit with 'caracal models'" +
      RESET,
  )
  log(DIM + "─".repeat(60) + RESET)
  const code = local.execLocal({
    cwd: cfg.workspace,
    env: { CARACAL_LOCAL: "1", CARACAL_HITL: cfg.hitl },
    command: ["opencode", "--agent", "orchestrator"],
  })
  process.exit(code)
}

async function cmdLaunch(cfg: CaracalConfig, yolo: boolean): Promise<void> {
  printBanner(cfg)
  if (cfg.target) {
    targets.ensureTarget(cfg.target)
    info(`Target: ${BOLD}${cfg.target}${RESET} ${DIM}(${targets.targetDir(cfg.target)})${RESET}`)
  }
  if (yolo) await confirmYolo(cfg)
  if (cfg.mode === "local") {
    await confirmLocalMode()
    requireOpencodeLocal()
    info("Syncing Caracal plugin + agents into your opencode config…")
    local.syncLocalConfig(cfg.repoRoot)
    const models = applyModels(cfg)
    openOpencodeLocal(cfg, models)
    return
  }
  requireDocker()
  ensureImage(cfg)
  const models = applyModels(cfg)
  ensureContainer(cfg)
  openOpencode(cfg, models)
}

function cmdBuild(cfg: CaracalConfig): void {
  if (cfg.mode === "local") {
    fail("'build' builds the Docker sandbox image and has no meaning in --local mode.")
    process.exit(1)
  }
  requireDocker()
  ensureImage(cfg, true)
}

async function cmdShell(cfg: CaracalConfig): Promise<void> {
  if (cfg.mode === "local") {
    fail("'shell' opens a shell inside the Docker sandbox — not applicable in --local mode.")
    log(`${DIM}You're already on the host; just open your own shell.${RESET}`)
    process.exit(1)
  }
  requireDocker()
  ensureImage(cfg)
  applyModels(cfg)
  ensureContainer(cfg)
  info("Opening a shell inside the sandbox…")
  const code = docker.execInteractive({
    container: cfg.container,
    env: { CARACAL_HITL: cfg.hitl },
    command: ["/bin/bash"],
  })
  process.exit(code)
}

function cmdStatus(cfg: CaracalConfig): void {
  log(`${BOLD}caracal status${RESET}`)
  log(`  mode             : ${cfg.mode === "local" ? YELLOW + "local (no isolation)" : GREEN + "sandbox"}${RESET}`)
  if (cfg.mode === "local") {
    log(`  opencode on PATH : ${local.isOpencodeInstalled() ? GREEN + "yes" : RED + "no"}${RESET}`)
    log(`  opencode config  : ${local.opencodeConfigDir()}`)
  } else {
    log(`  docker installed : ${docker.isDockerInstalled() ? GREEN + "yes" : RED + "no"}${RESET}`)
    log(`  docker running   : ${docker.isDockerRunning() ? GREEN + "yes" : RED + "no"}${RESET}`)
    log(
      `  image (${cfg.image}) : ${docker.imageExists(cfg.image) ? GREEN + "built" : YELLOW + "missing"}${RESET}`,
    )
    log(`  container        : ${cfg.container} -> ${docker.containerState(cfg.container)}`)
  }
  log(`  target           : ${cfg.target ?? `${DIM}(CARACAL_WORKSPACE override)${RESET}`}`)
  log(`  workspace        : ${cfg.workspace}`)
  if (cfg.dataDir) log(`  session data     : ${cfg.dataDir}`)
  log(`  HITL mode        : ${cfg.hitl}`)
  log(`  auth mode        : ${cfg.authMode}`)

  const agents = discoverAgentNames(cfg.repoRoot)
  const sel = loadSelection(targets.caracalHome(), cfg.model ?? FALLBACK_MODEL)
  const models = resolveModels(agents, sel)
  log(`  models           : ${DIM}(default ${sel.default}; edit with 'caracal models')${RESET}`)
  for (const a of agents) {
    const overridden = sel.agents[a] ? "" : `${DIM} (default)${RESET}`
    log(`    ${a.padEnd(14)} ${models[a]}${overridden}`)
  }
}

function cmdModels(cfg: CaracalConfig): void {
  const agents = discoverAgentNames(cfg.repoRoot)
  if (agents.length === 0) {
    fail("No agents found under runtime/agent/. Run from the caracal repo.")
    process.exit(1)
  }
  // `caracal models list` -> just print accessible model ids.
  if ((process.argv[3] ?? "").toLowerCase() === "list") {
    const models = listAccessibleModels()
    if (models.length === 0) {
      warn("Could not list models. Is opencode installed and authenticated on the host?")
      return
    }
    for (const m of models) log(m)
    return
  }
  mkdirSync(targets.caracalHome(), { recursive: true })
  void runInteractiveSelector(targets.caracalHome(), agents, cfg.model ?? FALLBACK_MODEL).then(
    (sel) => {
      ok(`Saved model selection to ${selectionPath(targets.caracalHome())}`)
      log(`${DIM}Applied on next launch (written into <workspace>/opencode.json).${RESET}`)
      const resolved = resolveModels(agents, sel)
      for (const a of agents) log(`  ${a.padEnd(14)} ${resolved[a]}`)
    },
  )
}

/** Show, create+select, or delete the active target (engagement). */
function cmdTarget(cfg: CaracalConfig): void {
  const arg = process.argv[3]
  if (arg === "rm" || arg === "delete" || arg === "remove") {
    cmdTargetRm(cfg, process.argv[4], process.argv[5])
    return
  }
  if (!arg) {
    const active = targets.getActiveTarget() ?? targets.DEFAULT_TARGET
    log(`${BOLD}active target${RESET}: ${active}`)
    log(`  dir       : ${targets.targetDir(active)}`)
    log(`  workspace : ${targets.targetWorkspace(active)}`)
    log(`${DIM}select/create: caracal target <name>  ·  list: caracal targets${RESET}`)
    return
  }
  if (!targets.isValidTargetName(arg)) {
    fail(`Invalid target name '${arg}'. Use letters, digits, . _ - (max 64 chars).`)
    process.exit(1)
  }
  const fresh = !targets.targetExists(arg)
  targets.ensureTarget(arg)
  targets.setActiveTarget(arg)
  ok(`${fresh ? "Created and selected" : "Selected"} target '${arg}'.`)
  log(`  ${targets.targetDir(arg)}`)
  log(`${DIM}run 'caracal' to launch it.${RESET}`)
}

/** Permanently delete a target and all its files (dry-run unless --force). */
function cmdTargetRm(cfg: CaracalConfig, name?: string, flag?: string): void {
  if (!name) {
    fail("Usage: caracal rm <target> [--force]   (to remove the container, use 'caracal down')")
    process.exit(1)
  }
  if (!targets.targetExists(name)) {
    warn(`Target '${name}' does not exist.`)
    return
  }
  const dir = targets.targetDir(name)
  const force = flag === "--force" || flag === "-f" || flag === "-y"
  if (!force) {
    warn(`This permanently deletes target '${name}' and ALL its files (loot, reports, session):`)
    log(`  ${dir}`)
    log(`${DIM}Re-run to confirm:  caracal rm ${name} --force${RESET}`)
    return
  }
  // If the sandbox is bound to this target, remove it first so nothing dangles.
  if (
    docker.isDockerInstalled() &&
    docker.containerState(cfg.container) !== "absent" &&
    resolve(docker.containerWorkspace(cfg.container) || "/") ===
      resolve(targets.targetWorkspace(name))
  ) {
    docker.removeContainer(cfg.container)
    info("Removed the sandbox bound to this target.")
  }
  const wasActive = targets.getActiveTarget() === name
  targets.deleteTarget(name)
  ok(`Deleted target '${name}'.`)
  if (wasActive) {
    log(`${DIM}No active target now — next 'caracal' uses '${targets.DEFAULT_TARGET}'.${RESET}`)
  }
}

/** List saved targets, marking the active one. */
function cmdTargets(): void {
  const active = targets.getActiveTarget() ?? targets.DEFAULT_TARGET
  const all = targets.listTargets()
  if (all.length === 0) {
    warn("No targets yet. Create one with: caracal target <name>")
    return
  }
  log(`${BOLD}targets${RESET} ${DIM}(${targets.targetsRoot()})${RESET}`)
  for (const t of all) {
    const mark = t === active ? `${GREEN}●${RESET}` : " "
    const tag = t === active ? `${DIM} (active)${RESET}` : ""
    log(`  ${mark} ${t}${tag}`)
  }
}

/** Wipe a target's opencode session/context, keeping its engagement files. */
function cmdReset(cfg: CaracalConfig): void {
  const name = process.argv[3] ?? targets.getActiveTarget() ?? targets.DEFAULT_TARGET
  if (!targets.targetExists(name)) {
    warn(`Target '${name}' does not exist — nothing to reset.`)
    return
  }
  // If the sandbox is currently bound to this target, remove it so the wiped
  // session is recreated clean on next launch.
  if (
    docker.isDockerInstalled() &&
    docker.containerState(cfg.container) !== "absent" &&
    resolve(docker.containerWorkspace(cfg.container) || "/") ===
      resolve(targets.targetWorkspace(name))
  ) {
    docker.removeContainer(cfg.container)
    info("Removed the sandbox bound to this target.")
  }
  rmSync(targets.targetDataDir(name), { recursive: true, force: true })
  mkdirSync(targets.targetDataDir(name), { recursive: true })
  ok(`Reset session/context for target '${name}'. Engagement files kept.`)
  log(`${DIM}Files: ${targets.targetWorkspace(name)}${RESET}`)
}

function cmdStop(cfg: CaracalConfig): void {
  requireDocker()
  if (docker.containerState(cfg.container) === "absent") {
    warn("No sandbox container to stop.")
    return
  }
  docker.stopContainer(cfg.container)
  ok("Sandbox stopped.")
}

function cmdDown(cfg: CaracalConfig): void {
  requireDocker()
  if (docker.containerState(cfg.container) === "absent") {
    warn("No sandbox container to remove.")
    return
  }
  docker.removeContainer(cfg.container)
  ok("Sandbox removed.")
}

/** Extract --local / --sandbox / --yolo from argv (any position); mutates argv to
 *  remove them so positional-arg parsing elsewhere (process.argv[3], [4], ...)
 *  is unaffected. */
function extractFlags(argv: string[]): { mode: RunMode | undefined; yolo: boolean } {
  let mode: RunMode | undefined
  let yolo = false
  for (let i = argv.length - 1; i >= 0; i--) {
    if (argv[i] === "--local") mode = mode ?? "local"
    else if (argv[i] === "--sandbox") mode = mode ?? "sandbox"
    else if (argv[i] === "--yolo") yolo = true
    else continue
    argv.splice(i, 1)
  }
  return { mode, yolo }
}

async function main(): Promise<void> {
  const { mode, yolo } = extractFlags(process.argv)
  const cfg = loadConfig(process.cwd(), mode, yolo ? "auto" : undefined)
  const arg = (process.argv[2] ?? "").toLowerCase()

  switch (arg) {
    case "":
    case "start":
    case "launch":
    case "up":
      await cmdLaunch(cfg, yolo)
      break
    case "target":
    case "use":
      cmdTarget(cfg)
      break
    case "targets":
    case "ls":
      cmdTargets()
      break
    case "reset":
      cmdReset(cfg)
      break
    case "build":
      cmdBuild(cfg)
      break
    case "shell":
    case "sh":
      await cmdShell(cfg)
      break
    case "status":
    case "ps":
      cmdStatus(cfg)
      break
    case "models":
    case "model":
      cmdModels(cfg)
      break
    case "stop":
      cmdStop(cfg)
      break
    case "down":
      cmdDown(cfg)
      break
    case "rm":
    case "delete":
      // Top-level convenience for `target rm`: delete a target by name.
      cmdTargetRm(cfg, process.argv[3], process.argv[4])
      break
    case "help":
    case "-h":
    case "--help":
      printHelp(cfg)
      break
    case "version":
    case "-v":
    case "--version":
      log(version(cfg))
      break
    default:
      fail(`Unknown command: ${arg}`)
      printHelp(cfg)
      process.exit(1)
  }
}

main().catch((e) => {
  fail(e instanceof Error ? e.message : String(e))
  process.exit(1)
})
