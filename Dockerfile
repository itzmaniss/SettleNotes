# Build on musl so sharp installs its linuxmusl binaries, matching the musl
# runtime below. ffmpeg-static downloads a single fully static linux binary in
# its install step, so it runs on alpine without any system packages.
FROM oven/bun:1-alpine AS builder
WORKDIR /app

# Dependencies first so this layer is cached across code-only changes.
COPY package.json bun.lock bunfig.toml ./
RUN bun install --frozen-lockfile

COPY . .

# NEXT_OUTPUT=standalone switches next.config.ts to standalone output
# (.next/standalone with a traced node_modules). Telemetry stays off.
ENV NEXT_OUTPUT=standalone
ENV NEXT_TELEMETRY_DISABLED=1
RUN bun run build

# Runtime: node on musl, no package manager runs, only the built output.
FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
# standalone server.js listens on HOSTNAME; 0.0.0.0 makes it reachable from Caddy.
ENV HOSTNAME=0.0.0.0

RUN addgroup --system --gid 1001 settle && adduser --system --uid 1001 settle

COPY --from=builder --chown=1001:1001 /app/.next/standalone ./
COPY --from=builder --chown=1001:1001 /app/.next/static ./.next/static
COPY --from=builder --chown=1001:1001 /app/public ./public

# Ship no source maps.
RUN find /app -name "*.map" -type f -delete

USER settle
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "server.js"]
