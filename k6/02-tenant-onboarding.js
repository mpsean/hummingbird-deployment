/**
 * Scenario 2 — New Tenant Onboarding
 *
 * Simulates parallel provisioning of new hotel tenants via the admin API.
 * Schema initialisation is synchronous — the API creates the tenant DB on
 * registration; there is no separate initialise or bulk-insert endpoint.
 *
 * Shape  : 50 VUs constant for 5 minutes
 * SLA    : p95 < 1 000 ms, error rate < 1 %
 *
 * Run:
 *   k6 run k6/02-tenant-onboarding.js
 *   k6 run -e ADMIN_KEY=hb-admin-dev-key k6/02-tenant-onboarding.js
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';
import { API_ADMIN_KEY } from './lib/auth.js';

const errorRate    = new Rate('onboarding_errors');
const provisionDur = new Trend('onboarding_provision_duration', true);

const API_BASE = __ENV.API_URL || 'http://api.hmmbird.xyz';

const ADMIN_HEADERS = {
  'Content-Type': 'application/json',
  'X-Admin-Key': API_ADMIN_KEY,
};

// Unique subdomain per VU + iteration to avoid conflicts
function tenantSubdomain() {
  return `load-hotel-${__VU}-${__ITER}`;
}

export const options = {
  scenarios: {
    tenant_onboarding: {
      executor: 'constant-vus',
      vus:      50,
      duration: '5m',
    },
  },
  thresholds: {
    'onboarding_provision_duration': ['p(95)<1000'],
    'onboarding_errors':             ['rate<0.01'],
    'http_req_failed':               ['rate<0.01'],
  },
  ext: {
    prometheusRW: {
      url: __ENV.PROMETHEUS_URL || 'http://prometheus.hmmbird.xyz/api/v1/write',
      flushPeriod: '5s',
      staleMarkers: true,
    },
  },
};

export default function () {
  const subdomain = tenantSubdomain();

  // Register tenant — API creates the tenant DB synchronously
  const registerRes = http.post(
    `${API_BASE}/api/admin/tenants`,
    JSON.stringify({ subdomain, name: `Load Hotel ${__VU}-${__ITER}` }),
    { headers: ADMIN_HEADERS }
  );

  const registered = check(registerRes, {
    'tenant registered 201': (r) => r.status === 201 || r.status === 200,
  });

  provisionDur.add(registerRes.timings.duration);
  errorRate.add(!registered);

  sleep(3);
}
