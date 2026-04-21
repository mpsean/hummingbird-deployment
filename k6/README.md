# Hummingbird k6 Load Tests

## Prerequisites
- [k6](https://k6.io/docs/getting-started/installation/) installed
- Access to `signin.hmmbird.xyz` and `api.hmmbird.xyz` (or SSH tunnel on port 80)

## Scenarios

| File | Scenario | Peak VUs | SLA |
|------|----------|----------|-----|
| `01-payroll-bulk.js` | Bulk Month-End Payroll | 10 000 | p95 < 500 ms, errors < 1% |
| `02-tenant-onboarding.js` | New Tenant Onboarding | 50 | p95 < 1 000 ms, errors < 1% |
| `03-seasonal-staff.js` | Seasonal Staff Onboard/Offboard | 10 000 | p95 < 400 ms, errors < 1% |

## Running

```bash
# Single scenario
k6 run k6/01-payroll-bulk.js

# With Grafana Cloud output
k6 run --out cloud k6/01-payroll-bulk.js

# With custom env vars (e.g. SSH tunnel on port 80)
k6 run \
  -e SIGNIN_URL=http://localhost:80 \
  -e API_URL=http://localhost:80 \
  k6/02-tenant-onboarding.js
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `SIGNIN_URL` | `http://signin.hmmbird.xyz` | Signin service base URL |
| `API_URL` | `http://api.hmmbird.xyz` | Admin API base URL |
| `ADMIN_KEY` | `hb-admin-dev-key` | `X-Admin-Key` header value |
| `API_IP` | *(unset)* | Override IP for tenant API (skips DNS; uses subdomain as Host header) |

## Notes

- Tenant API endpoints require subdomain-based routing (`hotel-a.hmmbird.xyz/api/v1/...`).  
  Ensure DNS records or `/etc/hosts` entries exist for each tenant slug before running scenarios 1 and 3.
- Scenario 2 creates and destroys tenants each iteration — run against a staging environment only.
