# Caracal sandbox image.
#
# A Kali-based, host-networked pentesting sandbox that ships opencode (pinned)
# plus the caracal opencode configuration (plugin + agents) baked in as the
# *global* opencode config. The model only ever drives opencode from inside
# this container.
#
# Build:  docker build -f docker/Dockerfile -t caracal:latest \
#                       --build-arg OPENCODE_VERSION=1.17.8 .
# (the host launcher does this for you)

FROM kalilinux/kali-rolling

LABEL org.opencontainers.image.title="caracal-sandbox" \
      org.opencontainers.image.description="Multi-agent pentesting sandbox (opencode + caracal)" \
      org.opencontainers.image.source="https://github.com/raphaelgpalma/caracal"

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    # Marker the caracal plugin checks before arming offensive tooling.
    CARACAL_SANDBOX=1 \
    CARACAL_HITL=strict \
    OPENCODE_CONFIG_DIR=/root/.config/opencode

# --- System + pentest tooling (lean base: recon + web/exploitation) ---
# Kept deliberately lean. Specialist agents install heavier toolchains
# (creds, AD, post-ex, RE, ...) on demand at runtime via `caracal_install` /
# `apt-get` (Kali repos), so they are not baked into the image.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl wget git unzip jq less vim-tiny \
      python3 python3-pip pipx \
      iproute2 net-tools iputils-ping dnsutils \
      openssh-client sshpass \
      nmap masscan \
      whatweb nikto gobuster ffuf wfuzz dirb \
      sqlmap \
      seclists \
      netcat-traditional \
    && rm -rf /var/lib/apt/lists/*

# --- Node.js (for opencode plugin dep install + tooling) ---
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# --- opencode (pinned) ---
ARG OPENCODE_VERSION=1.17.8
ENV OPENCODE_VERSION=${OPENCODE_VERSION}
RUN curl -fsSL https://opencode.ai/install | VERSION="${OPENCODE_VERSION}" bash \
    && ln -sf /root/.opencode/bin/opencode /usr/local/bin/opencode \
    && opencode --version

# --- Caracal opencode configuration (baked as GLOBAL config) ---
# Directory layout mirrors what opencode auto-loads from ~/.config/opencode:
#   opencode.json  -> providers / agents / permissions / plugin registration
#   plugin/        -> the caracal plugin (HITL policy, sandbox guard, tools)
#   agent/         -> agent personas (orchestrator + specialists)
RUN mkdir -p ${OPENCODE_CONFIG_DIR}/plugin ${OPENCODE_CONFIG_DIR}/agent
COPY runtime/opencode.json ${OPENCODE_CONFIG_DIR}/opencode.json
# Only the plugin source itself goes into the plugin dir — opencode treats every
# file there as a plugin, so package.json/tsconfig must NOT be copied here.
COPY runtime/plugin/caracal.ts ${OPENCODE_CONFIG_DIR}/plugin/caracal.ts
COPY runtime/agent/ ${OPENCODE_CONFIG_DIR}/agent/

# Pre-install plugin runtime dependencies so the first launch is fast and
# fully offline-reproducible (no bun install on first session).
COPY runtime/plugin/package.json ${OPENCODE_CONFIG_DIR}/package.json
RUN cd ${OPENCODE_CONFIG_DIR} && npm install --no-audit --no-fund --omit=dev

# --- Ready-made engagement workspace skeleton (CAI-style folder structure) ---
# Copied to a template location; the entrypoint seeds the mounted workspace
# from this template if the workspace is empty.
COPY runtime/workspace-skeleton/ /opt/caracal/workspace-skeleton/

# --- Entrypoint ---
COPY docker/entrypoint.sh /usr/local/bin/caracal-entrypoint
RUN chmod +x /usr/local/bin/caracal-entrypoint

WORKDIR /root/engagement
ENTRYPOINT ["/usr/local/bin/caracal-entrypoint"]
# Default: stay alive so the host launcher can `docker exec` opencode into it.
CMD ["sleep", "infinity"]
