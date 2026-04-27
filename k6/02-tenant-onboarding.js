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

/* global __VU, __ITER */

const errorRate    = new Rate('onboarding_errors');
const provisionDur = new Trend('onboarding_provision_duration', true);

const API_BASE = __ENV.API_URL || 'http://api.hmmbird.xyz';

const ADMIN_HEADERS = {
  'Content-Type': 'application/json',
  'X-Admin-Key': API_ADMIN_KEY,
};

// RUN_ID is generated in setup() so it is consistent across all VU isolates
// and available to teardown() for targeted cleanup.
function tenantSubdomain(runId) {
  return `t${runId}-${__VU}-${__ITER}`;
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
    // Infrastructure focus: k8s resource provisioning completes.
    // t3.xlarge postgres (4 vCPU) runs DDL 3-4× faster than t3.medium — 5 s is achievable.
    'onboarding_provision_duration': ['p(95)<5000'],
    'onboarding_errors':             ['rate<0.05'],
    'http_req_failed':               ['rate<0.05'],
  },
  ext: {
    prometheusRW: {
      url: __ENV.PROMETHEUS_URL || 'http://prometheus.hmmbird.xyz/api/v1/write',
      flushPeriod: '5s',
      staleMarkers: true,
    },
  },
};

export function setup() {
  const runId = Date.now().toString(36).slice(-5);
  console.log(`[setup] Run ID: ${runId} — tenants will be prefixed with t${runId}-`);
  return { runId };
}

export default function (data) {
  const subdomain = tenantSubdomain(data.runId);

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

export function teardown(data) {
  const { runId } = data;
  console.log(`[teardown] Cleaning up tenants created with prefix t${runId}-`);

  // List all tenants and filter to this run's subdomains
  const listRes = http.get(`${API_BASE}/api/admin/tenants`, { headers: ADMIN_HEADERS });
  if (listRes.status !== 200) {
    console.error(`[teardown] Failed to list tenants (${listRes.status}) — manual cleanup may be required`);
    return;
  }

  const all = JSON.parse(listRes.body);
  const mine = all.filter((t) => t.subdomain.startsWith(`t${runId}-`));
  console.log(`[teardown] Found ${mine.length} tenants to delete`);

  let deleted = 0;
  let failed = 0;
  for (const tenant of mine) {
    const delRes = http.del(
      `${API_BASE}/api/admin/tenants/${tenant.id}`,
      null,
      { headers: ADMIN_HEADERS }
    );
    if (delRes.status === 200 || delRes.status === 204 || delRes.status === 404) {
      deleted++;
    } else {
      console.warn(`[teardown] Could not delete ${tenant.subdomain} (id=${tenant.id}): HTTP ${delRes.status}`);
      failed++;
    }
  }
  console.log(`[teardown] Done — deleted ${deleted}, failed ${failed}`);
}
