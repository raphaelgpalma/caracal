<p align="center">
  <img src="./assets/banner.png" alt="Caracal — multi-agent offensive security, under control" width="720">
</p>

<h1 align="center">Caracal</h1>

<p align="center">
  <em>Multi-agent offensive security, under control.</em>
</p>

<p align="center">
  <a href="#requirements"><img alt="Node ≥ 20" src="https://img.shields.io/badge/node-%E2%89%A520-339933?logo=node.js&logoColor=white"></a>
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white">
  <img alt="runtime: opencode" src="https://img.shields.io/badge/runtime-opencode-000000">
  <a href="./LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-red"></a>
</p>

> A multi-agent **cybersecurity / pentesting** framework that runs on top of
> [opencode](https://opencode.ai) inside a hardened, host-networked Docker
> sandbox. Its multi-agent architecture is inspired by
> [CAI (Cybersecurity AI)](https://github.com/aliasrobotics/cai) — re-implemented
> from scratch in **TypeScript**, with a consistent **Human-In-The-Loop (HITL)**
> policy.

> [!WARNING]
> Offensive-security tool. Use **only** against systems you own or are explicitly
> authorized to test. Read [`DISCLAIMER`](./DISCLAIMER) before use.

---

## Why this design

opencode already provides what is genuinely hard to build well: a polished
terminal/UI experience, model & provider management, agent/subagent execution,
tool calling, bash integration and a permission system. Caracal does **not**
reinvent any of that. Instead it treats opencode as the **runtime and interface**
and layers the CAI-style multi-agent _architecture_ on top:

| CAI (Python)                                               | Caracal (TypeScript on opencode)                                                    |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `Agent` personas (red team, recon, …)                      | opencode **agents** (`runtime/agent/*.md`)                                       |
| `handoff` / `transfer_to_X`                                | opencode **`task`** tool (orchestrator → subagent)                               |
| Orchestration patterns (swarm / parallel / sequential)     | **orchestrator agent** + the **caracal plugin**                                     |
| Per-category tools (recon, exploitation, web, …)           | custom **tools** in the caracal plugin                                              |
| Human-In-The-Loop                                          | central **HITL policy** in the plugin (`permission.ask` + `tool.execute.before`) |
| Containerized virtualization (`--network host`, `NET_RAW`) | the **Docker sandbox** (`docker/`)                                               |

See [`docs/architecture.md`](./docs/architecture.md) for the full mapping.

## How it works

```
 host ──► caracal (launcher CLI)
            │  1. checks Docker is installed
            │  2. builds the sandbox image if missing (Kali + tools + opencode + caracal, baked in)
            │  3. starts the container:  --network host  --cap-add NET_ADMIN,NET_RAW  seccomp=unconfined
            │  4. mounts host opencode auth (read-only) + your engagement workspace
            ▼
 sandbox container ──► opencode TUI
            │   loads caracal global config (~/.config/opencode):
            │     • opencode.json   — providers, agents, permissions, plugin
            │     • plugin/         — HITL policy, sandbox guard, pentest tools
            │     • agent/          — orchestrator + 8 specialists (recon, web-exploit, exploit, creds, ad, ctf, retester, reporter)
            ▼
        you ⇄ orchestrator ⇄ specialist subagents ⇄ tools  (every dangerous step gated by HITL)
```

opencode for Caracal is **only ever launched inside the sandbox**. The plugin
additionally refuses to arm its offensive tooling unless it detects the sandbox
marker (defense in depth — see [`docs/sandbox.md`](./docs/sandbox.md)).

## Requirements

- **Docker** (required — the launcher refuses to run without it)
- **Node.js ≥ 20** (to run the host launcher)
- A model provider configured in opencode on your host (e.g. `opencode auth login`)

## Quick start

```bash
# 1. Build the launcher
npm install
npm run build

# 2. Launch — builds the sandbox image on first run, then drops you into opencode
node dist/launcher/index.js
#   (or `npm link` once, then just: caracal)
```

On first launch the framework starts in **strict HITL** mode: every potentially
intrusive action pauses for your approval.

## Targets & sessions

Each engagement is a **target** — a persistent, self-contained environment under
`~/.caracal/targets/<name>/`:

- `engagement/` — your files (recon, loot, evidence, reports), mounted at
  `/root/engagement`.
- `.opencode/` — the opencode session/context (history, snapshots, DB), mounted
  at `/root/.local/share/opencode`.

Containers are disposable; **state lives on the host, per target**. Switching
targets recreates a clean sandbox bound to that target; resuming a previous
target restores both its files **and** its session/context.

```bash
caracal target acme      # create + select target "acme"
caracal                  # launch it (clean, separate session)
# …work the engagement…
caracal target hospital  # switch: clean session for "hospital"
caracal target acme      # come back to acme — files + context restored
caracal targets          # list all targets
caracal reset            # wipe the active target's session (keeps its files)
caracal rm acme --force  # delete a target and all its files (dry-run without --force)
```

Provider auth (`auth.json`) is mounted read-only on top of `.opencode`, so the
API key is **never** written into a target folder.

## Project status

Early development.

- **v1 (vertical slice):** full pipeline end-to-end (sandbox → opencode → plugin
  → agents → HITL → tools), plus per-agent model selection.
- **Agent roster:** `orchestrator` coordinating `recon`, `web-exploit`,
  `exploit`, `creds`, `ad`, `ctf`, `retester`, and `reporter`.
- **Phase 2 (essential patterns):** the orchestration **pattern engine** —
  `caracal_parallel`, `caracal_pipeline`, `caracal_swarm` — driving agents via
  the opencode SDK (orchestrator-only; HITL still applies).
- **On-demand tooling:** the image ships a lean recon/web toolset; specialists
  install heavier toolchains at runtime via `caracal_install` (vetted allowlist) or
  HITL-gated `apt`.

Remaining CAI specialist agents, the `conditional`/`hierarchical` patterns and a
declarative `caracal.yml` are added incrementally
(see [`docs/architecture.md`](./docs/architecture.md) → _Roadmap_).

> After changing the plugin or agents, rebuild the sandbox image so the baked
> config updates: `caracal build`.

## Repository layout

```
caracal/
├── src/launcher/          # host-side CLI (TypeScript) — the `caracal` command
├── runtime/               # baked into the sandbox image as opencode global config
│   ├── opencode.json      #   providers, agents, permissions, plugin registration
│   ├── plugin/            #   the caracal plugin: HITL, sandbox guard, tools
│   ├── agent/             #   agent personas (markdown)
│   └── workspace-skeleton # ready-made engagement folder structure
├── docker/                # Dockerfile + entrypoint + compose for the sandbox
└── docs/                  # architecture, HITL, sandbox & agent documentation
```

## License & credits

[MIT](./LICENSE). Inspired by CAI's architecture; contains **no** CAI source
code. See [`NOTICE`](./NOTICE) and [`CREDITS.md`](./CREDITS.md) for full
attribution (CAI, the OpenAI Agents SDK, opencode, and the bundled tools).
