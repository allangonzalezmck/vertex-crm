/**
 * Terraform outputs — exposes key resource identifiers post-apply.
 * Used by CI/CD pipelines and the deployment scripts.
 */

# ─── Network ──────────────────────────────────────────────────────────────────

output "vpc_id" {
  description = "VPC network self-link"
  value       = google_compute_network.vertex_vpc.self_link
}

output "vpc_connector_id" {
  description = "Serverless VPC Access connector for Cloud Run → private resources"
  value       = google_vpc_access_connector.vertex_connector.id
}

# ─── Database ─────────────────────────────────────────────────────────────────

output "db_connection_name" {
  description = "Cloud SQL connection name (project:region:instance)"
  value       = google_sql_database_instance.vertex_postgres.connection_name
}

output "db_private_ip" {
  description = "Cloud SQL private IP (accessible via VPC)"
  value       = google_sql_database_instance.vertex_postgres.private_ip_address
  sensitive   = true
}

output "db_instance_name" {
  description = "Cloud SQL instance name"
  value       = google_sql_database_instance.vertex_postgres.name
}

# ─── Redis ────────────────────────────────────────────────────────────────────

output "redis_host" {
  description = "Memorystore Redis host"
  value       = google_redis_instance.vertex_redis.host
  sensitive   = true
}

output "redis_port" {
  description = "Memorystore Redis port"
  value       = google_redis_instance.vertex_redis.port
}

# ─── Cloud Run Service URLs ───────────────────────────────────────────────────

output "crm_service_url" {
  description = "CRM service Cloud Run URL"
  value       = google_cloud_run_v2_service.crm_service.uri
}

output "marketing_intelligence_url" {
  description = "Marketing Intelligence service Cloud Run URL"
  value       = google_cloud_run_v2_service.marketing_intelligence.uri
}

output "ai_sales_agent_url" {
  description = "AI Sales Agent service Cloud Run URL"
  value       = google_cloud_run_v2_service.ai_sales_agent.uri
}

output "workflow_engine_url" {
  description = "Workflow Engine service Cloud Run URL"
  value       = google_cloud_run_v2_service.workflow_engine.uri
}

output "notification_service_url" {
  description = "Notification service Cloud Run URL"
  value       = google_cloud_run_v2_service.notification_service.uri
}

# ─── Artifact Registry ────────────────────────────────────────────────────────

output "artifact_registry_repo" {
  description = "Artifact Registry Docker repository path"
  value       = "${var.region}-docker.pkg.dev/${var.project_id}/vertex-crm"
}

# ─── BigQuery ─────────────────────────────────────────────────────────────────

output "bigquery_dataset" {
  description = "BigQuery analytics dataset ID"
  value       = google_bigquery_dataset.vertex_analytics.dataset_id
}

# ─── Service Accounts ─────────────────────────────────────────────────────────

output "crm_service_account_email" {
  description = "CRM service service account email"
  value       = google_service_account.crm_service.email
}

output "marketing_service_account_email" {
  description = "Marketing Intelligence service account email"
  value       = google_service_account.marketing_intelligence.email
}

output "ai_agent_service_account_email" {
  description = "AI Sales Agent service account email"
  value       = google_service_account.ai_sales_agent.email
}
