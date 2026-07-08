# ─── staging.tfvars ───────────────────────────────────────────────────────────
# Staging environment — cost-optimized, single-zone, smaller instances.
# Deploy with: terraform apply -var-file=staging.tfvars

project_id  = "vertex-crm-staging"
region      = "us-central1"
environment = "staging"

# Database — smaller machine, zonal (no HA) to save cost
db_tier          = "db-custom-2-7680"   # 2 vCPU, 7.5 GB RAM
db_deletion_protection = false          # Allow destroy in staging

# Redis — BASIC (no HA) for staging
redis_tier        = "BASIC"
redis_memory_gb   = 4

# Cloud Run — lower concurrency and minimums
min_instances     = 0                    # Scale to zero
max_instances     = 3
cpu_limit         = "1000m"
memory_limit      = "512Mi"

# Image tag — set by CI pipeline
image_tag         = "latest"

# Alerts
alert_email       = "eng-staging@vertexcrm.io"
