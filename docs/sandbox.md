# The sandbox

By default, Caracal runs entirely inside a Docker container. This is both a
safety boundary (the model operates on the container's filesystem, not the
host's) and a ready pentesting environment (Kali + tools + opencode + the
Caracal architecture, baked in).

Docker is a hard requirement for this default mode, and the `caracal` launcher
refuses to run without it (unless you opt into `--local`, see below).

## Local mode (`caracal --local`) — the explicit opt-out

If you'd rather run opencode directly on your own machine — no Docker, no
container — pass `--local`:

```bash
caracal --local
```

This is for operators who already work inside their own isolated
environment (a personal VM, a disposable cloud box, a CTF container you
control) and don't want a second layer of containment on top. **It is not the
recommended mode** — sandbox stays the default for a reason (see Security
model below) — but it exists because requiring Docker for every use case is
unnecessarily rigid.

What changes in local mode:

- No Docker, no image build, no container. `caracal` execs `opencode`
  directly on the host, in your active target's workspace directory.
- The launcher syncs `runtime/{opencode.json,plugin/,agent/}` into your host's
  opencode global config (`~/.config/opencode/`) on every launch, so the same
  plugin, agents, and HITL policy apply as in the sandbox.
- You need `opencode` installed and authenticated on the host yourself
  (`opencode auth login`); the launcher checks for it and fails fast if
  missing. Unlike the Docker image, local mode does **not** install any
  pentest tooling (nmap, ffuf, sqlmap, …) — bring your own, or install what an
  agent asks for as HITL prompts you.
- `caracal build` and `caracal shell` don't apply (there's no image or
  container) and exit with an explanation.
- On every `caracal --local` launch, you get an explicit warning and an
  interactive `y/N` confirmation — this cannot be skipped with a flag, only
  with `CARACAL_YES=1` in the environment for scripted/CI use.
- The plugin's safety floor still enforces the HITL policy and the
  destructive/escape command blocklist (see `docs/hitl.md`) — but there is no
  container to fall back on if something gets past it. `CARACAL_HITL=auto` is
  capped to `guided` in local mode; it can never run silently.

Persist the choice instead of passing the flag every time with
`CARACAL_MODE=local` (env or `.env`); `--local`/`--sandbox` on the command
line always wins over it.

## What the image contains (`docker/Dockerfile`)

- **Base:** `kalilinux/kali-rolling`.
- **Tooling (v1 vertical slice — recon + web):** `nmap`, `masscan`, `whatweb`,
  `gobuster`, `ffuf`, `wfuzz`, `dirb`, `nikto`, `sqlmap`, `dnsutils`,
  `seclists`, `netcat`, plus the usual shell/network utilities. (More land as
  new agents do.)
- **Node.js 22** — to install the plugin's runtime dependency.
- **opencode** — installed via the official installer, **pinned** to
  `OPENCODE_VERSION` (default 1.17.8) so builds are reproducible.
- **Caracal global config** baked into `~/.config/opencode/`:
  `opencode.json`, `plugin/caracal.ts`, `agent/*.md`. Plugin deps are
  pre-installed so the first launch is fast and offline-reproducible.
- **Engagement skeleton** at `/opt/caracal/workspace-skeleton`, used to seed an
  empty workspace on first run (`scope/`, `recon/`, `web/`, `exploitation/`,
  `loot/`, `evidence/`, `reports/`, `notes/`, `AGENTS.md`).

> opencode is installed as part of bringing the sandbox up — Docker is a hard
> requirement for this (default) mode. Use `caracal --local` if you don't want
> Docker at all; see above.

## How it runs (`src/launcher` / `docker/docker-compose.yml`)

```
docker run -d --name caracal-sandbox \
  --network host \                  # full host network access (pentesting)
  --cap-add NET_ADMIN \             # routing / iptables / tunnels
  --cap-add NET_RAW \               # raw sockets: nmap SYN scans, ping, crafting
  --security-opt seccomp=unconfined \  # broad tool compatibility
  -e CARACAL_SANDBOX=1 -e CARACAL_HITL=strict \
  -v <your-workspace>:/root/engagement \
  -v ~/.local/share/opencode/auth.json:/root/.local/share/opencode/auth.json:ro \
  caracal:latest
# then: docker exec -it caracal-sandbox opencode --agent orchestrator
```

The container stays alive (`sleep infinity`) so the launcher can `exec` opencode
into it; this matches CAI's "persistent container, exec in" model.

## Security model — read this carefully

Caracal makes a deliberate trade-off that is standard for pentesting tooling,
and it is stronger in sandbox mode than in local mode:

- **Network is shared with the host (`--network host`) — by design, even in
  the sandbox.** Pentesting requires reaching targets exactly as the host can,
  and opencode needs outbound access to model-provider APIs. There is no
  network isolation between the container and the host either way. **Run
  Caracal only from a machine and network position from which you are
  authorized to operate.**
- **Filesystem and processes ARE isolated — sandbox mode only.** The container
  only sees its own filesystem plus two mounts: your engagement workspace, and
  your opencode `auth.json` (read-only). The host filesystem is otherwise
  invisible. **In local mode there is no such boundary**: `bash` runs as your
  own user, with access to everything your user can reach. Only the file
  tools (edit/write) stay scoped to the workspace via `external_directory:
  "deny"` — the shell is not similarly contained.
- **Raw-socket capabilities + seccomp unconfined** are granted to the sandbox
  container for tool compatibility. This is powerful; it is scoped to the
  container. In local mode you already have this by virtue of being on the
  host.

### Defense in depth: "offensive tooling only runs via `caracal`"

Sandbox and local mode both gate offensive tooling behind explicit launch
markers the plugin checks, but the guarantee is materially different:

1. The **launcher** only ever execs opencode through `caracal` — either
   _inside_ the sandbox container, or, in local mode, directly on the host
   after an explicit `--local` flag and interactive confirmation.
2. Sandbox mode: the image sets `CARACAL_SANDBOX=1`; the **entrypoint**
   refuses to start if it is missing. Local mode: the launcher sets
   `CARACAL_LOCAL=1` for the opencode process it spawns.
3. The **plugin** disables `bash` (throws in `tool.execute.before`) unless one
   of those two markers is present — so a bare, unmanaged `opencode` session
   never gets offensive tooling, sandboxed or not.

Note what this defense-in-depth actually buys you in each mode: in **sandbox**
mode, mechanism #2 is enforced by the container boundary itself (nothing
outside Docker can set `CARACAL_SANDBOX=1` inside a container it doesn't
control). In **local** mode, `CARACAL_LOCAL=1` is just a process environment
variable — it stops accidental/unmanaged use, not a determined local user. The
real protection in local mode is the same as always running any tool
locally: your own judgment, HITL prompts, and the destructive/escape
blocklist. Treat local mode as "no different from running the underlying
tools yourself," because that is what it is.

### Host file protection

`external_directory: "deny"` in `opencode.json` prevents opencode's file tools
from reading or writing anything outside the workspace, and the only host path
mounted writable is the workspace itself. `auth.json` is mounted read-only and
is never written from inside.

## Authentication into the sandbox

All of opencode's default providers stay available — Caracal restricts nothing.

By default (`CARACAL_AUTH_MODE=mount`) the launcher mounts your host opencode
credentials read-only, so every provider you've already logged into on the host
works immediately — including **Ollama Cloud** (`ollama-cloud/*`), which opencode
supports natively. Pick a model with `CARACAL_MODEL`, e.g.
`CARACAL_MODEL=ollama-cloud/qwen3-coder:480b`; list options inside the sandbox
with `opencode models | grep ollama-cloud`.

Alternatively set `CARACAL_AUTH_MODE=env` and provide one or more of
`OLLAMA_API_KEY` / `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `OPENROUTER_API_KEY`
/ `GOOGLE_GENERATIVE_AI_API_KEY` in the environment.
