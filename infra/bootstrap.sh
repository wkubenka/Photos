#!/usr/bin/env bash
# infra/bootstrap.sh — one-time AWS setup. Run once, then record the
# distribution id in photos.config.json.
set -euo pipefail

BUCKET="${1:?usage: bootstrap.sh <bucket> <domain> <profile>}"
DOMAIN="${2:?usage: bootstrap.sh <bucket> <domain> <profile>}"
PROFILE="${3:-photos}"
REGION="us-east-1"
AWS="aws --profile ${PROFILE} --region ${REGION}"

echo "==> Creating bucket ${BUCKET}"
$AWS s3api create-bucket --bucket "${BUCKET}"

echo "==> Blocking all public access"
$AWS s3api put-public-access-block --bucket "${BUCKET}" \
  --public-access-block-configuration \
  "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true"

echo "==> Enabling versioning (non-negotiable: S3 holds the only copy of originals)"
$AWS s3api put-bucket-versioning --bucket "${BUCKET}" \
  --versioning-configuration Status=Enabled

echo "==> Expiring noncurrent versions after 90 days"
$AWS s3api put-bucket-lifecycle-configuration --bucket "${BUCKET}" \
  --lifecycle-configuration '{
    "Rules": [{
      "ID": "expire-noncurrent",
      "Status": "Enabled",
      "Filter": {"Prefix": ""},
      "NoncurrentVersionExpiration": {"NoncurrentDays": 90}
    }]
  }'

echo "==> Requesting an ACM certificate for ${DOMAIN}"
CERT_ARN=$($AWS acm request-certificate --domain-name "${DOMAIN}" \
  --validation-method DNS --query CertificateArn --output text)
echo "    ${CERT_ARN}"
echo "    Add the DNS validation record shown by:"
echo "    aws acm describe-certificate --certificate-arn ${CERT_ARN} --profile ${PROFILE} --region ${REGION}"
echo "    Wait for status ISSUED before continuing."

echo "==> Creating the Origin Access Control"
OAC_ID=$($AWS cloudfront create-origin-access-control \
  --origin-access-control-config "Name=${BUCKET}-oac,OriginAccessControlOriginType=s3,SigningBehavior=always,SigningProtocol=sigv4" \
  --query OriginAccessControl.Id --output text)
echo "    ${OAC_ID}"

cat <<NOTE

==> Remaining manual steps, documented in infra/README.md:
    1. Wait for the certificate to reach ISSUED.
    2. Create the distribution with origin ${BUCKET}.s3.${REGION}.amazonaws.com,
       OAC ${OAC_ID}, certificate ${CERT_ARN}, default root object index.html.
    3. Attach the two cache policies and the response headers policy.
    4. Put the bucket policy allowing only that distribution to read.
    5. Create the IAM policy for the CLI.
    6. Record the distribution id in photos.config.json.
NOTE
