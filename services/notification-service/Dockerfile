# ── Build stage ───────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder
WORKDIR /app

COPY package.json tsconfig.base.json ./
COPY shared/package.json shared/tsconfig.json ./shared/
COPY shared/src ./shared/src/
COPY services/notification-service/package.json services/notification-service/tsconfig.json ./services/notification-service/
COPY services/notification-service/src ./services/notification-service/src/

RUN npm install --workspace=@nexus/shared --workspace=@nexus/notification-service
RUN npm run build --workspace=@nexus/shared
RUN npm run build --workspace=@nexus/notification-service

# ── Runtime stage ─────────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime
WORKDIR /app

RUN addgroup -S nexus && adduser -S nexus -G nexus

ENV NODE_ENV=production

COPY --from=builder /app/package.json ./
COPY --from=builder /app/shared/package.json ./shared/
COPY --from=builder /app/services/notification-service/package.json ./services/notification-service/

RUN npm install --workspace=@nexus/shared --workspace=@nexus/notification-service --omit=dev

COPY --from=builder /app/shared/dist ./shared/dist/
COPY --from=builder /app/services/notification-service/dist ./services/notification-service/dist/

USER nexus
EXPOSE 8080
CMD ["node", "services/notification-service/dist/app.js"]
