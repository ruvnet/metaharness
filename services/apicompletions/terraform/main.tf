# Cognitum Fugu apicompletions — reviewable Terraform (ADR-203 §7.2).
# Extends the agentbbs-gcp/terraform/main.tf shape. REVIEWABLE CONFIG, DO NOT BLIND-APPLY:
# always `terraform plan` first (same rule as agentbbs-gcp and ADR-180).
#
# SKELETON — resource bodies are stubbed/commented. Fill in during rollout step 8.

terraform {
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = ">= 5.0"
    }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

# Enable the APIs the service needs (run / firestore / pubsub / cloudfunctions / cloudbuild / eventarc).
resource "google_project_service" "services" {
  for_each = toset([
    "run.googleapis.com",
    "firestore.googleapis.com",
    "pubsub.googleapis.com",
    "cloudfunctions.googleapis.com",
    "cloudbuild.googleapis.com",
    "eventarc.googleapis.com",
  ])
  service            = each.value
  disable_on_destroy = false
}

# The default Firestore DB ALREADY EXISTS in cognitum-20260110 — `terraform import`, do NOT create.
# import { id = "projects/${var.project_id}/databases/(default)", to = google_firestore_database.default }
# resource "google_firestore_database" "default" { ... }

# Pub/Sub topic + subscription feeding aggregateUsage (§5.1).
# resource "google_pubsub_topic" "completions_usage" { name = "completions-usage" ... }
# resource "google_pubsub_subscription" "completions_usage" { topic = ... }

# gen2 rollup function (§7.1).
# resource "google_cloudfunctions2_function" "aggregate_usage" { ... ALLOW_INTERNAL_ONLY ... }

# The Cloud Run completions service (§7.1): timeout=300s, concurrency=8, max-instances=20.
# resource "google_cloud_run_v2_service" "apicompletions" { ... }

# Least-privilege service account `apicompletions-sa` (§7.1):
# roles/datastore.user, roles/pubsub.publisher, roles/secretmanager.secretAccessor.
# resource "google_service_account" "apicompletions_sa" { ... }
