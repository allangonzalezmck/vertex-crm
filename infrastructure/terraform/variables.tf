/**
 * @file infrastructure/terraform/variables.tf
 */

variable "project_id" {
  type        = string
  description = "GCP project ID"
}

variable "region" {
  type        = string
  description = "GCP region for all resources"
  default     = "us-central1"
}

variable "db_tier" {
  type        = string
  description = "Cloud SQL machine type"
  default     = "db-n1-standard-2"
}

variable "image_tag" {
  type        = string
  description = "Docker image tag to deploy (set by CI/CD)"
  default     = "latest"
}

variable "alert_email" {
  type        = string
  description = "Email for alerting/monitoring notifications"
}
