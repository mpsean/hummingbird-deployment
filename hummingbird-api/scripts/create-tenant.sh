#!/usr/bin/env bash
# Usage: ./create-tenant.sh <slug> <admin-key>
# Example: ./create-tenant.sh acme hb-admin-dev-key
set -euo pipefail

SLUG="${1:?Usage: $0 <slug> <admin-key>}"
ADMIN_KEY="${2:?Usage: $0 <slug> <admin-key>}"
API_BASE="${API_BASE:-http://localhost:5000}"
TEMPLATE_DIR="$(dirname "$0")/../tenant-template"

# 1. Register tenant in the API
echo "→ Registering tenant '$SLUG' in API..."
curl -sf -X POST "$API_BASE/api/admin/tenants" \
  -H "Content-Type: application/json" \
  -H "X-Admin-Key: $ADMIN_KEY" \
  -d "{\"slug\": \"$SLUG\"}"
echo ""

# 2. Apply Kubernetes resources from template
echo "→ Creating Kubernetes namespace and frontend for tenant '$SLUG'..."
for file in namespace.yaml frontend.yaml ingress.yaml; do
  sed "s/TENANT_SLUG/$SLUG/g" "$TEMPLATE_DIR/$file" | kubectl apply -f -
done

echo ""
echo "✓ Tenant '$SLUG' is ready at http://$SLUG.hmmbird.xyz"
