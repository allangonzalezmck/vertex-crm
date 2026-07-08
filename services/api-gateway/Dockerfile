# ── Build stage ───────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder
WORKDIR /app

COPY package.json tsconfig.base.json ./
COPY shared/package.json shared/tsconfig.json ./shared/
COPY shared/src ./shared/src/
COPY services/api-gateway/package.json services/api-gateway/tsconfig.json ./services/api-gateway/
COPY services/api-gateway/src ./services/api-gateway/src/

RUN npm install --workspace=@nexus/shared --workspace=@nexus/api-gateway
RUN npm run build --workspace=@nexus/shared
RUN npm run build --workspace=@nexus/api-gateway

# ── Runtime stage ─────────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime
WORKDIR /app

RUN addgroup -S nexus && adduser -S nexus -G nexus

ENV NODE_ENV=production

COPY --from=builder /app/package.json ./
COPY --from=builder /app/shared/package.json ./shared/
COPY --from=builder /app/services/api-gateway/package.json ./services/api-gateway/

RUN npm install --workspace=@nexus/shared --workspace=@nexus/api-gateway --omit=dev

COPY --from=builder /app/shared/dist ./shared/dist/
COPY --from=builder /app/services/api-gateway/dist ./services/api-gateway/dist/

USER nexus
EXPOSE 8080
CMD ["node", "services/api-gateway/dist/app.js"]
