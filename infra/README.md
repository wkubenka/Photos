# AWS setup runbook

This runbook builds the one bucket and one CloudFront distribution the photo
gallery runs on. There is no other infrastructure: no website endpoint, no
CORS configuration, no second bucket. The bucket blocks all public access
end to end; CloudFront reaches it only through an Origin Access Control
(OAC), and only that one distribution is allowed to read from it.

Run every step below once, by hand, in order. Nothing here is covered by an
automated test — `photos verify` (a later CLI command) checks that these
resources exist and are configured correctly, but nothing can create them
for you. Read each "Check" before moving to the next step; skipping the
checks is how you end up with either a broken site or a publicly listable
bucket, and the two failure modes look identical until you specifically go
looking for them.

## Prerequisites

- AWS CLI v2, configured with a profile that has permission to create S3
  buckets, ACM certificates, CloudFront distributions/policies, and IAM
  policies. This can be an administrator profile for the one-time setup in
  this document — it does not have to be the restricted profile the CLI
  uses day to day (that one is created in Step 7, below).
- A domain name you control the DNS for.
- `jq` is not required; every command below uses `aws ... --query` for
  parsing instead, so the only extra tool is the AWS CLI itself.

Throughout, replace these with your own values. They map directly to the
fields in `photos.config.json`:

```bash
BUCKET="photos.example.com"     # photos.config.json: bucket
DOMAIN="photos.example.com"     # the hostname in photos.config.json: siteUrl
PROFILE="photos-admin"          # an admin-capable profile for this setup session
REGION="us-east-1"              # photos.config.json: region — CloudFront/ACM require us-east-1 for the cert
```

## Step 0: Run the bootstrap script

```bash
infra/bootstrap.sh "$BUCKET" "$DOMAIN" "$PROFILE"
```

This creates the bucket, blocks all public access on it, turns on
versioning, adds the 90-day noncurrent-version lifecycle rule, requests the
ACM certificate, and creates the Origin Access Control. It prints the
certificate ARN and the OAC id — copy both; you need them for the rest of
this runbook.

```bash
CERT_ARN="<printed by bootstrap.sh>"
OAC_ID="<printed by bootstrap.sh>"
```

**Check:**

```bash
aws s3api get-bucket-versioning --bucket "$BUCKET" --profile "$PROFILE"
# → { "Status": "Enabled" }

aws s3api get-public-access-block --bucket "$BUCKET" --profile "$PROFILE"
# → all four settings true

aws s3api get-bucket-lifecycle-configuration --bucket "$BUCKET" --profile "$PROFILE"
# → one rule, "NoncurrentVersionExpiration": { "NoncurrentDays": 90 }
```

Do not skip ahead until the bucket has all three of these. Everything else
in this runbook assumes they're already true.

## Step 1: Wait for the certificate to be issued

```bash
aws acm describe-certificate --certificate-arn "$CERT_ARN" \
  --profile "$PROFILE" --region "$REGION" \
  --query 'Certificate.[Status,DomainValidationOptions[0].ResourceRecord]'
```

Create the CNAME record the output shows, at whatever DNS provider hosts
`$DOMAIN`. Re-run the command above until `Status` reads `ISSUED` — this is
usually a few minutes, but can take longer depending on your DNS provider's
propagation time. Do not proceed to Step 5 (distribution creation) until it
does; `create-distribution` will reject a certificate that isn't issued yet.

## Step 2: Create the two cache policies

These set how long CloudFront's edge caches hold an object, independent of
what any browser does. The CLI's upload command (a later task) sets the
matching `Cache-Control` header on each S3 object directly — that's what
controls the browser's own cache and is the header a client actually sees.
The two numbers are deliberately the same in both places so there's one
fact ("originals and assets are immutable; manifests and the page are not")
instead of two that could drift apart.

Immutable policy, for `assets/*`, `web/*`, `orig/*`:

```bash
IMMUTABLE_CACHE_POLICY_ID=$(aws cloudfront create-cache-policy \
  --profile "$PROFILE" \
  --cache-policy-config '{
    "Name": "photos-immutable",
    "Comment": "assets/*, web/*, orig/* — content-addressed, never changes",
    "DefaultTTL": 31536000,
    "MaxTTL": 31536000,
    "MinTTL": 31536000,
    "ParametersInCacheKeyAndForwardedToOrigin": {
      "EnableAcceptEncodingGzip": true,
      "EnableAcceptEncodingBrotli": true,
      "HeadersConfig": { "HeaderBehavior": "none" },
      "CookiesConfig": { "CookieBehavior": "none" },
      "QueryStringsConfig": { "QueryStringBehavior": "none" }
    }
  }' \
  --query 'CachePolicy.Id' --output text)
echo "$IMMUTABLE_CACHE_POLICY_ID"
```

Short policy, for `data/*.json` and `index.html`:

```bash
SHORT_CACHE_POLICY_ID=$(aws cloudfront create-cache-policy \
  --profile "$PROFILE" \
  --cache-policy-config '{
    "Name": "photos-short",
    "Comment": "data/*.json, index.html — content that changes on every publish",
    "DefaultTTL": 60,
    "MaxTTL": 60,
    "MinTTL": 60,
    "ParametersInCacheKeyAndForwardedToOrigin": {
      "EnableAcceptEncodingGzip": true,
      "EnableAcceptEncodingBrotli": true,
      "HeadersConfig": { "HeaderBehavior": "none" },
      "CookiesConfig": { "CookieBehavior": "none" },
      "QueryStringsConfig": { "QueryStringBehavior": "none" }
    }
  }' \
  --query 'CachePolicy.Id' --output text)
echo "$SHORT_CACHE_POLICY_ID"
```

**Check:** both commands print a policy id (a UUID). List them back with
`aws cloudfront list-cache-policies --type custom --profile "$PROFILE"` and
confirm the `DefaultTTL`/`MinTTL`/`MaxTTL` values match what you intended —
a typo here silently changes how long stale content can survive at the
edge.

## Step 3: Create the two response headers policies

CloudFront attaches one response headers policy per cache behavior, so
covering "every response gets `X-Robots-Tag`, only HTML gets the CSP"
takes two policies: a plain one (headers-only) attached to the asset and
data behaviors, and a second one (headers plus CSP) attached to the default
behavior, which is what serves `index.html`. (A CSP header on a JSON or
image response is harmless — browsers only enforce Content-Security-Policy
on documents — but only the HTML behavior actually needs it, so only that
one gets it.)

Headers-only policy, for `assets/*`, `web/*`, `orig/*`, `data/*.json`:

```bash
ASSET_HEADERS_POLICY_ID=$(aws cloudfront create-response-headers-policy \
  --profile "$PROFILE" \
  --response-headers-policy-config '{
    "Name": "photos-asset-headers",
    "Comment": "X-Robots-Tag on non-HTML responses",
    "CustomHeadersConfig": {
      "Quantity": 1,
      "Items": [
        { "Header": "X-Robots-Tag", "Value": "noai, noimageai", "Override": true }
      ]
    }
  }' \
  --query 'ResponseHeadersPolicy.Id' --output text)
echo "$ASSET_HEADERS_POLICY_ID"
```

HTML policy (headers plus CSP), for the default behavior / `index.html`:

```bash
HTML_HEADERS_POLICY_ID=$(aws cloudfront create-response-headers-policy \
  --profile "$PROFILE" \
  --response-headers-policy-config '{
    "Name": "photos-html-headers",
    "Comment": "X-Robots-Tag plus CSP on the HTML page",
    "CustomHeadersConfig": {
      "Quantity": 1,
      "Items": [
        { "Header": "X-Robots-Tag", "Value": "noai, noimageai", "Override": true }
      ]
    },
    "SecurityHeadersConfig": {
      "ContentSecurityPolicy": {
        "Override": true,
        "ContentSecurityPolicy": "default-src '\''self'\''; script-src '\''self'\'' '\''wasm-unsafe-eval'\''; img-src '\''self'\'' data: blob:; connect-src '\''self'\''; style-src '\''self'\''; object-src '\''none'\''; base-uri '\''none'\''; frame-ancestors '\''none'\''"
      }
    }
  }' \
  --query 'ResponseHeadersPolicy.Id' --output text)
echo "$HTML_HEADERS_POLICY_ID"
```

`script-src` includes `'wasm-unsafe-eval'` because the password-unlock flow
runs Argon2id as WebAssembly in the browser; without it the page would
throw a CSP violation the moment it tries to derive the key.

**Check:**

```bash
aws cloudfront get-response-headers-policy --id "$HTML_HEADERS_POLICY_ID" \
  --profile "$PROFILE" \
  --query 'ResponseHeadersPolicy.ResponseHeadersPolicyConfig.SecurityHeadersConfig.ContentSecurityPolicy.ContentSecurityPolicy' \
  --output text
```

Compare the output character-for-character against the CSP string above —
the single quotes inside the policy (around `self`, `wasm-unsafe-eval`,
`none`) are part of the CSP syntax itself and are easy to lose or mangle
when passing the JSON through a shell.

## Step 4: Create the distribution

This is the step where getting the OAC wiring wrong either breaks the site
or reopens the bucket, so read the whole step before running anything.

The origin must point at the bucket's regular (REST) S3 endpoint —
`$BUCKET.s3.$REGION.amazonaws.com` — never at an S3 *website* endpoint.
Website endpoints only serve HTTP, don't support OAC signing, and require
the bucket to be public to work at all. If you ever see one in a
distribution's origin, the bucket behind it has to be public, which is
exactly what this setup avoids.

```bash
ACCOUNT_ID=$(aws sts get-caller-identity --profile "$PROFILE" --query Account --output text)

cat > /tmp/distribution-config.json <<EOF
{
  "CallerReference": "${BUCKET}-$(date +%s)",
  "Comment": "Photo gallery — ${DOMAIN}",
  "Enabled": true,
  "HttpVersion": "http2and3",
  "IsIPV6Enabled": true,
  "DefaultRootObject": "index.html",
  "Aliases": { "Quantity": 1, "Items": ["${DOMAIN}"] },
  "Origins": {
    "Quantity": 1,
    "Items": [
      {
        "Id": "s3-${BUCKET}",
        "DomainName": "${BUCKET}.s3.${REGION}.amazonaws.com",
        "OriginAccessControlId": "${OAC_ID}",
        "S3OriginConfig": { "OriginAccessIdentity": "" }
      }
    ]
  },
  "DefaultCacheBehavior": {
    "TargetOriginId": "s3-${BUCKET}",
    "ViewerProtocolPolicy": "redirect-to-https",
    "Compress": true,
    "CachePolicyId": "${SHORT_CACHE_POLICY_ID}",
    "ResponseHeadersPolicyId": "${HTML_HEADERS_POLICY_ID}"
  },
  "CacheBehaviors": {
    "Quantity": 4,
    "Items": [
      {
        "PathPattern": "assets/*",
        "TargetOriginId": "s3-${BUCKET}",
        "ViewerProtocolPolicy": "redirect-to-https",
        "Compress": true,
        "CachePolicyId": "${IMMUTABLE_CACHE_POLICY_ID}",
        "ResponseHeadersPolicyId": "${ASSET_HEADERS_POLICY_ID}"
      },
      {
        "PathPattern": "web/*",
        "TargetOriginId": "s3-${BUCKET}",
        "ViewerProtocolPolicy": "redirect-to-https",
        "Compress": true,
        "CachePolicyId": "${IMMUTABLE_CACHE_POLICY_ID}",
        "ResponseHeadersPolicyId": "${ASSET_HEADERS_POLICY_ID}"
      },
      {
        "PathPattern": "orig/*",
        "TargetOriginId": "s3-${BUCKET}",
        "ViewerProtocolPolicy": "redirect-to-https",
        "Compress": false,
        "CachePolicyId": "${IMMUTABLE_CACHE_POLICY_ID}",
        "ResponseHeadersPolicyId": "${ASSET_HEADERS_POLICY_ID}"
      },
      {
        "PathPattern": "data/*.json",
        "TargetOriginId": "s3-${BUCKET}",
        "ViewerProtocolPolicy": "redirect-to-https",
        "Compress": true,
        "CachePolicyId": "${SHORT_CACHE_POLICY_ID}",
        "ResponseHeadersPolicyId": "${ASSET_HEADERS_POLICY_ID}"
      }
    ]
  },
  "ViewerCertificate": {
    "ACMCertificateArn": "${CERT_ARN}",
    "SSLSupportMethod": "sni-only",
    "MinimumProtocolVersion": "TLSv1.2_2021"
  },
  "PriceClass": "PriceClass_100"
}
EOF
```

(`orig/*` sets `Compress: false` — the originals are AES-GCM ciphertext,
which is already indistinguishable from random bytes, so CloudFront would
burn CPU trying to compress it for no benefit.)

```bash
DIST_ID=$(aws cloudfront create-distribution \
  --distribution-config file:///tmp/distribution-config.json \
  --profile "$PROFILE" \
  --query 'Distribution.Id' --output text)
DIST_ARN="arn:aws:cloudfront::${ACCOUNT_ID}:distribution/${DIST_ID}"
CF_DOMAIN=$(aws cloudfront get-distribution --id "$DIST_ID" --profile "$PROFILE" \
  --query 'Distribution.DomainName' --output text)
echo "$DIST_ID  $DIST_ARN  $CF_DOMAIN"
```

Deployment takes 10-20 minutes. Wait for it before testing:

```bash
aws cloudfront wait distribution-deployed --id "$DIST_ID" --profile "$PROFILE"
```

**Check:**

```bash
aws cloudfront get-distribution --id "$DIST_ID" --profile "$PROFILE" \
  --query 'Distribution.[Status,DistributionConfig.Origins.Items[0].OriginAccessControlId]'
# → [ "Deployed", "<the OAC_ID from Step 0>" ]
```

If `OriginAccessControlId` is empty or missing, the distribution is reading
the origin some other way (or not at all) — re-check `Origins.Items[0]`
against the JSON above.

## Step 5: Point DNS at the distribution

At whatever provider hosts `$DOMAIN`, create a CNAME (or, on Route 53, an
ALIAS record, which also works for a bare apex domain) for `$DOMAIN`
pointing at `$CF_DOMAIN` (the `*.cloudfront.net` name printed in Step 4). On
Route 53:

```bash
HOSTED_ZONE_ID="<your hosted zone id>"
aws route53 change-resource-record-sets --profile "$PROFILE" \
  --hosted-zone-id "$HOSTED_ZONE_ID" \
  --change-batch '{
    "Changes": [{
      "Action": "UPSERT",
      "ResourceRecordSet": {
        "Name": "'"$DOMAIN"'",
        "Type": "A",
        "AliasTarget": {
          "HostedZoneId": "Z2FDTNDATAQYW2",
          "DNSName": "'"$CF_DOMAIN"'",
          "EvaluateTargetHealth": false
        }
      }
    }]
  }'
```

(`Z2FDTNDATAQYW2` is CloudFront's fixed hosted-zone id for alias records —
it is the same for every account and every distribution.) With a
non-Route-53 provider, use their dashboard to add a CNAME from `$DOMAIN` to
`$CF_DOMAIN` instead.

**Check:** `dig +short $DOMAIN` eventually resolves to CloudFront edge IPs
(or, for a CNAME setup, resolves through to `$CF_DOMAIN`).

## Step 6: Restrict the bucket to this distribution only

Nothing has granted CloudFront permission to actually read from the bucket
yet — the OAC identifies the distribution to S3, but S3 still needs a
bucket policy saying that identity may read. Until this step runs, the
distribution returns 403 on every request even though everything else
above is correct.

```bash
cat > /tmp/bucket-policy.json <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AllowCloudFrontServicePrincipalReadOnly",
      "Effect": "Allow",
      "Principal": { "Service": "cloudfront.amazonaws.com" },
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::${BUCKET}/*",
      "Condition": {
        "StringEquals": { "AWS:SourceArn": "${DIST_ARN}" }
      }
    }
  ]
}
EOF

aws s3api put-bucket-policy --bucket "$BUCKET" --policy file:///tmp/bucket-policy.json \
  --profile "$PROFILE"
```

The `Condition` is what scopes this to *this* distribution specifically —
without it, any CloudFront distribution in any AWS account could read the
bucket, which defeats the point of using an OAC at all.

**Check — this is the one that catches both failure modes at once:**

```bash
# 1. The bucket itself is still not publicly readable directly:
curl -sI "https://${BUCKET}.s3.${REGION}.amazonaws.com/index.html" | head -1
# → HTTP/1.1 403 Forbidden (this is correct and expected)

# 2. The distribution CAN reach it, once something has been uploaded to
#    orig/, web/, assets/, data/, and index.html (a later task's job —
#    upload a throwaway index.html now if you want to test end to end):
curl -sI "https://${DOMAIN}/index.html" | head -1
# → HTTP/1.1 200 OK
```

If (1) returns anything other than 403, stop and fix the public access
block from Step 0 before going further — the bucket is public. If (2)
returns 403, the bucket policy's `Resource` or `Condition` doesn't match
this bucket/distribution pair; re-check `$BUCKET` and `$DIST_ARN`.

## Step 7: Create the IAM policy for the CLI

This is the least-privilege policy the day-to-day `photos` CLI profile
runs under — separate from the admin profile used for the setup steps
above. It grants exactly the S3 object/version operations the CLI needs on
this bucket, listing on this bucket, and cache invalidation on this
distribution. Nothing is scoped to `*`.

```bash
cat > /tmp/photos-cli-policy.json <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "PhotosCliObjects",
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:PutObject",
        "s3:DeleteObject",
        "s3:GetObjectVersion"
      ],
      "Resource": "arn:aws:s3:::${BUCKET}/*"
    },
    {
      "Sid": "PhotosCliBucket",
      "Effect": "Allow",
      "Action": [
        "s3:ListBucket",
        "s3:ListBucketVersions"
      ],
      "Resource": "arn:aws:s3:::${BUCKET}"
    },
    {
      "Sid": "PhotosCliInvalidate",
      "Effect": "Allow",
      "Action": "cloudfront:CreateInvalidation",
      "Resource": "${DIST_ARN}"
    }
  ]
}
EOF

POLICY_ARN=$(aws iam create-policy --policy-name photos-cli \
  --policy-document file:///tmp/photos-cli-policy.json \
  --profile "$PROFILE" --query 'Policy.Arn' --output text)
echo "$POLICY_ARN"
```

Create the IAM user the CLI authenticates as (if it doesn't already exist),
attach the policy, and generate an access key for it:

```bash
aws iam create-user --user-name photos-cli --profile "$PROFILE"
aws iam attach-user-policy --user-name photos-cli --policy-arn "$POLICY_ARN" --profile "$PROFILE"
aws iam create-access-key --user-name photos-cli --profile "$PROFILE"
```

Take the `AccessKeyId`/`SecretAccessKey` from the last command's output and
configure the local profile that `photos.config.json`'s `profile` field
names:

```bash
aws configure --profile photos
# AWS Access Key ID: <from create-access-key>
# AWS Secret Access Key: <from create-access-key>
# Default region: us-east-1
```

**Check:**

```bash
aws s3api list-objects-v2 --bucket "$BUCKET" --profile photos
# → succeeds (empty list on a fresh bucket)

aws s3api list-objects-v2 --bucket some-other-bucket-you-own --profile photos
# → AccessDenied — confirms the policy is scoped to this bucket, not every bucket you own

aws cloudfront create-invalidation --distribution-id "$DIST_ID" --paths "/index.html" --profile photos
# → succeeds and prints an invalidation id
```

## Step 8: Record the distribution id

Edit `photos.config.json` and replace `REPLACE_AFTER_BOOTSTRAP` with the
real distribution id:

```json
{
  "distributionId": "E1234567890ABC"
}
```

`loadConfig` (in `cli/src/config.ts`) rejects an empty or missing
`distributionId`, so anything downstream that touches invalidations will
fail loudly and immediately if this step gets skipped, rather than failing
confusingly later.

## Backups

Bucket versioning (Step 0) protects against mistakes made through this same
AWS account — an overwritten manifest, an accidental delete, a bad
`photos publish` run. It does not protect against losing the account
itself, or against S3 having a very bad day in one region. Both are low
probability, but the cost of being wrong is losing the only copy of every
full-resolution original, so back up anyway.

Run this periodically (weekly is reasonable for a gallery that doesn't
change often) to a target outside this AWS account — a different cloud
provider, a different AWS account, or local/external disk all work:

```bash
aws s3 sync "s3://${BUCKET}/orig/" /path/to/backup/orig/ --profile photos
aws s3 sync "s3://${BUCKET}/data/" /path/to/backup/data/ --profile photos
```

Only `orig/` and `data/` need backing up — `web/` and `assets/` are
regenerable from `orig/` by re-running the publish pipeline, and
`index.html` is static and lives in the repo.

The objects under `orig/` are AES-GCM ciphertext; the plaintext originals
never touch S3. That's what makes copying them anywhere — a laptop, a
consumer cloud drive, a USB disk — unproblematic: the backup target doesn't
need to be trusted or access-controlled the way the bucket itself does. An
attacker who obtains the backup still needs the gallery password (run
through Argon2id) to decrypt anything in it.

## Summary checklist

- [ ] Bucket created, versioned, lifecycle rule set, all public access blocked (Step 0)
- [ ] Certificate `ISSUED` (Step 1)
- [ ] Two cache policies created: immutable (31536000/31536000/31536000) and short (60/60/60) (Step 2)
- [ ] Two response headers policies created: asset headers (X-Robots-Tag only) and HTML headers (X-Robots-Tag + CSP) (Step 3)
- [ ] Distribution created and `Deployed`, origin uses the OAC and the S3 REST endpoint, not a website endpoint (Step 4)
- [ ] DNS for the domain resolves to the distribution (Step 5)
- [ ] Bucket policy restricts reads to this distribution's ARN only; direct S3 access returns 403, distribution access returns 200 (Step 6)
- [ ] IAM policy `photos-cli` created, scoped to this bucket and this distribution, attached to the `photos-cli` user, local `photos` profile configured (Step 7)
- [ ] `distributionId` recorded in `photos.config.json` (Step 8)
- [ ] Backup target chosen and a first `aws s3 sync` run
