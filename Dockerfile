# syntax=docker/dockerfile:1.7
# Keep this default in sync with the Node version used by CI (see .github/workflows/ci.yml).
ARG NODE_IMAGE=node:22-alpine
FROM ${NODE_IMAGE} AS base
WORKDIR /app

FROM base AS builder

RUN apk --no-cache upgrade && apk --no-cache add python3 make g++ linux-headers

COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
  npm ci

COPY . ./
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM ${NODE_IMAGE} AS runner
WORKDIR /app

LABEL org.opencontainers.image.title="derouter"

ENV NODE_ENV=production
ENV PORT=20128
ENV HOSTNAME=0.0.0.0
ENV NEXT_TELEMETRY_DISABLED=1
ENV DATA_DIR=/app/data

COPY --chown=node:node --from=builder /app/public ./public
COPY --chown=node:node --from=builder /app/.next/static ./.next/static
# Default docs pages (Markdown), read by the start-up seeder from ./content/docs.
COPY --chown=node:node --from=builder /app/content ./content
COPY --chown=node:node --from=builder /app/.next/standalone ./
COPY --chown=node:node --from=builder /app/custom-server.js ./custom-server.js
# Next file tracing can omit sibling files; MITM runs server.js as a separate process.
COPY --chown=node:node --from=builder /app/src/mitm ./src/mitm
# Standalone node_modules may omit deps only required by the MITM child process.
COPY --chown=node:node --from=builder /app/node_modules/node-forge ./node_modules/node-forge
# Deliberate override: standalone output usually ships `next` itself, but we copy the
# fully-installed package anyway so the image never depends on file-tracing decisions.
COPY --chown=node:node --from=builder /app/node_modules/next ./node_modules/next
# node-machine-id is createRequire-loaded at runtime; tracing omits it.
COPY --chown=node:node --from=builder /app/node_modules/node-machine-id ./node_modules/node-machine-id

# Ownership comes from `COPY --chown` above. A `chown -R /app` here would rewrite
# every copied file into a fresh layer, duplicating node_modules (~293 MB in the
# previous image); --chown sets it during the copy at no extra cost.
RUN mkdir -p /app/data /app/data-home && chown node:node /app/data /app/data-home && \
  ln -sf /app/data-home /root/.derouter 2>/dev/null || true

# Fix permissions at runtime (handles mounted volumes)
RUN apk --no-cache upgrade && apk --no-cache add su-exec && \
  printf '#!/bin/sh\nchown -R node:node /app/data /app/data-home 2>/dev/null\nexec su-exec node "$@"\n' > /entrypoint.sh && \
  chmod +x /entrypoint.sh

EXPOSE 20128

ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "custom-server.js"]
