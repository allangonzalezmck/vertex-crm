# ─── production.tfvars ────────────────────────────────────────────────────────
# Production environment — HA, higher machine tier, multi-region resilience.
# Deploy with: terraform apply -var-file=production.tfvars

project_id  = "vertex-crm-production"
region      = "us-central1"
environment = "production"

# Database — High Availability, larger machine
db_tier               = "db-custom-4-15360"   # 4 vCPU, 15 GB RAM
db_deletion_protection = true

# Redis — STANDARD_HA with 8 GB
redis_tier        = "STANDARD_HA"
redis_memory_gb   = 8

# Cloud Run — always-on minimum instances per service
min_instances     = 1
max_instances     = 10
cpu_limit         = "2000m"
memory_limit      = "1Gi"

# Image tag — set by CI pipeline (e.g. git SHA)
image_tag         = "latest"

# Alerts
alert_email       = "eng-oncall@vertexcrm.io"
