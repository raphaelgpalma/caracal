/**
 * Launcher configuration: resolves paths and reads settings from the
 * environment and an optional `.env` file in the current working directory.
 */
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, isAbsolute, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { DEFAULT_TARGET, getActiveTarget, targetDataDir, targetWorkspace } from "./targets.js"

export type HitlMode = "strict" | "guided" | "auto"
export type AuthMode = "mount" | "env"
export type RunMode = "sandbox" | "local"

export interface CaracalConfig {
  /** Root of the caracal repo (contains docker/Dockerfile and runtime/). */
  repoRoot: string
  /** "sandbox" (default, Docker-isolated) or "local" (runs directly on the host). */
  mode: RunMode
  /** Docker image tag to build/run. */
  image: string
  /** Container name. */
  container: string
  /** opencode version baked into the image at build time. */
  opencodeVersion: string
  /** Active target name (undefined when a raw CARACAL_WORKSPACE override is used). */
  target: string | undefined
  /** Absolute path to the host engagement workspace (mounted into the sandbox). */
  workspace: string
  /** Per-target opencode data dir (sessions/snapshots) mounted into the sandbox.
   *  undefined for raw CARACAL_WORKSPACE overrides → ephemeral sessions (legacy). */
  dataDir: string | undefined
  /** HITL policy mode passed into the sandbox. */
  hitl: HitlMode
  /** How model-provider credentials reach the sandbox. */
  authMode: AuthMode
  /** Absolute path to the host opencode auth.json (for authMode=mount). */
  hostAuthFile: string
  /** Optional default model (provider/model) passed to opencode. */
  model: string | undefined
}

/** Minimal `.env` parser — no dependency. Existing process.env always wins. */
function loadDotEnv(cwd: string): void {
  const file = resolve(cwd, ".env")
  if (!existsSync(file)) return
  for (const raw of readFileSync(file, "utf8").split("\n")) {
    const line = raw.trim()
    if (!line || line.startsWith("#")) continue
    const eq = line.indexOf("=")
    if (eq === -1) continue
    const key = line.slice(0, eq).trim()
    let val = line.slice(eq + 1).trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    if (process.env[key] === undefined) process.env[key] = val
  }
}

function asHitl(v: string | undefined): HitlMode {
  return v === "guided" || v === "auto" ? v : "strict"
}

function resolveRepoRoot(): string {
  // dist/launcher/index.js OR src/launcher/index.ts -> repo root is two up.
  const here = dirname(fileURLToPath(import.meta.url))
  return resolve(here, "..", "..")
}

/** Resolve run mode: --local/--sandbox flag (highest priority) > CARACAL_MODE > sandbox (default). */
function resolveMode(flag: RunMode | undefined): RunMode {
  if (flag) return flag
  const v = (process.env.CARACAL_MODE ?? "").toLowerCase()
  return v === "local" ? "local" : "sandbox"
}

export function loadConfig(
  cwd: string = process.cwd(),
  modeFlag?: RunMode,
): CaracalConfig {
  loadDotEnv(cwd)

  // Workspace + opencode data dir come from the active target. A raw
  // CARACAL_WORKSPACE override pins a workspace directly (advanced/legacy) and gets
  // no persistent data dir → ephemeral sessions, the pre-targets behavior.
  let target: string | undefined
  let workspace: string
  let dataDir: string | undefined
  const wsOverride = process.env.CARACAL_WORKSPACE
  if (wsOverride) {
    workspace = isAbsolute(wsOverride) ? wsOverride : resolve(cwd, wsOverride)
  } else {
    target = getActiveTarget() ?? DEFAULT_TARGET
    workspace = targetWorkspace(target)
    dataDir = targetDataDir(target)
  }

  return {
    repoRoot: resolveRepoRoot(),
    mode: resolveMode(modeFlag),
    image: process.env.CARACAL_IMAGE ?? "caracal:latest",
    container: process.env.CARACAL_CONTAINER ?? "caracal-sandbox",
    opencodeVersion: process.env.OPENCODE_VERSION ?? "1.17.8",
    target,
    workspace,
    dataDir,
    hitl: asHitl(process.env.CARACAL_HITL),
    authMode: process.env.CARACAL_AUTH_MODE === "env" ? "env" : "mount",
    hostAuthFile: resolve(homedir(), ".local/share/opencode/auth.json"),
    model: process.env.CARACAL_MODEL || undefined,
  }
}
