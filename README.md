# Vertex CRM

Multi-tenant B2B SaaS CRM on Google Cloud — AI sales agent (WhatsApp/Messenger/Instagram),
marketing intelligence (Meta · TikTok · Google Ads → BigQuery), workflow automation,
and Paddle subscription billing (Merchant of Record — operational from Costa Rica).

## Documentation
| Doc | Audience |
|---|---|
| [OPERATIONS.md](OPERATIONS.md) | Ops team — system diagram, dependencies, DNS/IP/LB, deploy order, go-live checklist |
| [docs/INSTALLATION-GUIDE.md](docs/INSTALLATION-GUIDE.md) | Zero-to-production, no prior knowledge, macOS + Windows |
| [docs/ARCHITECTURE-TOGAF.md](docs/ARCHITECTURE-TOGAF.md) | Internal — full TOGAF architecture + peer-review defect register |

## Repository layout
```
services/           9 backend microservices (TypeScript · Fastify · Cloud Run)
shared/             Shared types, schemas, DB/PubSub utilities
frontend/           Next.js 14 app — Aura design system, animated dashboard
infrastructure/
  terraform/        All GCP infrastructure as code
  migrations/       001–006 SQL migrations (run in order, all six)
.cloudbuild/        CI/CD pipeline (canary 10% → 100%)
```

## Quick start
Follow [docs/INSTALLATION-GUIDE.md](docs/INSTALLATION-GUIDE.md) §1–§18. Status: peer-reviewed,
6/6 migrations verified live, 44/44 files parse clean, 10 defects found & fixed pre-release.
