provider "aws" {
  region                      = "us-east-1"
  access_key                  = "mock"
  secret_key                  = "mock"
  skip_credentials_validation = true
  skip_requesting_account_id  = true
  skip_metadata_api_check     = true
}

# "Saves money" by disabling encryption (no KMS) — builds fine, but checkov's
# CKV_AWS_3 (EBS encryption) now FAILS. The compliance oracle must reject this.
resource "aws_ebs_volume" "data" {
  availability_zone = "us-east-1a"
  size              = 200
  type              = "gp3"
  encrypted         = false
  tags = {
    Name = "data"
  }
}
