# ── Build stage ───────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder
WORKDIR /app

COPY package.json tsconfig.base.json ./
COPY shared/package.json shared/tsconfig.json ./shared/
COPY shared/src ./shared/src/
COPY services/crm-service/package.json services/crm-service/tsconfig.json ./services/crm-service/
COPY services/crm-service/src ./services/crm-service/src/

RUN npm install --workspace=@vertex/shared --workspace=@vertex/crm-service
RUN npm run build --workspace=@vertex/shared
RUN npm run build --workspace=@vertex/crm-service

# ── Runtime stage ─────────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime
WORKDIR /app

RUN addgroup -S nexus && adduser -S nexus -G nexus

ENV NODE_ENV=production

COPY --from=builder /app/package.json ./
COPY --from=builder /app/shared/package.json ./shared/
COPY --from=builder /app/services/crm-service/package.json ./services/crm-service/

RUN npm install --workspace=@vertex/shared --workspace=@vertex/crm-service --omit=dev

COPY --from=builder /app/shared/dist ./shared/dist/
COPY --from=builder /app/services/crm-service/dist ./services/crm-service/dist/

USER nexus
EXPOSE 8080
CMD ["node", "services/crm-service/dist/server.js"]
