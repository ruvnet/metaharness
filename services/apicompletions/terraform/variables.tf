variable "project_id" {
  type        = string
  description = "GCP project — Cognitum production (ADR-203 §7.1)."
  default     = "cognitum-20260110"
}

variable "region" {
  type        = string
  description = "Deploy region."
  default     = "us-central1"
}

variable "image" {
  type        = string
  description = "Container image for the apicompletions Cloud Run service."
  default     = ""
}
