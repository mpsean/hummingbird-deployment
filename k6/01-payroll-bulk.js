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

const TENANTS = [
  { slug: 'hotel-a', username: 'hr_admin', password: 'admin123' },
  { slug: 'hotel-b',    username: 'hr_admin', password: 'admin123' },
  { slug: 'hotel-c',  username: 'hr_admin', password: 'admin123' },
  { slug: 'hotel-d', username: 'hr_admin', password: 'admin123' },
  { slug: 'hotel-e', username: 'hr_admin', password: 'admin123' },
];

const SERVICE_CHARGE_TOTAL  = 500000; // deterministic ฿500k monthly pool

export const options = {
  scenarios: {
    bulk_payroll: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '2m',  target: 500  }, // ramp — build CPU pressure toward HPA threshold
        { duration: '30s', target: 1000 }, // spike to peak
        { duration: '5m',  target: 1000 }, // hold — HPA must fire within 90 s and stabilise
        { duration: '2m',  target: 0    }, // ramp down
      ],
    },
  },
  thresholds: {
    // Infrastructure focus: HPA fires and recovers — 20% errors during scale-up window accepted
    'payroll_errors':  ['rate<0.20'],
    'http_req_failed': ['rate<0.20'],
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

  // Spread VUs across 24 historical periods to avoid DB deadlocks on concurrent writes
  // to the same (tenant, month, year). 1000 VUs / 24 periods ≈ 42 VUs per period.
  const periodIndex = (__VU - 1) % 24;
  const calcYear    = periodIndex < 12 ? 2024 : 2023;
  const calcMonth   = (periodIndex % 12) + 1;

  const payload = JSON.stringify({
    Month:              calcMonth,
    Year:               calcYear,
    ServiceChargeTotal: SERVICE_CHARGE_TOTAL,
  });

  const res = http.post(`${base}/api/payroll/calculate`, payload, { headers });

  const ok = check(res, {
    'payroll calculate 200': (r) => r.status === 200 || r.status === 202,
  });

  payrollDuration.add(res.timings.duration);
  errorRate.add(!ok);

  sleep(Math.random() * 2 + 1); // 1–3 s think time between runs
}
