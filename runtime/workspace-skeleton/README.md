# Engagement workspace

This is your working directory inside the Caracal sandbox. It is mounted from
the host, so everything here persists across container restarts. opencode is
launched with this directory as its project root.

The layout mirrors the phases of a typical engagement (CAI-style):

| Directory       | Purpose                                                               |
| --------------- | --------------------------------------------------------------------- |
| `scope/`        | Authorization & scope. **Define your target before anything runs.**   |
| `recon/`        | Reconnaissance output (host/port/service/DNS enumeration).            |
| `web/`          | Web & API testing artifacts (dirbusting, params, requests/responses). |
| `exploitation/` | Exploitation attempts, payloads, PoCs.                                |
| `loot/`         | Captured credentials, dumps, extracted data.                          |
| `evidence/`     | Screenshots, logs and proof for the report.                           |
| `reports/`      | Generated reports and write-ups.                                      |
| `notes/`        | Free-form notes and the running engagement log.                       |

> The agents are instructed to read `scope/SCOPE.md` first and to keep their
> findings organized under these directories.
