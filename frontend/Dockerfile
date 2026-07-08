# ── Build stage ───────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder
WORKDIR /app

COPY frontend/package.json ./
RUN npm install

COPY frontend/ ./
RUN npm run build

# ── Runtime stage ─────────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime
WORKDIR /app

RUN addgroup -S nexus && adduser -S nexus -G nexus

ENV NODE_ENV=production \
    PORT=8080 \
    HOSTNAME=0.0.0.0

# Next.js standalone output bundles everything needed
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

USER nexus
EXPOSE 8080
CMD ["node", "server.js"]
