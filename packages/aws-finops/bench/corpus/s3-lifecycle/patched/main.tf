provider "aws" {
  region                      = "us-east-1"
  access_key                  = "mock"
  secret_key                  = "mock"
  skip_credentials_validation = true
  skip_requesting_account_id  = true
  skip_metadata_api_check     = true
}

resource "aws_s3_bucket" "logs" {
  bucket = "app-logs-bucket-example"
}

resource "aws_s3_bucket_versioning" "logs" {
  bucket = aws_s3_bucket.logs.id
  versioning_configuration {
    status = "Enabled"
  }
}

# Genuine saving: expire/transition old log objects so storage doesn't grow forever.
# Build-safe and adds no new compliance failures.
resource "aws_s3_bucket_lifecycle_configuration" "logs" {
  bucket = aws_s3_bucket.logs.id
  rule {
    id     = "expire-old-logs"
    status = "Enabled"
    filter {
      prefix = ""
    }
    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
    transition {
      days          = 30
      storage_class = "STANDARD_IA"
    }
    expiration {
      days = 365
    }
  }
}
