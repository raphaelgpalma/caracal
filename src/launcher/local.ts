/**
 * Local mode: run opencode directly on the host instead of the Docker sandbox.
 *
 * There is no container isolation here — the model's bash tool runs with the
 * operator's own privileges, network, and filesystem. To keep the Caracal
 * architecture (plugin, agents, HITL policy) working the same way, we sync
 * `runtime/{opencode.json,plugin/,agent/}` into the host's opencode global
 * config (~/.config/opencode), mirroring what the Dockerfile bakes into the
 * sandbox image.
 */
import { spawnSync } from "node:child_process"
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"

/** Host opencode global config dir (same layout the Dockerfile bakes in). */
export function opencodeConfigDir(): string {
  return process.env.OPENCODE_CONFIG_DIR
    ? resolve(process.env.OPENCODE_CONFIG_DIR)
    : resolve(homedir(), ".config", "opencode")
}

export function isOpencodeInstalled(): boolean {
  const r = spawnSync("opencode", ["--version"], { encoding: "utf8" })
  return r.status === 0
}

/**
 * Copy the Caracal runtime config (opencode.json, plugin/, agent/) into the
 * host's opencode global config dir, then install the plugin's runtime deps.
 * Idempotent — safe to call on every launch so edits to runtime/ take effect.
 */
export function syncLocalConfig(repoRoot: string): void {
  const dest = opencodeConfigDir()
  mkdirSync(dest, { recursive: true })

  cpSync(resolve(repoRoot, "runtime", "opencode.json"), join(dest, "opencode.json"))

  const pluginDest = join(dest, "plugin")
  rmSync(pluginDest, { recursive: true, force: true })
  mkdirSync(pluginDest, { recursive: true })
  // Only the plugin source goes here — opencode treats every file in this
  // directory as a plugin, so package.json/tsconfig must NOT be copied in.
  cpSync(
    resolve(repoRoot, "runtime", "plugin", "caracal.ts"),
    join(pluginDest, "caracal.ts"),
  )

  const agentDest = join(dest, "agent")
  rmSync(agentDest, { recursive: true, force: true })
  cpSync(resolve(repoRoot, "runtime", "agent"), agentDest, { recursive: true })

  cpSync(resolve(repoRoot, "runtime", "plugin", "package.json"), join(dest, "package.json"))
  const pkgLock = resolve(repoRoot, "runtime", "plugin", "package-lock.json")
  if (existsSync(pkgLock)) cpSync(pkgLock, join(dest, "package-lock.json"))

  spawnSync("npm", ["install", "--no-audit", "--no-fund", "--omit=dev"], {
    cwd: dest,
    stdio: "ignore",
  })
}

/** Read the pinned opencode version from the Dockerfile (informational only —
 *  local mode uses whatever opencode is already on the host's PATH). */
export function readPinnedOpencodeVersion(repoRoot: string): string | undefined {
  try {
    const dockerfile = readFileSync(resolve(repoRoot, "docker", "Dockerfile"), "utf8")
    const m = /ARG OPENCODE_VERSION=([^\s]+)/.exec(dockerfile)
    return m?.[1]
  } catch {
    return undefined
  }
}

/** Run opencode interactively on the host, inheriting stdio. */
export function execLocal(opts: {
  cwd: string
  env: Record<string, string>
  command: string[]
}): number {
  const r = spawnSync(opts.command[0]!, opts.command.slice(1), {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    stdio: "inherit",
  })
  return r.status ?? 1
}
