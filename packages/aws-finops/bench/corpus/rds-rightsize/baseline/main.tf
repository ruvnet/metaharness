provider "aws" {
  region                      = "us-east-1"
  access_key                  = "mock"
  secret_key                  = "mock"
  skip_credentials_validation = true
  skip_requesting_account_id  = true
  skip_metadata_api_check     = true
}

resource "aws_db_instance" "main" {
  identifier              = "app-db"
  allocated_storage       = 100
  engine                  = "postgres"
  instance_class          = "db.m5.2xlarge"
  username                = "appuser"
  password                = "change-me-via-secrets-manager"
  storage_encrypted       = true
  backup_retention_period = 7
  skip_final_snapshot     = true
}
