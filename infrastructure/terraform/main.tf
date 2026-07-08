/**
 * @file infrastructure/terraform/main.tf
 * @description Root Terraform configuration for Vertex CRM on GCP.
 * Provisions: VPC, Cloud SQL, Memorystore, Pub/Sub, Cloud Run services,
 * Artifact Registry, Secret Manager, IAM service accounts.
 *
 * Usage:
 *   terraform workspace select staging
 *   terraform apply -var-file=environments/staging.tfvars
 */

terraform {
  required_version = ">= 1.7.0"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.20"
    }
    google-beta = {
      source  = "hashicorp/google-beta"
      version = "~> 5.20"
    }
  }

  backend "gcs" {
    # bucket and prefix are injected per environment:
    # terraform init -backend-config=environments/staging.backend.hcl
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

provider "google-beta" {
  project = var.project_id
  region  = var.region
}

# ─── Local Values ─────────────────────────────────────────────────────────────

locals {
  env    = terraform.workspace  # staging | production
  prefix = "vertex-${local.env}"

  # Services and their Cloud Run configs
  services = {
    api-gateway = {
      image      = "${var.region}-docker.pkg.dev/${var.project_id}/vertex-crm/api-gateway"
      cpu        = "1"
      memory     = "512Mi"
      min_instances = 1
      max_instances = 100
      port       = 8080
    }
    crm-service = {
      image      = "${var.region}-docker.pkg.dev/${var.project_id}/vertex-crm/crm-service"
      cpu        = "1"
      memory     = "512Mi"
      min_instances = 1
      max_instances = 100
      port       = 8080
    }
    marketing-intelligence = {
      image      = "${var.region}-docker.pkg.dev/${var.project_id}/vertex-crm/marketing-intelligence"
      cpu        = "2"
      memory     = "1Gi"
      min_instances = 0
      max_instances = 50
      port       = 8080
    }
    ai-sales-agent = {
      image      = "${var.region}-docker.pkg.dev/${var.project_id}/vertex-crm/ai-sales-agent"
      cpu        = "2"
      memory     = "2Gi"
      min_instances = 1
      max_instances = 100
      port       = 8080
    }
    workflow-engine = {
      image      = "${var.region}-docker.pkg.dev/${var.project_id}/vertex-crm/workflow-engine"
      cpu        = "1"
      memory     = "512Mi"
      min_instances = 0
      max_instances = 50
      port       = 8080
    }
    billing-service = {
      image      = "${var.region}-docker.pkg.dev/${var.project_id}/vertex-crm/billing-service"
      cpu        = "1"
      memory     = "256Mi"
      min_instances = 1
      max_instances = 20
      port       = 8080
    }
    notification-service = {
      image      = "${var.region}-docker.pkg.dev/${var.project_id}/vertex-crm/notification-service"
      cpu        = "1"
      memory     = "256Mi"
      min_instances = 0
      max_instances = 50
      port       = 8080
    }
  }

  # Pub/Sub topics
  pubsub_topics = [
    "lead-events",
    "conversation-events",
    "sync-triggers",
    "workflow-triggers",
    "notification-events",
    "billing-events",
  ]

  common_env_vars = {
    GCP_PROJECT_ID      = var.project_id
    GCP_LOCATION        = var.region
    NODE_ENV            = local.env == "production" ? "production" : "staging"
    REDIS_HOST          = google_redis_instance.cache.host
    REDIS_PORT          = tostring(google_redis_instance.cache.port)
    DB_HOST             = google_sql_database_instance.primary.private_ip_address
    DB_PORT             = "5432"
    DB_NAME             = "vertex_crm"
  }
}

# ─── VPC ─────────────────────────────────────────────────────────────────────

resource "google_compute_network" "vpc" {
  name                    = "${local.prefix}-vpc"
  auto_create_subnetworks = false
  routing_mode            = "REGIONAL"
}

resource "google_compute_subnetwork" "services" {
  name          = "${local.prefix}-services-subnet"
  ip_cidr_range = "10.0.0.0/24"
  region        = var.region
  network       = google_compute_network.vpc.id

  private_ip_google_access = true

  log_config {
    aggregation_interval = "INTERVAL_5_SEC"
    flow_sampling        = 0.5
    metadata             = "INCLUDE_ALL_METADATA"
  }
}

# VPC Connector for Cloud Run → VPC (Cloud SQL, Redis)
resource "google_vpc_access_connector" "connector" {
  name          = "${local.prefix}-connector"
  region        = var.region
  subnet {
    name = google_compute_subnetwork.services.name
  }
  machine_type  = "e2-micro"
  min_instances = 2
  max_instances = 10
}

# Cloud NAT for outbound internet from Cloud Run
resource "google_compute_router" "router" {
  name    = "${local.prefix}-router"
  region  = var.region
  network = google_compute_network.vpc.id
}

resource "google_compute_router_nat" "nat" {
  name                               = "${local.prefix}-nat"
  router                             = google_compute_router.router.name
  region                             = var.region
  nat_ip_allocate_option             = "AUTO_ONLY"
  source_subnetwork_ip_ranges_to_nat = "ALL_SUBNETWORKS_ALL_IP_RANGES"
}

# ─── Cloud SQL (PostgreSQL 15) ────────────────────────────────────────────────

resource "google_sql_database_instance" "primary" {
  name             = "${local.prefix}-pg"
  database_version = "POSTGRES_15"
  region           = var.region

  deletion_protection = local.env == "production"

  settings {
    tier              = var.db_tier    # db-n1-standard-2 for staging, db-n1-highmem-4 for prod
    availability_type = local.env == "production" ? "REGIONAL" : "ZONAL"
    disk_autoresize   = true
    disk_size         = 50
    disk_type         = "PD_SSD"

    backup_configuration {
      enabled                        = true
      start_time                     = "03:00"
      point_in_time_recovery_enabled = true
      transaction_log_retention_days = 7
      backup_retention_settings {
        retained_backups = 30
      }
    }

    ip_configuration {
      ipv4_enabled    = false
      private_network = google_compute_network.vpc.id
      enable_private_path_for_google_cloud_services = true
    }

    database_flags {
      name  = "max_connections"
      value = "200"
    }
    database_flags {
      name  = "log_checkpoints"
      value = "on"
    }
    database_flags {
      name  = "log_connections"
      value = "on"
    }
    database_flags {
      name  = "log_disconnections"
      value = "on"
    }
    database_flags {
      name  = "log_lock_waits"
      value = "on"
    }
    database_flags {
      name  = "log_min_duration_statement"
      value = "1000"  # Log queries >1s
    }

    insights_config {
      query_insights_enabled  = true
      query_plans_per_minute  = 5
      query_string_length     = 4500
      record_application_tags = true
      record_client_address   = false
    }

    maintenance_window {
      day          = 7   # Sunday
      hour         = 4   # 4 AM UTC
      update_track = "stable"
    }
  }
}

resource "google_sql_database" "vertex_crm" {
  name     = "vertex_crm"
  instance = google_sql_database_instance.primary.name
  charset  = "UTF8"
}

resource "google_sql_user" "app_user" {
  name     = "vertex_app"
  instance = google_sql_database_instance.primary.name
  password = data.google_secret_manager_secret_version.db_password.secret_data
}

# ─── Memorystore (Redis 7) ────────────────────────────────────────────────────

resource "google_redis_instance" "cache" {
  name           = "${local.prefix}-redis"
  tier           = local.env == "production" ? "STANDARD_HA" : "BASIC"
  memory_size_gb = local.env == "production" ? 4 : 1
  redis_version  = "REDIS_7_0"
  region         = var.region

  authorized_network = google_compute_network.vpc.id
  connect_mode       = "PRIVATE_SERVICE_ACCESS"

  redis_configs = {
    maxmemory-policy = "allkeys-lru"
    notify-keyspace-events = "Ex"  # Expired key events for TTL callbacks
  }

  maintenance_policy {
    weekly_maintenance_window {
      day = "SUNDAY"
      start_time {
        hours   = 5
        minutes = 0
      }
    }
  }
}

# ─── Pub/Sub Topics ──────────────────────────────────────────────────────────

resource "google_pubsub_topic" "topics" {
  for_each = toset(local.pubsub_topics)

  name = "${local.prefix}-${each.key}"

  message_storage_policy {
    allowed_persistence_regions = [var.region]
  }

  # Message retention: 7 days
  message_retention_duration = "604800s"
}

# Dead Letter Topics
resource "google_pubsub_topic" "dlq_topics" {
  for_each = toset(local.pubsub_topics)

  name = "${local.prefix}-${each.key}-dlq"

  message_retention_duration = "604800s"
}

# Subscriptions for each topic
resource "google_pubsub_subscription" "subscriptions" {
  for_each = {
    "lead-events-crm"            = "lead-events"
    "conversation-events-agent"  = "conversation-events"
    "sync-triggers-marketing"    = "sync-triggers"
    "workflow-triggers-engine"   = "workflow-triggers"
    "notification-events-notif"  = "notification-events"
    "billing-events-billing"     = "billing-events"
  }

  name  = "${local.prefix}-${each.key}"
  topic = google_pubsub_topic.topics[each.value].name

  ack_deadline_seconds       = 60
  message_retention_duration = "604800s"
  retain_acked_messages      = false

  retry_policy {
    minimum_backoff = "10s"
    maximum_backoff = "600s"
  }

  dead_letter_policy {
    dead_letter_topic     = google_pubsub_topic.dlq_topics[each.value].name
    max_delivery_attempts = 5
  }

  # Push to Cloud Run (service-specific endpoint)
  push_config {
    push_endpoint = "https://${each.key}.${var.region}.run.app/pubsub/${split("-", each.key)[0]}"

    oidc_token {
      service_account_email = google_service_account.pubsub_invoker.email
    }
  }
}

# ─── Service Accounts ────────────────────────────────────────────────────────

resource "google_service_account" "cloud_run_sa" {
  account_id   = "${local.prefix}-run-sa"
  display_name = "Vertex CRM Cloud Run Service Account"
}

resource "google_service_account" "pubsub_invoker" {
  account_id   = "${local.prefix}-pubsub-sa"
  display_name = "Vertex CRM Pub/Sub Invoker"
}

# IAM: Cloud Run SA permissions
resource "google_project_iam_member" "run_sa_roles" {
  for_each = toset([
    "roles/cloudsql.client",
    "roles/secretmanager.secretAccessor",
    "roles/pubsub.publisher",
    "roles/pubsub.subscriber",
    "roles/bigquery.dataEditor",
    "roles/bigquery.jobUser",
    "roles/aiplatform.user",
    "roles/storage.objectUser",
    "roles/cloudtrace.agent",
  ])

  project = var.project_id
  role    = each.key
  member  = "serviceAccount:${google_service_account.cloud_run_sa.email}"
}

# IAM: Pub/Sub invoker can invoke Cloud Run
resource "google_project_iam_member" "pubsub_invoker_role" {
  project = var.project_id
  role    = "roles/run.invoker"
  member  = "serviceAccount:${google_service_account.pubsub_invoker.email}"
}

# ─── Cloud Run Services ───────────────────────────────────────────────────────

resource "google_cloud_run_v2_service" "services" {
  for_each = local.services

  name     = "${local.prefix}-${each.key}"
  location = var.region

  ingress = each.key == "api-gateway" ? "INGRESS_TRAFFIC_ALL" : "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER"

  template {
    service_account = google_service_account.cloud_run_sa.email

    scaling {
      min_instance_count = each.value.min_instances
      max_instance_count = each.value.max_instances
    }

    vpc_access {
      connector = google_vpc_access_connector.connector.id
      egress    = "PRIVATE_RANGES_ONLY"
    }

    containers {
      image = "${each.value.image}:${var.image_tag}"

      ports {
        container_port = each.value.port
      }

      resources {
        limits = {
          cpu    = each.value.cpu
          memory = each.value.memory
        }
        cpu_idle          = true
        startup_cpu_boost = true
      }

      # Common environment variables
      dynamic "env" {
        for_each = local.common_env_vars
        content {
          name  = env.key
          value = env.value
        }
      }

      # Secrets from Secret Manager
      env {
        name = "DB_PASSWORD"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.db_password.secret_id
            version = "latest"
          }
        }
      }

      env {
        name = "REDIS_PASSWORD"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.redis_password.secret_id
            version = "latest"
          }
        }
      }

      env {
        name = "JWT_SECRET"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.jwt_secret.secret_id
            version = "latest"
          }
        }
      }

      liveness_probe {
        http_get {
          path = "/health"
        }
        initial_delay_seconds = 10
        period_seconds        = 30
        failure_threshold     = 3
      }

      startup_probe {
        http_get {
          path = "/ready"
        }
        initial_delay_seconds = 5
        period_seconds        = 5
        failure_threshold     = 10
      }
    }
  }

  traffic {
    type    = "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST"
    percent = 100
  }

  lifecycle {
    ignore_changes = [
      # Image tag managed by CI/CD
      template[0].containers[0].image,
    ]
  }
}

# ─── Artifact Registry ────────────────────────────────────────────────────────

resource "google_artifact_registry_repository" "vertex" {
  location      = var.region
  repository_id = "vertex-crm"
  description   = "Vertex CRM container images"
  format        = "DOCKER"

  cleanup_policies {
    id     = "keep-last-10"
    action = "KEEP"
    most_recent_versions {
      keep_count = 10
    }
  }
}

# ─── Secret Manager ───────────────────────────────────────────────────────────

resource "google_secret_manager_secret" "db_password" {
  secret_id = "${local.prefix}-db-password"
  replication {
    auto {}
  }
}

resource "google_secret_manager_secret" "redis_password" {
  secret_id = "${local.prefix}-redis-password"
  replication {
    auto {}
  }
}

resource "google_secret_manager_secret" "jwt_secret" {
  secret_id = "${local.prefix}-jwt-secret"
  replication {
    auto {}
  }
}

# Data source: read existing secret versions (created out-of-band by secrets rotation)
data "google_secret_manager_secret_version" "db_password" {
  secret = google_secret_manager_secret.db_password.secret_id
}

# ─── BigQuery ────────────────────────────────────────────────────────────────

resource "google_bigquery_dataset" "analytics" {
  dataset_id                  = "vertex_analytics"
  friendly_name               = "Vertex CRM Analytics"
  description                 = "Marketing intelligence and conversation analytics"
  location                    = "US"
  default_table_expiration_ms = null  # Tables managed by the application

  access {
    role          = "OWNER"
    user_by_email = google_service_account.cloud_run_sa.email
  }

  access {
    role          = "WRITER"
    user_by_email = google_service_account.cloud_run_sa.email
  }
}
