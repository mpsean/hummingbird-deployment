/**
 * Scenario 2 — New Tenant Onboarding
 *
 * Simulates parallel onboarding of up to five new hotel tenants via the
 * admin API: register tenant → initialise schema → bulk-insert employees.
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
const insertDur    = new Trend('onboarding_bulk_insert_duration', true);

const API_BASE = __ENV.API_URL || 'http://api.hmmbird.xyz';

const ADMIN_HEADERS = {
  'Content-Type': 'application/json',
  'X-Admin-Key': API_ADMIN_KEY,
};

// Generate a unique tenant slug per VU + iteration to avoid conflicts
function tenantSlug() {
  return `load-hotel-${__VU}-${__ITER}`;
}

// Build 3 000 synthetic employee records for bulk insert
function buildEmployees(count = 3000) {
  return Array.from({ length: count }, (_, i) => ({
    firstName:   `First${i}`,
    lastName:    `Last${i}`,
    email:       `emp${i}@load-test.internal`,
    position:    'Staff',
    department:  'Operations',
    hireDate:    '2024-01-01',
  }));
}

export const options = {
  scenarios: {
    tenant_onboarding: {
      executor:  'constant-vus',
      vus:       50,
      duration:  '5m',
    },
  },
  thresholds: {
    'onboarding_provision_duration':    ['p(95)<1000'],
    'onboarding_bulk_insert_duration':  ['p(95)<1000'],
    'onboarding_errors':                ['rate<0.01'],
    'http_req_failed':                  ['rate<0.01'],
  },
};

export default function () {
  const slug = tenantSlug();

  // Step 1 — Register tenant via admin API
  const registerRes = http.post(
    `${API_BASE}/api/admin/tenants`,
    JSON.stringify({ slug, name: `Load Hotel ${__VU}` }),
    { headers: ADMIN_HEADERS }
  );

  const registered = check(registerRes, {
    'tenant registered 201': (r) => r.status === 201 || r.status === 200,
  });

  provisionDur.add(registerRes.timings.duration);
  errorRate.add(!registered);

  if (!registered) {
    sleep(2);
    return;
  }

  // Step 2 — Trigger schema initialisation (may be synchronous or async)
  const schemaRes = http.post(
    `${API_BASE}/api/admin/tenants/${slug}/initialise`,
    null,
    { headers: ADMIN_HEADERS }
  );

  check(schemaRes, {
    'schema init 200/202': (r) => r.status === 200 || r.status === 202 || r.status === 204,
  });

  sleep(1); // allow async schema creation to settle

  // Step 3 — Bulk insert 3 000 employee records
  const employees = buildEmployees(3000);
  const insertRes = http.post(
    `${API_BASE}/api/admin/tenants/${slug}/employees/bulk`,
    JSON.stringify({ employees }),
    { headers: ADMIN_HEADERS }
  );

  const inserted = check(insertRes, {
    'bulk insert 200/202': (r) => r.status === 200 || r.status === 202,
  });

  insertDur.add(insertRes.timings.duration);
  errorRate.add(!inserted);

  sleep(3); // think time between onboarding cycles
}
