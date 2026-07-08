# Vertex CRM — Complete Installation Guide

**From zero to a live product on Google Cloud — no prior knowledge required.**
Version 1.0 · Supports **macOS** and **Windows** · Billing works from **Costa Rica** (Paddle)

> **How to use this guide:** follow the sections in order and don't skip any. Every command is meant to be copied and pasted exactly. Where macOS and Windows differ, both paths are shown. When you finish §18, Vertex CRM is live on the internet.
>
> The companion file `VERTEX-OPERATIONS-RUNBOOK.md` is the short version for experienced operators; this guide explains every step.

---

## Part I — Get Your Computer Ready

### §1. What you are about to build

Vertex CRM is made of 9 small programs ("services") that run inside Google Cloud, one database, one cache, and one website. You will: create a Google Cloud account and project → install five tools on your computer → run one command that builds all the cloud infrastructure → load the database structure → upload the 9 programs → connect the payment system (Paddle) and WhatsApp → point your domain name at it. Total hands-on time: roughly 3–4 hours the first time.

### §2. Accounts you need before starting

Create these accounts first (all accept Costa Rica):

1. **Google Cloud** — https://cloud.google.com → "Get started for free". Add a credit/debit card (Google gives $300 free credit to new accounts).
2. **Paddle** — https://www.paddle.com → "Get started". Paddle is our payment system. During signup choose *Costa Rica* as your country and *SaaS* as your business type. Paddle will review your website and approve the account (usually 1–3 business days — **start this today** so it's ready when you reach §15).
3. **Meta for Developers** — https://developers.facebook.com (for WhatsApp and Facebook/Instagram data).
4. **Cal.com** — https://cal.com (free plan is fine; the AI agent books meetings here).
5. **SendGrid** — https://sendgrid.com (free plan sends 100 emails/day; used for notifications).
6. A **domain name** (e.g., `vertex-crm.io`) from any registrar such as Namecheap or GoDaddy.

### §3. Install the tools on your computer

You need five tools: **Git** (downloads code), **Node.js 20** (runs the code), **Docker Desktop** (packages the services), **Google Cloud CLI** (talks to Google), and **Terraform** (builds the infrastructure).

#### §3.1 macOS

Open the **Terminal** app (press `⌘+Space`, type "Terminal", press Enter) and paste each line, pressing Enter after each:

```bash
# 1. Homebrew — the Mac package installer (skip if you already have it)
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# 2. All five tools in one command
brew install git node@20 terraform
brew install --cask docker google-cloud-sdk

# 3. Start Docker Desktop once so it finishes setup
open -a Docker
```

#### §3.2 Windows

Vertex's scripts use Linux commands, so on Windows we work inside **WSL2** (Windows Subsystem for Linux) — a real Ubuntu terminal built into Windows. This is Microsoft's recommended way to do cloud development.

1. Open **PowerShell as Administrator** (right-click Start → "Terminal (Admin)") and run:
   ```powershell
   wsl --install
   ```
   Restart the computer when prompted. On restart, Ubuntu opens and asks you to create a username and password — remember them.
2. Install **Docker Desktop for Windows** from https://www.docker.com/products/docker-desktop/. During setup, keep "Use WSL 2 based engine" checked. Open Docker Desktop → Settings → Resources → WSL Integration → enable **Ubuntu**.
3. Open the **Ubuntu** app from the Start menu. Everything from here on happens in this Ubuntu window. Paste:
   ```bash
   sudo apt update && sudo apt install -y git curl unzip postgresql-client
   # Node.js 20
   curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt install -y nodejs
   # Terraform
   curl -fsSL https://apt.releases.hashicorp.com/gpg | sudo gpg --dearmor -o /usr/share/keyrings/hashicorp.gpg
   echo "deb [signed-by=/usr/share/keyrings/hashicorp.gpg] https://apt.releases.hashicorp.com $(lsb_release -cs) main" | sudo tee /etc/apt/sources.list.d/hashicorp.list
   sudo apt update && sudo apt install -y terraform
   # Google Cloud CLI
   curl https://packages.cloud.google.com/apt/doc/apt-key.gpg | sudo gpg --dearmor -o /usr/share/keyrings/cloud.google.gpg
   echo "deb [signed-by=/usr/share/keyrings/cloud.google.gpg] https://packages.cloud.google.com/apt cloud-sdk main" | sudo tee /etc/apt/sources.list.d/google-cloud-sdk.list
   sudo apt update && sudo apt install -y google-cloud-cli
   ```

#### §3.3 Verify (both systems)

```bash
git --version && node --version && docker --version && gcloud --version && terraform --version
```
Every line must print a version number. If one says "command not found", redo that tool's step before continuing.

*macOS extra:* also install the database client: `brew install libpq && brew link --force libpq` (gives you the `psql` command used in §10).

---

## Part II — Google Cloud Setup

### §4. Create the project

```bash
gcloud auth login                       # opens a browser — sign in
gcloud projects create vertex-crm-production --name="Vertex CRM"
gcloud config set project vertex-crm-production
```

Then link billing: https://console.cloud.google.com/billing → select the project → link your billing account. (Nothing works without this.)

### §5. Turn on the Google services Vertex uses

Copy-paste as one block:

```bash
gcloud services enable run.googleapis.com sqladmin.googleapis.com \
  redis.googleapis.com pubsub.googleapis.com artifactregistry.googleapis.com \
  secretmanager.googleapis.com storage.googleapis.com aiplatform.googleapis.com \
  bigquery.googleapis.com vpcaccess.googleapis.com cloudbuild.googleapis.com \
  compute.googleapis.com iam.googleapis.com firebase.googleapis.com
```

This takes 2–3 minutes. Each API prints "Operation finished successfully".

### §6. Get the Vertex CRM code

```bash
cd ~
git clone https://github.com/YOUR-ORG/vertex-crm.git   # replace with your repo URL
cd vertex-crm
```

If the code was delivered to you as a folder instead of a Git repository, just place the `vertex-crm` folder in your home directory and `cd vertex-crm`.

### §7. Set your working variables

Paste this at the start of every terminal session while installing:

```bash
export PROJECT_ID=vertex-crm-production
export REGION=us-central1
export REGISTRY=$REGION-docker.pkg.dev/$PROJECT_ID/vertex-crm
export TAG=v1.0.0
gcloud config set project $PROJECT_ID
```

---

## Part III — Build the Infrastructure

### §8. One-time Terraform preparation

Terraform needs a place to remember what it built:

```bash
gcloud storage buckets create gs://$PROJECT_ID-terraform-state --location=$REGION
```

### §9. Build everything with Terraform

```bash
cd infrastructure/terraform
terraform init -backend-config="bucket=$PROJECT_ID-terraform-state"
terraform workspace new production
terraform apply -var-file=production.tfvars
```

Terraform prints a long plan and asks `Do you want to perform these actions?` — type `yes`. It now builds (≈ 12–15 min): the private network, the PostgreSQL database, the Redis cache, the BigQuery dataset, all Pub/Sub message channels, the storage buckets, and the container registry. When it finishes, save the outputs:

```bash
terraform output > ../terraform-outputs.txt
cd ../..
```

That file contains the database connection name and Redis address — you'll paste from it in the next steps.

### §10. Load the database structure (migrations)

The database starts empty; six numbered SQL files create every table. **Run all six, in order — including 006** (it contains the Paddle billing columns and dashboard fixes; without it the product does not work).

```bash
# Download the small proxy program that connects your computer securely to the cloud database
# macOS (Apple Silicon):
curl -o cloud-sql-proxy https://storage.googleapis.com/cloud-sql-connectors/cloud-sql-proxy/v2.11.0/cloud-sql-proxy.darwin.arm64
# Windows/WSL or Intel Mac:
curl -o cloud-sql-proxy https://storage.googleapis.com/cloud-sql-connectors/cloud-sql-proxy/v2.11.0/cloud-sql-proxy.linux.amd64

chmod +x cloud-sql-proxy
./cloud-sql-proxy $PROJECT_ID:$REGION:vertex-crm-db --port 5432 &

# Run the six migrations (enter the DB password from terraform-outputs.txt when asked)
for m in infrastructure/migrations/001*.sql infrastructure/migrations/002*.sql \
         infrastructure/migrations/003*.sql infrastructure/migrations/004*.sql \
         infrastructure/migrations/005*.sql infrastructure/migrations/006*.sql; do
  echo "Running $m"
  psql -h 127.0.0.1 -U vertex_app -d vertex_crm -v ON_ERROR_STOP=1 -f "$m" || break
done
kill %1   # stop the proxy
```

Success looks like a stream of `CREATE TABLE` / `ALTER TABLE` lines with **no line starting with `ERROR`**. (These exact six files were tested end-to-end on a live PostgreSQL 16 before delivery — they pass 6/6.)

### §11. Store the secret keys

Every password and API key lives in Google Secret Manager, never in code. The complete list is in the file `.env.example` at the repo root. Create each one like this:

```bash
echo -n "PASTE-THE-REAL-VALUE" | gcloud secrets create SECRET_NAME --data-file=-
```

Minimum set to boot the platform: `DATABASE_URL`, `REDIS_URL` (both assembled from `terraform-outputs.txt` — the exact format is commented inside `.env.example`), `JWT_ISSUER`, plus later: the six `PADDLE_*` values (§15), `SENDGRID_API_KEY`, `META_APP_SECRET`, `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_VERIFY_TOKEN` (§16), and `CALCOM_API_KEY`.

---

## Part IV — Put the Programs in the Cloud

### §12. Build and deploy the nine services

**Build** (≈ 15 min total):

```bash
gcloud auth configure-docker $REGION-docker.pkg.dev
for svc in api-gateway crm-service marketing-intelligence ai-sales-agent \
           workflow-engine billing-service notification-service embedding-service; do
  docker build -t $REGISTRY/$svc:$TAG -f services/$svc/Dockerfile . && docker push $REGISTRY/$svc:$TAG
done
docker build -t $REGISTRY/frontend:$TAG -f frontend/Dockerfile frontend/ && docker push $REGISTRY/frontend:$TAG
```

**Deploy.** Four services are public (people or webhooks reach them from the internet); five are private (only other services may call them). Deploy the private ones first:

```bash
VPC_FLAGS="--vpc-connector=vertex-connector --vpc-egress=private-ranges-only"
COMMON="--region=$REGION --platform=managed --port=8080 --memory=512Mi --cpu=1 \
  --service-account=vertex-crm-sa@$PROJECT_ID.iam.gserviceaccount.com $VPC_FLAGS \
  --set-secrets=DATABASE_URL=DATABASE_URL:latest,REDIS_URL=REDIS_URL:latest"

# ── private services ──
gcloud run deploy crm-service      --image=$REGISTRY/crm-service:$TAG      $COMMON --no-allow-unauthenticated --min-instances=1
gcloud run deploy marketing-intelligence --image=$REGISTRY/marketing-intelligence:$TAG $COMMON --no-allow-unauthenticated \
  --set-secrets=META_APP_SECRET=META_APP_SECRET:latest
gcloud run deploy workflow-engine  --image=$REGISTRY/workflow-engine:$TAG  $COMMON --no-allow-unauthenticated
gcloud run deploy notification-service --image=$REGISTRY/notification-service:$TAG $COMMON --no-allow-unauthenticated \
  --set-secrets=SENDGRID_API_KEY=SENDGRID_API_KEY:latest
gcloud run deploy embedding-service --image=$REGISTRY/embedding-service:$TAG $COMMON --no-allow-unauthenticated --memory=2Gi

# ── public services ──
gcloud run deploy billing-service  --image=$REGISTRY/billing-service:$TAG  $COMMON --allow-unauthenticated --min-instances=1 \
  --set-env-vars=PADDLE_ENV=production \
  --set-secrets=PADDLE_API_KEY=PADDLE_API_KEY:latest,PADDLE_WEBHOOK_SECRET=PADDLE_WEBHOOK_SECRET:latest,PADDLE_PRICE_STARTER=PADDLE_PRICE_STARTER:latest,PADDLE_PRICE_GROWTH=PADDLE_PRICE_GROWTH:latest,PADDLE_PRICE_SCALE=PADDLE_PRICE_SCALE:latest,PADDLE_PRICE_ENTERPRISE=PADDLE_PRICE_ENTERPRISE:latest
gcloud run deploy ai-sales-agent   --image=$REGISTRY/ai-sales-agent:$TAG   $COMMON --allow-unauthenticated --min-instances=1 \
  --set-secrets=WHATSAPP_ACCESS_TOKEN=WHATSAPP_ACCESS_TOKEN:latest,WHATSAPP_VERIFY_TOKEN=WHATSAPP_VERIFY_TOKEN:latest,CALCOM_API_KEY=CALCOM_API_KEY:latest
gcloud run deploy api-gateway      --image=$REGISTRY/api-gateway:$TAG      $COMMON --allow-unauthenticated --min-instances=1
gcloud run deploy frontend         --image=$REGISTRY/frontend:$TAG --region=$REGION --platform=managed \
  --port=3000 --memory=512Mi --allow-unauthenticated --min-instances=1
```

Each deploy ends with a green check and a `Service URL`. Copy the **api-gateway** and **frontend** URLs — you need them in §13–§16.

### §13. Quick health check

```bash
for svc in api-gateway crm-service marketing-intelligence ai-sales-agent \
           workflow-engine billing-service notification-service embedding-service frontend; do
  echo -n "$svc → "
  curl -s "$(gcloud run services describe $svc --region=$REGION --format='value(status.url)')/health"
  echo ""
done
```

All nine must answer `{"status":"ok", ...}`. If one fails, read its logs: `gcloud run services logs read SERVICE-NAME --region=$REGION --limit=30` — 90 % of failures at this stage are a missing secret from §11.

### §14. Connect the internal messaging (Pub/Sub)

Services talk to each other through message channels. Terraform created the channels; now tell each channel which service to deliver to.

#### §14.1 Allow Pub/Sub to call the services

```bash
gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:service-$(gcloud projects describe $PROJECT_ID --format='value(projectNumber)')@gcp-sa-pubsub.iam.gserviceaccount.com" \
  --role="roles/iam.serviceAccountTokenCreator"
```

#### §14.2 Create the push subscriptions

```bash
GW=$(gcloud run services describe api-gateway --region=$REGION --format='value(status.url)')
WF=$(gcloud run services describe workflow-engine --region=$REGION --format='value(status.url)')
NT=$(gcloud run services describe notification-service --region=$REGION --format='value(status.url)')
AG=$(gcloud run services describe ai-sales-agent --region=$REGION --format='value(status.url)')
EM=$(gcloud run services describe embedding-service --region=$REGION --format='value(status.url)')
SA=vertex-crm-sa@$PROJECT_ID.iam.gserviceaccount.com

gcloud pubsub subscriptions create workflow-triggers-push  --topic=workflow.triggered      --push-endpoint=$WF/workflows/pubsub     --push-auth-service-account=$SA --max-delivery-attempts=5 --dead-letter-topic=dead-letter
gcloud pubsub subscriptions create crm-events-workflow     --topic=crm.events              --push-endpoint=$WF/workflows/pubsub     --push-auth-service-account=$SA --max-delivery-attempts=5 --dead-letter-topic=dead-letter
gcloud pubsub subscriptions create notifications-push      --topic=notifications.dispatch  --push-endpoint=$NT/notifications/pubsub --push-auth-service-account=$SA --max-delivery-attempts=5 --dead-letter-topic=dead-letter
gcloud pubsub subscriptions create agent-handoff-push      --topic=conversation.handoff.requested --push-endpoint=$AG/agent/pubsub  --push-auth-service-account=$SA --max-delivery-attempts=5 --dead-letter-topic=dead-letter
gcloud pubsub subscriptions create kb-ready-push           --topic=kb.document.ready       --push-endpoint=$EM/kb/pubsub            --push-auth-service-account=$SA --max-delivery-attempts=5 --dead-letter-topic=dead-letter
```

---

## Part V — Payments, WhatsApp, and Your Domain

### §15. Paddle — the payment system (works from Costa Rica)

Paddle is a *Merchant of Record*: legally, Paddle sells Vertex subscriptions to your customers, handles the taxes in every country, and pays you out to Costa Rica. That is why no US company is needed.

1. **Log in** at https://vendors.paddle.com (account from §2).
2. **Create the products.** Catalog → Products → *New product* named "Vertex CRM". Inside it create four *Prices* (monthly, USD): Starter $49, Growth $149, Scale $399, Enterprise $999 (adjust to your real pricing). Each price shows an ID starting with `pri_` — copy all four.
3. **Get your API key.** Developer Tools → Authentication → *New API key* → copy the value starting `pdl_live_`.
4. **Create the webhook.** Developer Tools → Notifications → *New destination* → URL:
   `https://api.YOUR-DOMAIN/api/billing/webhooks/paddle` (or the api-gateway `run.app` URL + that path until §17 is done). Tick these events: `subscription.created`, `subscription.activated`, `subscription.updated`, `subscription.canceled`, `subscription.past_due`, `transaction.completed`. Save, then copy the **secret key** (`pdl_ntfset_...`).
5. **Store all six values as secrets** (§11 pattern): `PADDLE_API_KEY`, `PADDLE_WEBHOOK_SECRET`, `PADDLE_PRICE_STARTER`, `PADDLE_PRICE_GROWTH`, `PADDLE_PRICE_SCALE`, `PADDLE_PRICE_ENTERPRISE` — then redeploy billing-service (rerun its §12 command) so it picks them up.
6. **Test in sandbox first (recommended):** Paddle has a separate sandbox at https://sandbox-vendors.paddle.com. Repeat steps 2–5 there, set `PADDLE_ENV=sandbox` on billing-service, buy a subscription with Paddle's test card `4242 4242 4242 4242`, and confirm the tenant's plan flips to *active* in the app. Then switch back to `PADDLE_ENV=production` with the live keys.

### §16. WhatsApp for the AI sales agent

1. https://developers.facebook.com → My Apps → *Create App* → type **Business**.
2. Add the **WhatsApp** product → you get a test phone number and a temporary access token.
3. Configuration → Webhook → Callback URL: `https://api.YOUR-DOMAIN/api/agent/webhook/whatsapp` · Verify token: invent a long random string, save it as the `WHATSAPP_VERIFY_TOKEN` secret, and paste the same string here. Click *Verify and save* — Vertex answers the challenge automatically. Subscribe to the `messages` field.
4. Store the access token as `WHATSAPP_ACCESS_TOKEN` and redeploy ai-sales-agent.
(For production traffic later: verify your business in Meta Business Manager and register a real phone number.)

### §17. Domain, HTTPS, and the load balancer

```bash
# One public IP for everything
gcloud compute addresses create vertex-lb-ip --global
gcloud compute addresses describe vertex-lb-ip --global --format='value(address)'
```

At your domain registrar create two **A records** pointing to that IP: `app.YOUR-DOMAIN` and `api.YOUR-DOMAIN`. Then:

```bash
gcloud compute ssl-certificates create vertex-cert --domains=app.YOUR-DOMAIN,api.YOUR-DOMAIN --global

# Two serverless backends
for pair in "frontend app" "api-gateway api"; do
  set -- $pair
  gcloud compute network-endpoint-groups create $1-neg --region=$REGION --network-endpoint-type=serverless --cloud-run-service=$1
  gcloud compute backend-services create $1-backend --global --load-balancing-scheme=EXTERNAL_MANAGED
  gcloud compute backend-services add-backend $1-backend --global --network-endpoint-group=$1-neg --network-endpoint-group-region=$REGION
done

# URL map: app.→frontend, api.→gateway
gcloud compute url-maps create vertex-lb --default-service=frontend-backend
gcloud compute url-maps add-path-matcher vertex-lb --path-matcher-name=api-matcher --default-service=api-gateway-backend --new-hosts=api.YOUR-DOMAIN
gcloud compute target-https-proxies create vertex-https-proxy --url-map=vertex-lb --ssl-certificates=vertex-cert
gcloud compute forwarding-rules create vertex-https-rule --global --target-https-proxy=vertex-https-proxy --address=vertex-lb-ip --ports=443
```

The certificate turns ACTIVE 15–60 minutes after DNS propagates. Check: `gcloud compute ssl-certificates describe vertex-cert --global --format='value(managed.status)'`.

### §18. First login — see the dashboard

Open `https://app.YOUR-DOMAIN`, sign in with Google, create the first workspace, and open **Dashboard**. You should see the animated experience built to the approved design: KPI cards that count up with spring physics, the gradient 12-month performance chart, the beveled-depth conversion funnel, the Top Leads (last 30 days) table with score bars, and the Next Follow-Ups queue — auto-refreshing every 60 seconds. (Cards will be mostly zeros until the first leads arrive through WhatsApp or the connectors.)

---

## Part VI — Reference

### §19. What it costs per month

| Item | Estimate (0–50 tenants) |
|---|---|
| Cloud SQL (4 vCPU / 15 GB HA) | ≈ $260 |
| Memorystore Redis 4 GB HA | ≈ $150 |
| Cloud Run (5 services at min-1, rest scale to zero) | ≈ $90–150 |
| Load balancer + IP | ≈ $25 |
| BigQuery, Pub/Sub, GCS, Secret Manager | ≈ $20–50 |
| Vertex AI (Gemini + Vector Search, usage-based) | ≈ $100–150 |
| **Total** | **≈ $650–800/mo** |
| Paddle | no monthly fee — 5 % + $0.50 per transaction, deducted before payout |

Cost-saving switch for a pilot: drop Cloud SQL to `db-custom-2-7680` and Redis to 1 GB BASIC ≈ **$300/mo total**.

### §20. If something goes wrong

| Symptom | Fix |
|---|---|
| A service's `/health` fails | `gcloud run services logs read NAME --region=$REGION --limit=30` — almost always a missing/typo'd secret name |
| `ERROR` during migrations | Stop. Note which file/line, restore order, rerun from that file. Never skip a file. |
| Paddle webhook shows failures in Paddle dashboard | Confirm the URL path is exactly `/api/billing/webhooks/paddle` and `PADDLE_WEBHOOK_SECRET` matches the destination's secret |
| WhatsApp verify fails | The verify token string in Meta and in the `WHATSAPP_VERIFY_TOKEN` secret must be byte-identical |
| Certificate stuck in PROVISIONING | DNS hasn't propagated; check with `dig app.YOUR-DOMAIN` and wait |
| Dashboard loads but empty | Normal with no data — confirm migration 006 ran (it adds the scoring columns the dashboard reads) |

---

*Vertex CRM Installation Guide v1.0 — companion documents: `VERTEX-OPERATIONS-RUNBOOK.md` (ops fast-path + full architecture diagram) and `VERTEX-TOGAF-ARCHITECTURE.md` (internal architecture reference).*
