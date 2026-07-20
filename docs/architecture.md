# Architecture

Caracal re-implements the **multi-agent architecture of CAI** on top of
[opencode](https://opencode.ai), in TypeScript. It contains no CAI source code —
only the architectural ideas, expressed idiomatically for opencode.

## Design principle: opencode is the runtime, Caracal is the architecture

opencode already solves the hard, easy-to-get-wrong problems: a great terminal
UI, provider/model management, the agent execution loop, tool calling, bash
integration, and a permission system. Re-building those would be wasted effort
and a source of bugs. So Caracal treats opencode as the **runtime + interface**
and layers the CAI-style architecture on top via three seams opencode exposes:

1. **Agents** (`runtime/agent/*.md`) — the specialist personas.
2. **A plugin** (`runtime/plugin/caracal.ts`) — cross-cutting logic: the HITL
   policy, the safety floor, and engagement tools.
3. **Config** (`runtime/opencode.json`) — permissions that route intrusive
   actions through the HITL policy and protect the host.

By default this is baked into a Docker sandbox as opencode's **global config**,
so the entire architecture is present the moment opencode starts inside the
box. The same config can also be synced onto the host's own opencode install
for `caracal --local` (no container) — see [sandbox.md](./sandbox.md) for the
trade-offs of that mode.

## CAI → Caracal mapping

| CAI concept (Python)                                                                    | Caracal realization                                                                               | Where                                              |
| --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `Agent` dataclass (name, instructions, tools, model…)                                   | opencode agent (markdown + frontmatter)                                                        | `runtime/agent/*.md`                               |
| Agent `instructions` / system prompt                                                    | agent markdown body + global `AGENTS.md`                                                       | `runtime/agent/*`, workspace `AGENTS.md`           |
| `handoff` → `transfer_to_X` tool                                                        | opencode built-in **`task`** tool (orchestrator → subagent)                                    | `orchestrator.md`                                  |
| Orchestration **patterns** (swarm / parallel / sequential / hierarchical / conditional) | Phase 1: orchestrator + `task`. Phase 2 (done): pattern engine — parallel/pipeline/swarm tools | `orchestrator.md`, `plugin` engine                 |
| Per-category **tools** (recon, exploitation, web…)                                      | opencode `bash` + per-agent permission categories + risk classifier                            | `runtime/agent/*`, plugin                          |
| Tool execution (`generic_linux_command`)                                                | opencode `bash` tool                                                                           | built-in                                           |
| Agent **factory / registry** + `agents.yml`                                             | opencode agent auto-discovery from `agent/`                                                    | built-in                                           |
| **Human-In-The-Loop**                                                                   | central policy in the plugin (`permission.ask` + `tool.execute.before`)                        | `runtime/plugin/caracal.ts`, see [hitl.md](./hitl.md) |
| **Virtualization** (`--network host`, `NET_RAW`, seccomp unconfined)                    | the Docker sandbox (default mode; skipped entirely in `--local`)                                | `docker/`, see [sandbox.md](./sandbox.md)          |
| `cai` CLI entry point                                                                   | the `caracal` host launcher                                                                   | `src/launcher/`                                    |

## Runtime topology

Sandbox mode (default):

```
host: `caracal` launcher (src/launcher)
   │  docker run --network host --cap-add NET_ADMIN,NET_RAW  (see sandbox.md)
   ▼
sandbox container
   ├── opencode  (pinned, baked in)
   └── ~/.config/opencode/         ← Caracal global config (baked)
        ├── opencode.json          ← permissions route intrusive tools to HITL
        ├── plugin/caracal.ts     ← HITL policy + safety floor + tools
        └── agent/                 ← orchestrator + recon + web-exploit + reporter
   working dir: /root/engagement   ← mounted from host; seeded from skeleton

flow:  operator ⇄ orchestrator ──task──▶ recon / web-exploit / reporter
                                  every intrusive step ⟶ HITL gate
```

Local mode (`caracal --local`) — same config, no container:

```
host: `caracal --local` launcher (src/launcher/local.ts)
   │  syncs runtime/{opencode.json,plugin/,agent/} into the host's own
   │  ~/.config/opencode/ on every launch, then execs opencode directly
   ▼
opencode  (whatever version is on your PATH)
   └── ~/.config/opencode/          ← same three pieces, synced, not baked
   working dir: <target>/engagement ← same per-target workspace as sandbox mode

flow: identical to sandbox mode, but `bash` runs as your own host user with
      no container boundary — see sandbox.md § Security model.
```

## Why "agents + plugin", not "a plugin OR an agent"

A common question is whether Caracal should be _an opencode plugin_ or _a
separate agent_. The answer is **both**, and that mirrors CAI: CAI has both agent
definitions _and_ an SDK/runtime with tools and policy. In Caracal:

- The **personas** are naturally opencode agents (prompt + tool scope + model).
- The **cross-cutting behavior** (HITL, safety floor, engagement tools, and the
  orchestration pattern engine) needs the plugin, because the plugin is the only
  place with access to opencode's hooks and SDK client at runtime.

## Orchestration: phased approach

Caracal's pattern support is delivered in phases (a deliberate decision to ship
a correct vertical slice first):

- **Phase 1:** idiomatic opencode. The `orchestrator` primary agent decomposes
  the engagement and delegates to specialists with the built-in `task` tool.
- **Phase 2 (implemented — essential set):** an explicit **pattern engine** in
  the plugin that drives agents programmatically via the opencode SDK client
  (`session.create` + `session.prompt` with a target `agent`). It is exposed as
  orchestrator-only tools:
  - `caracal_parallel` — independent tasks run concurrently, each in its own
    session/context; results aggregated.
  - `caracal_pipeline` — agents run in sequence, each fed the previous output.
  - `caracal_swarm` — peer-to-peer hand-offs; the engine routes by parsing a
    `HANDOFF: <agent> — <task>` / `DONE` directive in each agent's reply.

  Design choices:
  - **Orchestrator-only:** the engine tools are disabled on subagents — this
    caps per-turn token cost and prevents recursive/runaway orchestration.
  - **HITL still applies:** spawned agents run in child sessions that pass
    through the same `permission.ask` gate.
  - **Per-agent models apply:** spawned agents use their configured model.
  - **Cancellable:** interrupting the orchestrator propagates through the tool's
    abort signal — the engine aborts every child session it spawned, so no
    recon/exploit work keeps running in the background.
  - **Bounds:** parallel ≤ 8 tasks, swarm ≤ 6 hops.

  > The engine compiles and loads cleanly; its live behavior (nested
  > `session.prompt` driving subagents) is validated through real runs.

## Roadmap

1. **Remaining patterns:** `conditional` (predicate routing) and `hierarchical`
   as first-class tools; `unified` vs `split` context option for parallel.
2. **Declarative `caracal.yml`** for multi-agent line-ups (analogue of CAI's
   `agents.yml`), running the same engine with zero model-context cost.
3. **More specialist agents** toward CAI parity: `blue-team`, `bug-bounty`,
   `dfir`, `reverse-engineering`, `network`, `wifi`, `memory`, `compliance`, etc.
4. **Tooling depth:** richer per-category tools and result parsers.
5. **Policy as an extracted, unit-tested module** (the risk classifier currently
   lives inline in the single-file plugin; extraction + a bundled build will let
   us ship a proper test suite) and the deferred HITL hardening (fail-safe on
   empty command, anti-obfuscation).
6. **Tracing & cost controls** mirroring CAI's price/turn limits.
