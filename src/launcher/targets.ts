/**
 * Target (engagement) management.
 *
 * Each target is a self-contained, persistent environment on the host:
 *
 *   $CARACAL_HOME/targets/<name>/
 *     engagement/   -> mounted at /root/engagement             (recon, loot, reports…)
 *     .opencode/    -> mounted at /root/.local/share/opencode  (sessions, snapshots, db)
 *
 * Containers are disposable; switching the active target recreates the container
 * bound to that target's folders. State therefore persists per target on the
 * host, so resuming a previous target restores both its files AND its opencode
 * session/context, while a new target is a clean, separate session.
 *
 * Secrets never land here: auth.json is mounted read-only on top of .opencode at
 * runtime, so the host target folder holds the session DB but not the API key.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"

/** Target used when none is selected, so `caracal` works out of the box. */
export const DEFAULT_TARGET = "default"

/** Caracal state home: model selection, active-target pointer, and targets/. */
export function caracalHome(): string {
  return process.env.CARACAL_HOME ? resolve(process.env.CARACAL_HOME) : resolve(homedir(), ".caracal")
}

export function targetsRoot(): string {
  return process.env.CARACAL_TARGETS_DIR
    ? resolve(process.env.CARACAL_TARGETS_DIR)
    : join(caracalHome(), "targets")
}

const activeFile = (): string => join(caracalHome(), "active")

/** Safe as a directory name and unlikely to surprise the shell / docker. */
export function isValidTargetName(name: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(name)
}

export const targetDir = (name: string): string => join(targetsRoot(), name)
export const targetWorkspace = (name: string): string => join(targetDir(name), "engagement")
export const targetDataDir = (name: string): string => join(targetDir(name), ".opencode")

export function targetExists(name: string): boolean {
  return existsSync(targetDir(name))
}

/** Create a target's folders if missing (idempotent). */
export function ensureTarget(name: string): void {
  mkdirSync(targetWorkspace(name), { recursive: true })
  mkdirSync(targetDataDir(name), { recursive: true })
}

export function listTargets(): string[] {
  const root = targetsRoot()
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()
}

export function getActiveTarget(): string | undefined {
  try {
    const v = readFileSync(activeFile(), "utf8").trim()
    return v || undefined
  } catch {
    return undefined
  }
}

export function setActiveTarget(name: string): void {
  mkdirSync(caracalHome(), { recursive: true })
  writeFileSync(activeFile(), `${name}\n`, "utf8")
}

/** Forget the active-target pointer (next launch falls back to DEFAULT_TARGET). */
export function clearActiveTarget(): void {
  try {
    rmSync(activeFile(), { force: true })
  } catch {
    // nothing to clear
  }
}

/** Permanently delete a target and ALL its files. Caller must confirm intent. */
export function deleteTarget(name: string): void {
  rmSync(targetDir(name), { recursive: true, force: true })
  if (getActiveTarget() === name) clearActiveTarget()
}

/** Last-modified time of the target's engagement dir (for `targets` listing). */
export function targetMtimeMs(name: string): number {
  try {
    return statSync(targetWorkspace(name)).mtimeMs
  } catch {
    return 0
  }
}
