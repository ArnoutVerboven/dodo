# Built by the deploy workflow after `pnpm build`; expects apps/worker/dist/index.js.
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates curl jq ripgrep \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --uid 10001 --user-group --create-home --shell /usr/sbin/nologin agent
COPY apps/worker/dist/index.js ./index.js
# Node's compile cache, filled once here: every container loads the 19 MB bundle about a third
# faster. Run without a run, the worker stops at once ("Missing env"), after compiling it all.
ENV NODE_COMPILE_CACHE=/app/.node-cache
RUN node index.js >/dev/null 2>&1; test -n "$(ls -A /app/.node-cache)"
# The worker runs as root and holds the run's credential; the agent's commands, git and its
# file reads and writes run as `agent` (packages/agent/src/agent-user.ts), which cannot read
# the worker's environment or memory, nor anything else only root may read.
ENV DODO_AGENT_UID=10001 DODO_AGENT_GID=10001
CMD ["node", "index.js"]
