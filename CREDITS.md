# Credits & acknowledgements

Caracal stands on the ideas and tools of others. This file records what
inspired it and what it builds on — and, importantly, the boundaries we kept.

## Architectural inspiration: CAI (Cybersecurity AI)

- Project: [aliasrobotics/cai](https://github.com/aliasrobotics/cai) by Alias Robotics S.L.
- Papers: see the arXiv references in the CAI repository.

Caracal's multi-agent design — specialist agents, handoff-style delegation,
orchestration patterns, a consistent Human-In-The-Loop policy, and a hardened
host-networked container for pentesting — is **inspired by CAI's architecture**.

**Boundary we kept:** Caracal contains **no CAI source code**. CAI is
dual-licensed (an MIT portion derived from the OpenAI Agents SDK, plus a
proprietary "Research-Use" portion that forbids commercial use without a
license). Caracal copies neither. It is an independent re-implementation, in a
different language (TypeScript) on a different runtime (opencode), expressing
only the _ideas_ — which are not protected by copyright — and not the
_expression_ (code, prompts, or text) of CAI.

If you are looking for the original, full-featured framework, use CAI directly
and respect its license.

## Concepts & prior art

- **OpenAI Agents SDK** ([openai/openai-agents-python](https://github.com/openai/openai-agents-python),
  MIT) — the agent/handoff model that CAI itself derives from, and that informs
  Caracal's delegation design.

## Runtime & tooling

- **[opencode](https://opencode.ai)** — the agent runtime and terminal interface
  Caracal is built on (models, agents, tool-calling, bash, permissions). Used
  via its public plugin/agent/config APIs; installed separately under its own
  license.
- **Kali Linux** and the open-source security tools bundled in the sandbox image
  (nmap, ffuf, gobuster, sqlmap, nikto, whatweb, SecLists, and others), each
  under its own license.

## How to cite

If Caracal is useful in your work, please also credit CAI, since the
architecture is inspired by it.
