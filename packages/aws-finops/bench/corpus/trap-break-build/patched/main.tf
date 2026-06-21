provider "aws" {
  region                      = "us-east-1"
  access_key                  = "mock"
  secret_key                  = "mock"
  skip_credentials_validation = true
  skip_requesting_account_id  = true
  skip_metadata_api_check     = true
}

# "Saves money" by switching to a tiny type — but introduces a typo'd argument
# (`instance_typ`) that terraform validate rejects. The build oracle must catch this.
resource "aws_instance" "web" {
  ami          = "ami-0abcdef1234567890"
  instance_typ = "t3.micro"
  tags = {
    Name = "web"
  }
}
