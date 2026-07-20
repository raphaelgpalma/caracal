/**
 * Caracal — opencode plugin
 * ==========================
 *
 * This single plugin file is the heart of Caracal's safety + tooling layer. It
 * is loaded by opencode as GLOBAL config (~/.config/opencode/plugin/caracal.ts)
 * — baked into the Docker sandbox image, or installed onto the host for local
 * mode — and provides four things:
 *
 *   1. A consistent Human-In-The-Loop (HITL) policy, mirroring CAI's philosophy
 *      that a human stays in control of dangerous actions. Implemented on top of
 *      opencode's native permission machinery (`permission.ask`).
 *
 *   2. A hard safety floor (`tool.execute.before`): destructive and
 *      host-escape commands are blocked in *every* mode, and offensive tooling
 *      refuses to run unless launched via `caracal` (sandbox or local mode) —
 *      never from a bare, unmanaged opencode session.
 *
 *   3. Engagement helper tools (`tool`): structured note-taking and scope
 *      reading, so agents keep findings organized in the workspace.
 *
 *   4. The orchestration pattern engine (Phase 2): parallel / pipeline / swarm
 *      tools that drive agents via the opencode SDK client. These are enabled
 *      only on the orchestrator (subagents disable them).
 *
 * NOTE: opencode loads *every* file in the plugin directory as a plugin, so this
 * stays a single self-contained file. Helper functions are module-private (not
 * exported); only `CaracalPlugin` is exported.
 */

import { tool, type Plugin } from "@opencode-ai/plugin"
import { execFile } from "node:child_process"
import { appendFile, mkdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"

// ---------------------------------------------------------------------------
// HITL modes
// ---------------------------------------------------------------------------

/** strict = ask before anything intrusive · guided = ask before high-impact · auto = no prompts (lab only). */
type HitlMode = "strict" | "guided" | "auto"

/** How opencode was launched: Docker sandbox, or directly on the host ("local"). */
type RunMode = "sandbox" | "local" | "unmanaged"

function runMode(): RunMode {
  if (process.env.CARACAL_SANDBOX === "1") return "sandbox"
  if (process.env.CARACAL_LOCAL === "1") return "local"
  return "unmanaged"
}

function hitlMode(): HitlMode {
  const v = (process.env.CARACAL_HITL ?? "strict").toLowerCase()
  const requested = v === "guided" || v === "auto" ? v : "strict"
  // Local mode has no container isolation, so silent `auto` is never allowed —
  // the floor is `guided` (still pauses for exploit/script/unknown actions).
  if (runMode() === "local" && requested === "auto") return "guided"
  return requested
}

/** True whenever launched through `caracal` — sandboxed or local. Offensive
 *  tooling requires this; a bare opencode session (unmanaged) never qualifies. */
function isManaged(): boolean {
  return runMode() !== "unmanaged"
}

// ---------------------------------------------------------------------------
// Command risk classification
// ---------------------------------------------------------------------------
//
// This is the Caracal analogue of CAI's per-category tools. Instead of wrapping
// every binary as its own tool, we let agents use opencode's robust `bash` tool
// and classify each command into a risk tier. The tier drives the HITL decision.

type RiskTier =
  | "destructive" // irreversible damage — always denied
  | "escape" // attempts to break out of the sandbox / reach the host — always denied
  | "exploit" // active exploitation / credential attacks / shells — high impact
  | "recon" // active scanning / enumeration against targets — intrusive
  | "provision" // local package install (apt/pip/...) — set up tooling on demand
  | "script" // arbitrary interpreters (python/sh -c ...) — intent unknown
  | "readonly" // local, non-intrusive inspection — safe
  | "unknown" // unrecognized — treated cautiously

/** Patterns that must NEVER run, regardless of HITL mode. Irreversible / catastrophic. */
const DESTRUCTIVE_PATTERNS: RegExp[] = [
  /\brm\s+(-[a-z]*\s+)*-[a-z]*r[a-z]*f|\brm\s+(-[a-z]*\s+)*-[a-z]*f[a-z]*r/i, // rm -rf style...
  /\brm\s+(-[a-zA-Z]+\s+)*(\/|\/\*|~|\$HOME)(\s|$)/i, // ...targeting / ~ $HOME
  /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, // fork bomb
  /\bmkfs(\.\w+)?\b/i,
  /\bwipefs\b/i,
  /\bdd\b[^\n]*\bof=\/dev\/(sd|nvme|vd|hd|xvd|disk)/i,
  /[>]\s*\/dev\/(sd|nvme|vd|hd|xvd)/i,
  /\b(shutdown|reboot|halt|poweroff)\b/i,
  /\binit\s+[06]\b/i,
  /\bchmod\s+-R\s+0*777\s+\//,
  /\bchown\s+-R\s+[^\s]+\s+\/(\s|$)/,
]

/** Patterns that try to escape the container or reach the host. Always denied. */
const ESCAPE_PATTERNS: RegExp[] = [
  /\bnsenter\b/i,
  /\b\/var\/run\/docker\.sock\b/i,
  /\bdocker\s+(run|exec|-H|--host)\b/i,
  /\bchroot\b/i,
  /\/proc\/1\/root\b/i,
  /\/proc\/sysrq-trigger\b/i,
  /\/dev\/(mem|kmem|kcore)\b/i,
  /\bmount\s+[^\n]*\/host\b/i,
]

/** Active exploitation / credential attacks / shells. */
const EXPLOIT_BINARIES = [
  "sqlmap",
  "msfconsole",
  "msfvenom",
  "metasploit",
  "hydra",
  "medusa",
  "ncrack",
  "crackmapexec",
  "cme",
  "netexec",
  "nxc",
  "evil-winrm",
  "responder",
  "john",
  "hashcat",
  "patator",
]
/** Reverse/bind-shell tells that are exploit-grade regardless of binary. */
const EXPLOIT_PATTERNS: RegExp[] = [
  /\/dev\/tcp\//i, // bash reverse shell
  /\bnc\b[^\n]*\s-[a-z]*e\b/i, // nc -e
  /\bncat\b[^\n]*--exec\b/i,
  /\bbash\s+-i\b/i,
  /\bpython3?\b[^\n]*socket\b[^\n]*(connect|bind)/i,
]

/** Active reconnaissance / enumeration — intrusive but standard pentest recon. */
const RECON_BINARIES = [
  "nmap",
  "masscan",
  "rustscan",
  "gobuster",
  "ffuf",
  "feroxbuster",
  "dirb",
  "dirbuster",
  "wfuzz",
  "nikto",
  "whatweb",
  "wpscan",
  "nuclei",
  "enum4linux",
  "enum4linux-ng",
  "dnsenum",
  "dnsrecon",
  "fierce",
  "sublist3r",
  "amass",
  "testssl.sh",
  "onesixtyone",
  "snmpwalk",
]

/** Local, non-intrusive inspection. Safe to auto-allow. */
const READONLY_BINARIES = [
  "ls",
  "cat",
  "head",
  "tail",
  "less",
  "more",
  "pwd",
  "cd",
  "echo",
  "printf",
  "whoami",
  "id",
  "uname",
  "hostname",
  "date",
  "env",
  "which",
  "type",
  "file",
  "stat",
  "wc",
  "sort",
  "uniq",
  "cut",
  "tr",
  "find",
  "grep",
  "egrep",
  "rg",
  "awk",
  "jq",
  "strings",
  "xxd",
  "md5sum",
  "sha1sum",
  "sha256sum",
  "dig",
  "nslookup",
  "host",
  "whois",
]

/** Interpreters whose intent we cannot infer from the command alone. */
const SCRIPT_BINARIES = [
  "python",
  "python3",
  "perl",
  "ruby",
  "php",
  "node",
  "bash",
  "sh",
  "zsh",
  "lua",
]

/** Package managers — installing tooling on demand inside the sandbox. */
const PROVISION_BINARIES = [
  "apt",
  "apt-get",
  "aptitude",
  "dpkg",
  "pip",
  "pip3",
  "pipx",
  "gem",
  "go",
  "cargo",
]

/** Split a command line into segments across shell operators, returning the leading binary of each. */
function leadingBinaries(command: string): string[] {
  const segments = command.split(/\||;|&&|\|\||\n|`|\$\(/)
  const bins: string[] = []
  for (const seg of segments) {
    const trimmed = seg
      .trim()
      .replace(/^[({]+/, "")
      .trim()
    if (!trimmed) continue
    // strip leading env assignments like FOO=bar cmd
    const withoutEnv = trimmed.replace(/^(\w+=\S+\s+)+/, "")
    const token = withoutEnv.split(/\s+/)[0] ?? ""
    const bin = token.split("/").pop() ?? token // basename of /usr/bin/nmap -> nmap
    if (bin) bins.push(bin.toLowerCase())
  }
  return bins
}

function classifyCommand(command: string): RiskTier {
  const cmd = command.trim()
  if (!cmd) return "readonly"

  // Hard-deny tiers first (whole-string regex).
  if (ESCAPE_PATTERNS.some((re) => re.test(cmd))) return "escape"
  if (DESTRUCTIVE_PATTERNS.some((re) => re.test(cmd))) return "destructive"
  if (EXPLOIT_PATTERNS.some((re) => re.test(cmd))) return "exploit"

  const bins = leadingBinaries(cmd)
  if (bins.length === 0) return "unknown"

  const has = (list: string[]) => bins.some((b) => list.includes(b))

  if (has(EXPLOIT_BINARIES)) return "exploit"
  if (has(RECON_BINARIES)) return "recon"
  if (has(PROVISION_BINARIES)) return "provision"

  // If every segment is a known readonly binary, it's safe. A single unknown
  // segment downgrades the whole pipeline to a more cautious tier.
  const allReadonly = bins.every((b) => READONLY_BINARIES.includes(b))
  if (allReadonly) return "readonly"

  if (has(SCRIPT_BINARIES)) return "script"
  return "unknown"
}

// ---------------------------------------------------------------------------
// HITL decision matrix
// ---------------------------------------------------------------------------

type Decision = "allow" | "ask" | "deny"

function decideForBash(tier: RiskTier, mode: HitlMode): { decision: Decision; reason: string } {
  if (tier === "destructive")
    return { decision: "deny", reason: "destructive / irreversible command" }
  if (tier === "escape") return { decision: "deny", reason: "sandbox-escape / host-access attempt" }

  if (mode === "auto") return { decision: "allow", reason: "auto mode (lab use)" }

  switch (tier) {
    case "readonly":
      return { decision: "allow", reason: "read-only inspection" }
    case "recon":
      return mode === "strict"
        ? { decision: "ask", reason: "active reconnaissance against a target" }
        : { decision: "allow", reason: "recon allowed in guided mode" }
    case "provision":
      return mode === "strict"
        ? { decision: "ask", reason: "installing tooling (package manager)" }
        : { decision: "allow", reason: "tool install allowed in guided mode" }
    case "exploit":
      return { decision: "ask", reason: "active exploitation / high impact" }
    case "script":
      return { decision: "ask", reason: "arbitrary interpreter — intent unknown" }
    default:
      return { decision: "ask", reason: "unrecognized command — review before running" }
  }
}

function decideForEdit(mode: HitlMode): { decision: Decision; reason: string } {
  // Writes outside the workspace are already blocked by opencode's
  // `external_directory: deny`. Inside the workspace, edits are low risk.
  if (mode === "auto" || mode === "guided")
    return { decision: "allow", reason: "edit within engagement workspace" }
  return { decision: "ask", reason: "file write (strict mode)" }
}

/** Best-effort extraction of the shell command from a Permission object. */
function commandFromPermission(p: {
  title?: string
  pattern?: string | string[]
  metadata?: Record<string, unknown>
}): string {
  const meta = p.metadata ?? {}
  const fromMeta = typeof meta["command"] === "string" ? (meta["command"] as string) : ""
  if (fromMeta) return fromMeta
  if (typeof p.title === "string" && p.title) return p.title
  if (typeof p.pattern === "string") return p.pattern
  if (Array.isArray(p.pattern)) return p.pattern.join(" ")
  return ""
}

function log(msg: string): void {
  // opencode captures plugin stderr into its logs.
  console.error(`[caracal] ${msg}`)
}

// ---------------------------------------------------------------------------
// On-demand tooling install
// ---------------------------------------------------------------------------
//
// The sandbox image ships a lean recon+web toolset; specialist agents install
// what they need on demand via apt. `caracal_install` accepts only vetted security
// packages (a guard against typo-squat / arbitrary installs). Anything outside
// the allowlist goes through bash, where the HITL "provision" tier applies.

const execFileAsync = promisify(execFile)
const APT_ENV = { ...process.env, DEBIAN_FRONTEND: "noninteractive" }

/** Vetted apt packages installable via `caracal_install` (Kali repos). */
const INSTALL_ALLOWLIST: Set<string> = new Set([
  // recon / enumeration
  "nmap",
  "masscan",
  "rustscan",
  "amass",
  "dnsenum",
  "dnsrecon",
  "fierce",
  "sublist3r",
  "theharvester",
  "onesixtyone",
  "snmp",
  "nbtscan",
  "dnsutils",
  "whatweb",
  "wafw00f",
  // web
  "nikto",
  "gobuster",
  "ffuf",
  "feroxbuster",
  "dirb",
  "dirbuster",
  "wfuzz",
  "sqlmap",
  "wpscan",
  "nuclei",
  "commix",
  "xsser",
  "joomscan",
  "sslscan",
  // credential attacks
  "hydra",
  "thc-hydra",
  "medusa",
  "ncrack",
  "patator",
  "john",
  "hashcat",
  "crackmapexec",
  "netexec",
  // active directory / windows / smb
  "smbclient",
  "smbmap",
  "enum4linux",
  "ldap-utils",
  "evil-winrm",
  "kerbrute",
  "impacket-scripts",
  "polenum",
  "responder",
  "bloodhound",
  "rpcbind",
  // exploitation / post-exploitation
  "metasploit-framework",
  "exploitdb",
  "powershell",
  "chisel",
  "socat",
  "proxychains4",
  "sshuttle",
  "ligolo-ng",
  // ctf / reversing / stego
  "binwalk",
  "foremost",
  "steghide",
  "stegseek",
  "zsteg",
  "fcrackzip",
  "pdfcrack",
  "qpdf",
  "exiftool",
  "libimage-exiftool-perl",
  "gdb",
  "radare2",
  "ltrace",
  "strace",
  "hexedit",
  "bsdmainutils",
  // wordlists / general
  "seclists",
  "wordlists",
  "git",
  "curl",
  "wget",
  "jq",
  "python3-pip",
  "pipx",
  "unzip",
])

/** Append an audit line to the engagement log for an on-demand install. */
async function appendInstallNote(directory: string, pkgs: string[]): Promise<void> {
  try {
    const dir = join(directory, "notes")
    await mkdir(dir, { recursive: true })
    const stamp = new Date().toISOString()
    await appendFile(
      join(dir, "engagement-log.md"),
      `\n## ${stamp} · [general]\n\nInstalled tooling on demand: ${pkgs.join(", ")}\n`,
      "utf8",
    )
  } catch {
    // best-effort audit; never fail the install over a note
  }
}

// ---------------------------------------------------------------------------
// Orchestration pattern engine (Phase 2)
// ---------------------------------------------------------------------------
//
// The engine is the Caracal analogue of CAI's pattern system. It drives agents
// programmatically through the opencode SDK client (session.create +
// session.prompt with a target `agent`), implementing fixed coordination
// topologies instead of leaving coordination to the LLM's improvisation.
//
// It is exposed as tools that are enabled ONLY on the orchestrator (subagents
// disable them). That both limits per-turn token cost and prevents recursive
// orchestration — a subagent cannot spawn further swarms (no runaway).

/** Minimal structural view of the opencode client — only what the engine uses. */
interface EngineClient {
  session: {
    create(opts: {
      body?: { parentID?: string; title?: string }
      query?: { directory?: string }
    }): Promise<{ data?: { id: string }; error?: unknown }>
    prompt(opts: {
      path: { id: string }
      body: { agent?: string; parts: Array<{ type: "text"; text: string }> }
      query?: { directory?: string }
    }): Promise<{ data?: { parts?: Array<{ type: string; text?: string }> }; error?: unknown }>
    abort(opts: { path: { id: string } }): Promise<{ error?: unknown }>
  }
}

interface AgentResult {
  agent: string
  output: string
  error?: string
}

/**
 * Per-invocation run context. Tracks every child session the engine spawns so
 * that, on cancellation (`signal`), we can abort them all — otherwise spawned
 * agents would keep running on the server after the operator interrupts.
 */
interface RunCtx {
  client: EngineClient
  directory: string
  parentID?: string
  signal?: AbortSignal
  created: string[]
}

const MAX_PARALLEL_TASKS = 8
const MAX_SWARM_HOPS = 6

const HANDOFF_RE = /HANDOFF:\s*([A-Za-z0-9_-]+)\s*(?:[—:-]\s*(.*))?$/m
const DONE_RE = /\bDONE\b\s*$/m

/** Run one agent to completion in its own (child) session; return its final text. */
async function runAgent(ctx: RunCtx, agent: string, input: string): Promise<AgentResult> {
  if (ctx.signal?.aborted) return { agent, output: "", error: "aborted" }
  try {
    const created = await ctx.client.session.create({
      body: { parentID: ctx.parentID, title: `caracal:${agent}` },
      query: { directory: ctx.directory },
    })
    const id = created.data?.id
    if (!id) return { agent, output: "", error: "could not create session" }
    ctx.created.push(id) // track so we can abort it on cancel
    if (ctx.signal?.aborted) {
      await ctx.client.session.abort({ path: { id } }).catch(() => {})
      return { agent, output: "", error: "aborted" }
    }
    const res = await ctx.client.session.prompt({
      path: { id },
      body: { agent, parts: [{ type: "text", text: input }] },
      query: { directory: ctx.directory },
    })
    if (res.error || !res.data) return { agent, output: "", error: "prompt failed" }
    const text = (res.data.parts ?? [])
      .filter((p) => p.type === "text" && typeof p.text === "string")
      .map((p) => p.text as string)
      .join("\n")
      .trim()
    return { agent, output: text }
  } catch (e) {
    return { agent, output: "", error: e instanceof Error ? e.message : String(e) }
  }
}

/** PARALLEL: independent tasks run concurrently, each in its own context. */
async function runParallel(
  ctx: RunCtx,
  tasks: Array<{ agent: string; input: string }>,
): Promise<AgentResult[]> {
  const limited = tasks.slice(0, MAX_PARALLEL_TASKS)
  return Promise.all(limited.map((t) => runAgent(ctx, t.agent, t.input)))
}

/** SEQUENTIAL: each agent receives the previous agent's output (assembly line). */
async function runPipeline(ctx: RunCtx, agents: string[], input: string): Promise<AgentResult[]> {
  const results: AgentResult[] = []
  let carry = input
  for (const agent of agents) {
    if (ctx.signal?.aborted) break
    const r = await runAgent(ctx, agent, carry)
    results.push(r)
    if (r.error) break
    carry = `Previous step (${agent}) produced:\n\n${r.output}\n\nContinue based on this.`
  }
  return results
}

function swarmPreamble(allowed: string[]): string {
  return [
    "You are operating inside a Caracal SWARM.",
    `Specialists you can hand off to: ${allowed.length ? allowed.join(", ") : "(any available agent)"}.`,
    "When another specialist should take over, end your reply with exactly:",
    "HANDOFF: <agent> — <what they should do next>",
    "When the objective is fully complete, end your reply with exactly:",
    "DONE",
  ].join("\n")
}

/** SWARM: peer-to-peer hand-offs; the engine routes by parsing the directive. */
async function runSwarm(
  ctx: RunCtx,
  entry: string,
  input: string,
  allowed: string[],
): Promise<AgentResult[]> {
  const results: AgentResult[] = []
  let current = entry
  let task = input
  for (let hop = 0; hop < MAX_SWARM_HOPS; hop++) {
    if (ctx.signal?.aborted) break
    const r = await runAgent(ctx, current, `${swarmPreamble(allowed)}\n\n${task}`)
    results.push(r)
    if (r.error || DONE_RE.test(r.output)) break
    const m = HANDOFF_RE.exec(r.output)
    if (!m || !m[1]) break
    const next = m[1]
    if (allowed.length && !allowed.includes(next)) break
    current = next
    task = m[2]?.trim() || r.output
  }
  return results
}

/**
 * Run a pattern with cancellation propagation. When the operator interrupts the
 * orchestrator, `signal` fires and we abort every child session the engine
 * spawned, so no recon/exploit work keeps running in the background.
 */
async function runPattern(
  client: EngineClient,
  opts: { directory: string; parentID?: string; signal?: AbortSignal },
  fn: (ctx: RunCtx) => Promise<AgentResult[]>,
): Promise<AgentResult[]> {
  const ctx: RunCtx = {
    client,
    directory: opts.directory,
    parentID: opts.parentID,
    signal: opts.signal,
    created: [],
  }
  const abortAll = () => {
    log(`cancel -> aborting ${ctx.created.length} spawned session(s)`)
    for (const id of ctx.created) void client.session.abort({ path: { id } }).catch(() => {})
  }
  if (opts.signal) {
    if (opts.signal.aborted) abortAll()
    else opts.signal.addEventListener("abort", abortAll, { once: true })
  }
  try {
    return await fn(ctx)
  } finally {
    opts.signal?.removeEventListener("abort", abortAll)
  }
}

/** Render engine results into a readable block for the orchestrator. */
function formatResults(results: AgentResult[]): string {
  if (results.length === 0) return "(no agents ran)"
  return results
    .map((r) =>
      r.error
        ? `### ${r.agent} — ERROR\n${r.error}`
        : `### ${r.agent}\n${r.output || "(no output)"}`,
    )
    .join("\n\n")
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export const CaracalPlugin: Plugin = async ({ client, directory }) => {
  // The engine drives agents through this client (bridged to the structural
  // EngineClient view; the real client is awaitable to the same {data,error}).
  const engineClient = client as unknown as EngineClient
  const mode = runMode()
  if (mode === "unmanaged") {
    log(
      "WARNING: not launched via `caracal`. Offensive tooling is disabled — run `caracal` (sandbox, default) or `caracal --local`.",
    )
  } else if (mode === "local") {
    log(
      `WARNING: running in LOCAL mode (no container isolation) · HITL=${hitlMode()} · workspace=${directory}`,
    )
  } else {
    log(`active · sandbox · HITL=${hitlMode()} · workspace=${directory}`)
  }

  return {
    /**
     * Central HITL gate. opencode routes intrusive tools to "ask" (see
     * opencode.json); here we refine that into allow / ask / deny based on the
     * action's risk tier and the configured mode.
     */
    "permission.ask": async (input, output) => {
      const mode = hitlMode()

      if (input.type === "bash") {
        const command = commandFromPermission(input)
        const tier = classifyCommand(command)
        const { decision, reason } = decideForBash(tier, mode)
        output.status = decision
        log(`bash [${tier}] -> ${decision} (${reason}) :: ${command.slice(0, 160)}`)
        return
      }

      if (input.type === "edit" || input.type === "write" || input.type === "patch") {
        const { decision, reason } = decideForEdit(mode)
        output.status = decision
        log(`${input.type} -> ${decision} (${reason})`)
        return
      }

      // Everything else: in auto mode allow; otherwise leave opencode's prompt.
      if (mode === "auto") output.status = "allow"
    },

    /**
     * Hard safety floor — runs immediately before any tool executes and CANNOT
     * be bypassed by HITL mode. Throwing here aborts the tool call.
     */
    "tool.execute.before": async (input, output) => {
      if (input.tool !== "bash") return
      const command: string = String((output.args as { command?: unknown })?.command ?? "")

      // Offensive shell only runs when launched via `caracal` (sandbox or local).
      if (!isManaged()) {
        throw new Error(
          "[caracal] bash is disabled. Launch via `caracal` (sandboxed, default) or `caracal --local`.",
        )
      }

      const tier = classifyCommand(command)
      if (tier === "destructive" || tier === "escape") {
        log(`BLOCKED [${tier}] :: ${command.slice(0, 200)}`)
        throw new Error(
          `[caracal] blocked ${tier} command by safety policy. This action is never permitted.`,
        )
      }
    },

    /**
     * Engagement helper tools — keep findings structured in the workspace.
     */
    tool: {
      caracal_note: tool({
        description:
          "Append a timestamped entry to the engagement log (notes/engagement-log.md). Use this to record findings, decisions, and next steps as you work.",
        args: {
          entry: tool.schema.string().describe("The note to append. Be concise and factual."),
          phase: tool.schema
            .enum(["recon", "web", "exploitation", "loot", "report", "general"])
            .default("general")
            .describe("Engagement phase this note belongs to."),
        },
        async execute(args, ctx) {
          const dir = join(ctx.directory, "notes")
          await mkdir(dir, { recursive: true })
          const file = join(dir, "engagement-log.md")
          const stamp = new Date().toISOString()
          const line = `\n## ${stamp} · [${args.phase}]\n\n${args.entry}\n`
          await appendFile(file, line, "utf8")
          return `Logged to notes/engagement-log.md under [${args.phase}].`
        },
      }),

      caracal_scope: tool({
        description:
          "Read the engagement scope/authorization (scope/SCOPE.md). ALWAYS call this before any intrusive action to confirm the target is in scope and authorized.",
        args: {},
        async execute(_args, ctx) {
          const file = join(ctx.directory, "scope", "SCOPE.md")
          try {
            const content = await readFile(file, "utf8")
            return content.trim().length > 0
              ? content
              : "scope/SCOPE.md is empty. Ask the operator to define the authorized scope before proceeding."
          } catch {
            return "No scope/SCOPE.md found. Ask the operator to define the authorized scope before proceeding."
          }
        },
      }),

      caracal_install: tool({
        description:
          "Install pentest tooling on demand inside the Docker sandbox via apt (e.g. hydra, netexec, smbclient, binwalk, metasploit-framework). Sandbox mode only — in `--local` mode, the host's own package manager and existing toolset are used instead; ask the operator to install anything missing.",
        args: {
          packages: tool.schema
            .array(tool.schema.string())
            .describe("apt package names to install, e.g. ['hydra','netexec']."),
        },
        async execute(args, ctx) {
          if (runMode() !== "sandbox") {
            return (
              "Refusing to apt-install: this tool only works inside the Caracal Docker sandbox. " +
              "In local mode, install tooling yourself with the host's package manager, or ask the operator."
            )
          }
          const requested = (args.packages ?? []).map((p) => p.trim().toLowerCase()).filter(Boolean)
          if (requested.length === 0) return "No packages specified."
          const allowed = requested.filter(
            (p) => /^[a-z0-9][a-z0-9+._-]*$/.test(p) && INSTALL_ALLOWLIST.has(p),
          )
          const rejected = requested.filter((p) => !allowed.includes(p))
          if (allowed.length === 0) {
            return (
              `None of the requested packages are in the install allowlist: ${requested.join(", ")}. ` +
              "Install them with `apt-get install -y <pkg>` via bash so the operator can approve, " +
              "or ask the operator to extend the allowlist."
            )
          }
          log(
            `install -> ${allowed.join(" ")}` +
              (rejected.length ? ` (skipped: ${rejected.join(", ")})` : ""),
          )
          try {
            await execFileAsync("apt-get", ["update"], {
              timeout: 180_000,
              env: APT_ENV,
              maxBuffer: 1 << 24,
            })
            const { stdout, stderr } = await execFileAsync(
              "apt-get",
              ["install", "-y", "--no-install-recommends", ...allowed],
              { timeout: 600_000, env: APT_ENV, maxBuffer: 1 << 24 },
            )
            await appendInstallNote(ctx.directory, allowed)
            const tail = (stdout || stderr || "").split("\n").filter(Boolean).slice(-6).join("\n")
            return [
              `Installed: ${allowed.join(", ")}.`,
              rejected.length ? `Not in allowlist (skipped): ${rejected.join(", ")}.` : "",
              tail ? `\n${tail}` : "",
            ]
              .filter(Boolean)
              .join("\n")
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e)
            return (
              `Install failed for [${allowed.join(", ")}]: ${msg}\n` +
              "Some tools are not apt packages (e.g. installed via pipx/gem) — try those with bash."
            )
          }
        },
      }),

      // --- Orchestration pattern engine (orchestrator-only; disabled on subagents) ---

      caracal_parallel: tool({
        description:
          "Run several agents CONCURRENTLY, each on its own task in an isolated context, and return all results. Use for fan-out work (e.g. recon several hosts at once). Orchestrator only.",
        args: {
          tasks: tool.schema
            .array(
              tool.schema.object({
                agent: tool.schema
                  .string()
                  .describe("Subagent name, e.g. recon / web-exploit / reporter."),
                input: tool.schema.string().describe("Task/instructions for that agent."),
              }),
            )
            .describe(`List of {agent, input} tasks (max ${MAX_PARALLEL_TASKS}).`),
        },
        async execute(args, ctx) {
          log(`pattern parallel x${args.tasks.length}`)
          const results = await runPattern(
            engineClient,
            { directory: ctx.directory, parentID: ctx.sessionID, signal: ctx.abort },
            (rc) => runParallel(rc, args.tasks),
          )
          return formatResults(results)
        },
      }),

      caracal_pipeline: tool({
        description:
          "Run agents SEQUENTIALLY, feeding each one the previous agent's output (assembly line, e.g. recon -> web-exploit -> reporter). Orchestrator only.",
        args: {
          agents: tool.schema
            .array(tool.schema.string())
            .describe("Ordered list of subagent names."),
          input: tool.schema.string().describe("Initial input for the first agent."),
        },
        async execute(args, ctx) {
          log(`pattern pipeline [${args.agents.join(" -> ")}]`)
          const results = await runPattern(
            engineClient,
            { directory: ctx.directory, parentID: ctx.sessionID, signal: ctx.abort },
            (rc) => runPipeline(rc, args.agents, args.input),
          )
          return formatResults(results)
        },
      }),

      caracal_swarm: tool({
        description:
          "Start a SWARM: an entry agent works the task and hands off to other agents as needed (peer-to-peer), until DONE. Use for open-ended engagements where the next specialist depends on what is found. Orchestrator only.",
        args: {
          entry: tool.schema.string().describe("Entry agent name."),
          input: tool.schema.string().describe("The objective / starting task."),
          agents: tool.schema
            .array(tool.schema.string())
            .default([])
            .describe("Allowed agents for handoff (empty = any)."),
        },
        async execute(args, ctx) {
          log(`pattern swarm entry=${args.entry}`)
          const results = await runPattern(
            engineClient,
            { directory: ctx.directory, parentID: ctx.sessionID, signal: ctx.abort },
            (rc) => runSwarm(rc, args.entry, args.input, args.agents),
          )
          return formatResults(results)
        },
      }),
    },
  }
}
