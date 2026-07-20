#!/usr/bin/env bash
# Caracal sandbox entrypoint.
#
# Responsibilities:
#   1. Hard-assert we are actually inside the caracal sandbox.
#   2. Seed the mounted engagement workspace from the skeleton if it is empty.
#   3. Hand off to the requested command (default: keep-alive so the host
#      launcher can `docker exec` opencode into a live container).
set -euo pipefail

SKELETON="/opt/caracal/workspace-skeleton"
WORKSPACE="${CARACAL_WORKSPACE_DIR:-/root/engagement}"

if [[ "${CARACAL_SANDBOX:-0}" != "1" ]]; then
  echo "[caracal] FATAL: CARACAL_SANDBOX marker missing — refusing to start." >&2
  exit 1
fi

mkdir -p "${WORKSPACE}"

# Seed the workspace skeleton only when the workspace is empty, so we never
# clobber an existing engagement's findings.
if [[ -d "${SKELETON}" ]] && [[ -z "$(ls -A "${WORKSPACE}" 2>/dev/null || true)" ]]; then
  echo "[caracal] Seeding engagement workspace at ${WORKSPACE} from skeleton."
  cp -a "${SKELETON}/." "${WORKSPACE}/"
fi

cd "${WORKSPACE}"

echo "[caracal] Sandbox ready. opencode $(opencode --version 2>/dev/null || echo '?')  |  HITL=${CARACAL_HITL:-strict}"
echo "[caracal] Workspace: ${WORKSPACE}"

exec "$@"
