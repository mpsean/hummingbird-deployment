#!/usr/bin/env bash
# Run any k6 scenario with automatic Prometheus remote write output.
#
# Usage:
#   ./k6/run.sh k6/01-payroll-bulk.js
#   ./k6/run.sh k6/03-seasonal-staff.js -e SIGNIN_URL=http://signin.hmmbird.xyz
#   PROMETHEUS_URL=http://prometheus.monitoring.svc:9090/api/v1/write ./k6/run.sh k6/00-regular-load.js
#
# The default PROMETHEUS_URL targets the public Grafana ingress.
# Override with the in-cluster service address when running from inside the cluster.

set -euo pipefail

if [[ $# -eq 0 ]]; then
  echo "Usage: $0 <k6-script> [k6-options...]"
  exit 1
fi

export K6_PROMETHEUS_RW_SERVER_URL="${PROMETHEUS_URL:-http://prometheus.hmmbird.xyz/api/v1/write}"

# Export p50, p90, p95, p99 for all Trend metrics so the Grafana dashboard
# can show meaningful quantile data.
export K6_PROMETHEUS_RW_TREND_STATS="avg,p(50),p(90),p(95),p(99)"

# Send stale markers when the test ends so Grafana panels show a clean gap
# between runs rather than flat-lining at the last value.
export K6_PROMETHEUS_RW_STALE_MARKERS="true"

exec k6 run --out experimental-prometheus-rw "$@"
