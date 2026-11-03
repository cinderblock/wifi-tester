# syntax=docker/dockerfile:1

# wifi-tester. Built by CI and published to GHCR. Which image actually runs is
# pinned in the ops repo (cinderblock/ops, servers/steamboat/stacks/wifi-tsl/).
# Everything deployment-specific is runtime environment, not build input.
#
# No build step and no runtime dependencies: Bun serves the TypeScript
# directly and bundles web/ (an HTML import) when the server starts.

FROM oven/bun:1.4.4-slim

WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    DATABASE_PATH=/data/wifi.db

# Exactly what src/main.ts needs at runtime. A missing directory here builds
# fine and then fails at boot, so keep this in step with the imports:
# src/ (server), web/ (bundled page), scripts/ (served diagnostic templates).
COPY package.json tsconfig.json ./
COPY src ./src
COPY web ./web
COPY scripts ./scripts

# Stamp the build so the page footer and /api/health say which release this
# is. ops' deploy separately verifies the org.opencontainers.image.revision
# label (set by CI) against the pinned commit.
ARG GIT_SHA=unknown
RUN printf '%s' "${GIT_SHA}" > /app/BUILD_SHA \
    # /data exists in the image owned by the unprivileged user, so a fresh
    # named volume mounted there is initialized with that ownership.
    && mkdir -p /data && chown bun:bun /data

USER bun
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD ["bun", "-e", "fetch('http://127.0.0.1:' + process.env.PORT + '/api/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

CMD ["bun", "src/main.ts"]
