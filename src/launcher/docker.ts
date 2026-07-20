/**
 * Thin wrappers around the Docker CLI. We shell out to `docker` rather than use
 * a library so behavior matches what a user would run by hand, and so the only
 * host requirement is the Docker CLI itself.
 */
import { spawnSync } from "node:child_process"

/** Run docker quietly and return {ok, stdout}. Never throws. */
function dockerCapture(args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const r = spawnSync("docker", args, { encoding: "utf8" })
  return {
    ok: r.status === 0,
    stdout: (r.stdout ?? "").trim(),
    stderr: (r.stderr ?? "").trim(),
  }
}

/** Run docker with inherited stdio (for interactive / streaming commands). */
function dockerInherit(args: string[]): number {
  const r = spawnSync("docker", args, { stdio: "inherit" })
  return r.status ?? 1
}

export function isDockerInstalled(): boolean {
  return dockerCapture(["--version"]).ok
}

export function isDockerRunning(): boolean {
  return dockerCapture(["info"]).ok
}

export function imageExists(image: string): boolean {
  return dockerCapture(["image", "inspect", image]).ok
}

/** "running" | "stopped" | "absent" */
export function containerState(name: string): "running" | "stopped" | "absent" {
  const r = dockerCapture(["inspect", "-f", "{{.State.Running}}", name])
  if (!r.ok) return "absent"
  return r.stdout === "true" ? "running" : "stopped"
}

/** Host path currently bind-mounted at /root/engagement (empty if none/absent).
 *  Used to detect a target switch so the sandbox can be recreated. */
export function containerWorkspace(name: string): string {
  const r = dockerCapture([
    "inspect",
    "-f",
    '{{range .Mounts}}{{if eq .Destination "/root/engagement"}}{{.Source}}{{end}}{{end}}',
    name,
  ])
  return r.ok ? r.stdout : ""
}

export function buildImage(opts: {
  image: string
  context: string
  dockerfile: string
  opencodeVersion: string
}): number {
  return dockerInherit([
    "build",
    "-t",
    opts.image,
    "-f",
    opts.dockerfile,
    "--build-arg",
    `OPENCODE_VERSION=${opts.opencodeVersion}`,
    opts.context,
  ])
}

export interface RunOptions {
  image: string
  container: string
  workspace: string
  hitl: string
  /** Per-target opencode data dir → /root/.local/share/opencode (persistent
   *  sessions/snapshots). Omitted for raw-workspace overrides (ephemeral). */
  dataDir?: string
  /** [hostPath, containerPath, ro?] tuples for extra mounts (e.g. auth.json). */
  mounts: Array<[string, string, boolean?]>
  /** Extra `-e KEY=VALUE` environment entries. */
  env: Record<string, string>
}

/**
 * Start a detached, host-networked sandbox container with the capabilities
 * required for pentesting. The image's CMD (`sleep infinity`) keeps it alive so
 * we can `docker exec` opencode into it on demand.
 */
export function runContainer(opts: RunOptions): number {
  const args = [
    "run",
    "-d",
    "--name",
    opts.container,
    "--hostname",
    "caracal",
    // Full host network access for pentesting (Linux).
    "--network",
    "host",
    "--cap-add",
    "NET_ADMIN",
    "--cap-add",
    "NET_RAW",
    "--security-opt",
    "seccomp=unconfined",
    "-e",
    "CARACAL_SANDBOX=1",
    "-e",
    `CARACAL_HITL=${opts.hitl}`,
    "-e",
    "CARACAL_WORKSPACE_DIR=/root/engagement",
    "-v",
    `${opts.workspace}:/root/engagement`,
  ]
  // Per-target opencode data dir (persistent sessions). auth.json is layered on
  // top of this via opts.mounts as a nested read-only mount, so the API key is
  // never written into the target folder.
  if (opts.dataDir) {
    args.push("-v", `${opts.dataDir}:/root/.local/share/opencode`)
  }
  for (const [host, dest, ro] of opts.mounts) {
    args.push("-v", `${host}:${dest}${ro ? ":ro" : ""}`)
  }
  for (const [k, v] of Object.entries(opts.env)) {
    args.push("-e", `${k}=${v}`)
  }
  args.push(opts.image)
  return dockerInherit(args)
}

export function startContainer(name: string): number {
  return dockerInherit(["start", name])
}

export function stopContainer(name: string): number {
  return dockerInherit(["stop", name])
}

export function removeContainer(name: string): number {
  return dockerInherit(["rm", "-f", name])
}

/** Interactive `opencode` (or any command) inside the running sandbox. */
export function execInteractive(opts: {
  container: string
  env: Record<string, string>
  command: string[]
  workdir?: string
}): number {
  const args = ["exec", "-it", "-w", opts.workdir ?? "/root/engagement"]
  for (const [k, v] of Object.entries(opts.env)) {
    args.push("-e", `${k}=${v}`)
  }
  args.push(opts.container, ...opts.command)
  return dockerInherit(args)
}
