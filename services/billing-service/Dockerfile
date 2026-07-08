# ── Build stage ───────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder
WORKDIR /app

COPY package.json tsconfig.base.json ./
COPY shared/package.json shared/tsconfig.json ./shared/
COPY shared/src ./shared/src/
COPY services/billing-service/package.json services/billing-service/tsconfig.json ./services/billing-service/
COPY services/billing-service/src ./services/billing-service/src/

RUN npm install --workspace=@nexus/shared --workspace=@nexus/billing-service
RUN npm run build --workspace=@nexus/shared
RUN npm run build --workspace=@nexus/billing-service

# ── Runtime stage ─────────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime
WORKDIR /app

RUN addgroup -S nexus && adduser -S nexus -G nexus

ENV NODE_ENV=production

COPY --from=builder /app/package.json ./
COPY --from=builder /app/shared/package.json ./shared/
COPY --from=builder /app/services/billing-service/package.json ./services/billing-service/

RUN npm install --workspace=@nexus/shared --workspace=@nexus/billing-service --omit=dev

COPY --from=builder /app/shared/dist ./shared/dist/
COPY --from=builder /app/services/billing-service/dist ./services/billing-service/dist/

USER nexus
EXPOSE 8080
CMD ["node", "services/billing-service/dist/app.js"]
