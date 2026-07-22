# ── Build stage ───────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder
WORKDIR /app

COPY package.json tsconfig.base.json ./
COPY shared/package.json shared/tsconfig.json ./shared/
COPY shared/src ./shared/src/
COPY services/marketing-intelligence/package.json services/marketing-intelligence/tsconfig.json ./services/marketing-intelligence/
COPY services/marketing-intelligence/src ./services/marketing-intelligence/src/

RUN npm install --workspace=@vertex/shared --workspace=@vertex/marketing-intelligence
RUN npm run build --workspace=@vertex/shared
RUN npm run build --workspace=@vertex/marketing-intelligence

# ── Runtime stage ─────────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime
WORKDIR /app

RUN addgroup -S nexus && adduser -S nexus -G nexus

ENV NODE_ENV=production

COPY --from=builder /app/package.json ./
COPY --from=builder /app/shared/package.json ./shared/
COPY --from=builder /app/services/marketing-intelligence/package.json ./services/marketing-intelligence/

RUN npm install --workspace=@vertex/shared --workspace=@vertex/marketing-intelligence --omit=dev

COPY --from=builder /app/shared/dist ./shared/dist/
COPY --from=builder /app/services/marketing-intelligence/dist ./services/marketing-intelligence/dist/

USER nexus
EXPOSE 8080
CMD ["node", "services/marketing-intelligence/dist/app.js"]
