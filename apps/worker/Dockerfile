# Built by the deploy workflow after `pnpm build`; expects apps/worker/dist/index.js.
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
# Tool subprocesses (later phases) run as this unprivileged user, never as root.
RUN useradd --create-home --shell /usr/sbin/nologin dodo
COPY apps/worker/dist/index.js ./index.js
USER dodo
CMD ["node", "index.js"]
