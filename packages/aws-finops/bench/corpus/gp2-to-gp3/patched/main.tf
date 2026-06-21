provider "aws" {
  region                      = "us-east-1"
  access_key                  = "mock"
  secret_key                  = "mock"
  skip_credentials_validation = true
  skip_requesting_account_id  = true
  skip_metadata_api_check     = true
}

resource "aws_ebs_volume" "data" {
  availability_zone = "us-east-1a"
  size              = 500
  type              = "gp3"
  encrypted         = true
  tags = {
    Name = "data"
  }
}
