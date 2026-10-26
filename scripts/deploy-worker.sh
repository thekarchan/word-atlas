#!/usr/bin/env bash
# Deploy the private asset proxy and cut assets.hellokar.org over to it.
#
#   bash scripts/deploy-worker.sh --yes
#
# Order matters: the R2 custom domain must be released before the Worker can
# claim the hostname, otherwise wrangler fails with "hostname already in use".
# Between those two steps the hostname briefly serves nothing.
set -euo pipefail

cd "$(dirname "$0")/.."

CONFIG=worker/wrangler.jsonc
BUCKET=word-atlas-assets
HOST=assets.hellokar.org

if [ "${1:-}" != "--yes" ]; then
  cat <<EOF
This will:
  1. Remove the R2 custom domain ${HOST} from bucket ${BUCKET}
  2. Deploy Worker word-atlas-assets-proxy and bind ${HOST} to it
  3. Upload the ADMIN_TOKEN secret if it is missing

The bucket stays private; ${HOST} will only be reachable through the Worker.
There is a short gap (~seconds) where ${HOST} serves nothing.

Re-run with --yes to proceed.
EOF
  exit 1
fi

echo "==> 1/4 checking wrangler login"
npx --yes wrangler@4 whoami >/dev/null 2>&1 || { echo "not logged in: run 'npx wrangler login'"; exit 1; }

echo "==> 2/4 releasing ${HOST} from R2"
if npx --yes wrangler@4 r2 bucket domain list "$BUCKET" 2>/dev/null | grep -q "$HOST"; then
  npx --yes wrangler@4 r2 bucket domain remove "$BUCKET" --domain "$HOST" --zone-id 6956652c0556d2c810b637822a42080b
  echo "    released"
else
  echo "    not attached, skipping"
fi

echo "==> 3/4 deploying worker"
npx --yes wrangler@4 deploy --config "$CONFIG"

echo "==> 4/4 checking ADMIN_TOKEN"
if npx --yes wrangler@4 secret list --config "$CONFIG" 2>/dev/null | grep -q ADMIN_TOKEN; then
  echo "    already set"
else
  echo "    generating one"
  TOKEN=$(openssl rand -hex 24)
  printf '%s' "$TOKEN" | npx --yes wrangler@4 secret put ADMIN_TOKEN --config "$CONFIG"
  echo "    ADMIN_TOKEN=${TOKEN}"
  echo "    ^ save this now; it is not shown again"
fi

echo
echo "Verify:"
echo "  curl -sI https://${HOST}/illustrations/thumb/abandon.webp | head -5"
echo "  curl -s https://${HOST}/__usage -H \"Authorization: Bearer \$ADMIN_TOKEN\""
