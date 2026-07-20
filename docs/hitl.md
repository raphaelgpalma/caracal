# Human-In-The-Loop (HITL)

Caracal keeps a human in control of dangerous actions — the same philosophy as
CAI, realized with opencode's native permission machinery plus a plugin policy.

## The two layers

### Layer 1 — opencode permission config (`runtime/opencode.json`)

Routes potentially-intrusive tools to `"ask"` so the plugin policy can decide,
and protects the host:

```json
{
  "permission": {
    "bash": "ask",
    "edit": "ask",
    "webfetch": "allow",
    "websearch": "allow",
    "external_directory": "deny",
    "doom_loop": "ask"
  }
}
```

`external_directory: "deny"` blocks any tool from touching paths outside the
engagement workspace — the model cannot read or write host files via file tools.

### Layer 2 — the plugin policy (`runtime/plugin/caracal.ts`)

Two hooks implement the policy:

- **`permission.ask(input, output)`** — refines opencode's "ask" into
  `allow` / `ask` / `deny` based on (a) the action's **risk tier** and (b) the
  configured **mode**.
- **`tool.execute.before(input, output)`** — a **hard safety floor** that runs
  before every tool and throws (aborting the call) for the always-forbidden
  tiers, and disables `bash` entirely outside the sandbox.

## Risk tiers

Every bash command is classified (this is Caracal's idiomatic analogue of CAI's
per-category tools):

| Tier          | Meaning                                     | Examples                                                      |
| ------------- | ------------------------------------------- | ------------------------------------------------------------- |
| `destructive` | irreversible damage                         | `rm -rf /`, `mkfs`, `dd of=/dev/sda`, fork bomb, `shutdown`   |
| `escape`      | break out of sandbox / reach host           | `nsenter`, `docker run`, `/proc/1/root`, docker.sock          |
| `exploit`     | active exploitation / cred attacks / shells | `sqlmap --dump`, `hydra`, `nc -e`, `/dev/tcp/…` reverse shell |
| `recon`       | active scanning / enumeration               | `nmap`, `gobuster`, `ffuf`, `nikto`, `whatweb`                |
| `provision`   | install tooling on demand (package manager) | `apt-get install hydra`, `pipx install …`, `gem install …`    |
| `script`      | arbitrary interpreter, intent unknown       | `python3 -c …`, `bash -c …`                                   |
| `readonly`    | local non-intrusive inspection              | `ls`, `cat`, `dig`, `grep`, `whoami`                          |
| `unknown`     | unrecognized command                        | anything else                                                 |

The classifier splits pipelines on shell operators and inspects the leading
binary of each segment, so `nmap … | grep open` is still `recon` and
`echo hi && ls` is still `readonly`.

## Modes (`CARACAL_HITL`)

| Action tier          | `strict` (default) | `guided` | `auto` (labs only) |
| -------------------- | ------------------ | -------- | ------------------ |
| destructive / escape | **deny**           | **deny** | **deny**           |
| exploit              | ask                | ask      | allow              |
| recon                | ask                | allow    | allow              |
| provision (install)  | ask                | allow    | allow              |
| script / unknown     | ask                | ask      | allow              |
| readonly             | allow              | allow    | allow              |
| edit (in workspace)  | ask                | allow    | allow              |

- **strict** — pauses before anything intrusive. Safest; the default.
- **guided** — lets routine recon flow, pauses for high-impact actions.
- **auto** — no prompts. Only for isolated labs/CTF you fully own. The safety
  floor (destructive/escape deny) still applies even here.

Set it per launch: `CARACAL_HITL=guided caracal`, or in `.env`.

> In `caracal --local` (no container isolation, see `docs/sandbox.md`),
> `auto` is capped down to `guided` — local mode never runs silently, even if
> requested, because there is no sandbox to fall back on if something goes
> wrong.

## What the user sees

When an action is gated, opencode shows its standard approval prompt with
**approve once / approve always (this session) / reject**. Caracal's policy only
decides _whether_ to prompt and what is hard-denied; the interaction itself is
opencode's well-tested UI. You can also interrupt a running agent at any time
(opencode's built-in interrupt) to take over — the CAI-style "human can always
step in" guarantee.

## The safety floor is non-negotiable

Regardless of mode (including `auto`), `tool.execute.before` blocks `destructive`
and `escape` commands by throwing before execution, and refuses to run `bash` at
all if the `CARACAL_SANDBOX` marker is absent. This is defense in depth: even a
misconfiguration cannot let the model wipe a disk or escape the container.
