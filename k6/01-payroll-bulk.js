/**
 * Scenario 1 — Bulk Month-End Payroll Processing
 *
 * Simulates HR administrators across all five tenants simultaneously
 * initiating bulk payroll runs at month-end.
 *
 * Shape  : ramp 2 000 → 10 000 VUs over 2 min, hold 5 min, ramp down 2 min
 * SLA    : p95 < 500 ms, error rate < 1 %
 *
 * Run:
 *   k6 run k6/01-payroll-bulk.js
 *   k6 run -e SIGNIN_URL=http://signin.hmmbird.xyz k6/01-payroll-bulk.js
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';
import { loginTenant, tenantApiBase, tenantHeaders } from './lib/auth.js';

const errorRate = new Rate('payroll_errors');
const payrollDuration = new Trend('payroll_bulk_duration', true);

// Five hotel tenants matching live data
const TENANTS = [
  { slug: 'hotel-a', username: 'hr_admin', password: 'admin123' },
  { slug: 'acme',    username: 'hr_admin', password: 'admin123' },
  { slug: 'maipro',  username: 'hr_admin', password: 'admin123' },
  { slug: 'hotel-d', username: 'hr_admin', password: 'admin123' },
  { slug: 'hotel-e', username: 'hr_admin', password: 'admin123' },
];

// Generate 100 sequential employee IDs per VU
function employeeIds(start, count = 100) {
  return Array.from({ length: count }, (_, i) => start + i);
}

export const options = {
  scenarios: {
    bulk_payroll: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '2m',   target: 2000  }, // ramp to initial load
        { duration: '30s',  target: 10000 }, // spike to peak
        { duration: '5m',   target: 10000 }, // hold peak
        { duration: '2m',   target: 0     }, // ramp down
      ],
    },
  },
  thresholds: {
    'payroll_bulk_duration': ['p(95)<500'],
    'payroll_errors':        ['rate<0.01'],
    'http_req_failed':       ['rate<0.01'],
  },
};

export function setup() {
  // Obtain one token per tenant before the test begins
  const tokens = {};
  for (const t of TENANTS) {
    tokens[t.slug] = loginTenant(t.slug, t.username, t.password);
  }
  return tokens;
}

export default function (tokens) {
  // Round-robin across tenants so load is spread evenly
  const tenant = TENANTS[__VU % TENANTS.length];
  const token = tokens[tenant.slug];
  if (!token) return;

  const base = tenantApiBase(tenant.slug);
  const headers = tenantHeaders(tenant.slug, token);

  // Each VU submits payroll for 100 employees
  const idStart = (__VU * 100) % 10000;
  const payload = JSON.stringify({ employeeIds: employeeIds(idStart) });

  const res = http.post(`${base}/api/v1/payroll/bulk`, payload, { headers });

  const ok = check(res, {
    'payroll bulk 200': (r) => r.status === 200 || r.status === 202,
  });

  payrollDuration.add(res.timings.duration);
  errorRate.add(!ok);

  sleep(Math.random() * 2 + 1); // 1–3 s think time between runs
}
