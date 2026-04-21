/**
 * Scenario 0 — Ordinary Working Day (Steady-State Baseline)
 *
 * Validates that the system performs acceptably under routine traffic — the
 * precondition all other scenarios depend on. Uses a constant-arrival-rate
 * (open) model so request throughput is controlled independently of VU count,
 * matching how real users arrive at the system.
 *
 * Shape  : ramp 0 → 200 RPS over 5 min, hold 200 RPS for 20 min, ramp down 5 min
 * Rate   : 200 req/s across all five tenants (~40 req/s per tenant)
 * Basis  : ~50 concurrent active HR users per tenant, 1–2 requests/min each
 *
 * Traffic mix (weighted random per iteration):
 *   40 % — list employees          (most frequent browsing action)
 *   25 % — view single employee    (detail drill-down)
 *   20 % — payroll status query    (routine payroll module checks)
 *   15 % — attendance update       (lightweight write; mirrors daily clock-in records)
 *
 * Pass criteria:
 *   p95 < 300 ms, p99 < 600 ms, error rate < 0.5 %
 *
 * HPA note (verified externally):
 *   No HPA scaling event should fire during this run. The minimum 2-replica
 *   configuration must sustain 200 RPS without autoscaling, confirming the
 *   baseline replica count is correctly sized for normal traffic.
 *   Monitor with: kubectl get hpa -A -w
 *
 * Run:
 *   k6 run k6/00-regular-load.js
 *   k6 run -e SIGNIN_URL=http://signin.hmmbird.xyz k6/00-regular-load.js
 */

import http from 'k6/http';
import { check } from 'k6';
import { Rate, Trend } from 'k6/metrics';
import { loginTenant, tenantApiBase, tenantHeaders } from './lib/auth.js';

// Per-action duration trends for targeted SLO analysis
const listDuration       = new Trend('baseline_list_duration',       true);
const detailDuration     = new Trend('baseline_detail_duration',     true);
const payrollDuration    = new Trend('baseline_payroll_duration',    true);
const attendanceDuration = new Trend('baseline_attendance_duration', true);

// Count only server-side failures (5xx / connection errors); 4xx are expected
// for random employee IDs and are not application errors.
const errorRate = new Rate('baseline_errors');

const TENANTS = [
  { slug: 'hotel-a', username: 'hr_admin', password: 'admin123' },
  { slug: 'acme',    username: 'hr_admin', password: 'admin123' },
  { slug: 'maipro',  username: 'hr_admin', password: 'admin123' },
  { slug: 'hotel-d', username: 'hr_admin', password: 'admin123' },
  { slug: 'hotel-e', username: 'hr_admin', password: 'admin123' },
];

export const options = {
  scenarios: {
    ordinary_working_day: {
      executor:        'ramping-arrival-rate',
      startRate:       0,
      timeUnit:        '1s',
      // Little's Law at 200 RPS × 300 ms target latency = 60 VUs; 2× headroom
      preAllocatedVUs: 120,
      // Ceiling for unexpected latency spikes; k6 will warn if this is reached
      maxVUs:          400,
      stages: [
        { duration: '5m',  target: 200 }, // ramp up
        { duration: '20m', target: 200 }, // steady state
        { duration: '5m',  target: 0   }, // ramp down
      ],
    },
  },
  thresholds: {
    'baseline_list_duration':       ['p(95)<300', 'p(99)<600'],
    'baseline_detail_duration':     ['p(95)<300', 'p(99)<600'],
    'baseline_payroll_duration':    ['p(95)<300', 'p(99)<600'],
    'baseline_attendance_duration': ['p(95)<300', 'p(99)<600'],
    'baseline_errors':              ['rate<0.005'],
    'http_req_failed':              ['rate<0.005'],
  },
};

export function setup() {
  const tokens = {};
  for (const t of TENANTS) {
    tokens[t.slug] = loginTenant(t.slug, t.username, t.password);
  }
  return tokens;
}

export default function (tokens) {
  const tenant = TENANTS[__VU % TENANTS.length];
  const token  = tokens[tenant.slug];
  if (!token) return;

  const base    = tenantApiBase(tenant.slug);
  const headers = tenantHeaders(tenant.slug, token);

  const now   = new Date();
  const month = now.getMonth() + 1;
  const year  = now.getFullYear();
  const today = now.toISOString().split('T')[0];

  // Randomly sample an employee ID within a realistic range per tenant
  const employeeId = Math.floor(Math.random() * 3000) + 1;

  const roll = Math.random();
  let res;

  if (roll < 0.40) {
    // List employees — most frequent HR browsing action
    res = http.get(`${base}/api/employees`, { headers });
    check(res, { 'list employees 200': (r) => r.status === 200 });
    listDuration.add(res.timings.duration);

  } else if (roll < 0.65) {
    // View a single employee record — detail drill-down
    res = http.get(`${base}/api/employees/${employeeId}`, { headers });
    check(res, { 'get employee 200/404': (r) => r.status === 200 || r.status === 404 });
    detailDuration.add(res.timings.duration);

  } else if (roll < 0.85) {
    // Payroll status query — routine check by HR and finance staff
    res = http.get(
      `${base}/api/payroll/status?month=${month}&year=${year}`,
      { headers }
    );
    check(res, { 'payroll status 200': (r) => r.status === 200 });
    payrollDuration.add(res.timings.duration);

  } else {
    // Attendance update — lightweight daily write (clock-in / leave record)
    res = http.patch(
      `${base}/api/employees/${employeeId}/attendance`,
      JSON.stringify({ date: today, status: 'present' }),
      { headers }
    );
    check(res, { 'attendance update 2xx/404': (r) => r.status < 300 || r.status === 404 });
    attendanceDuration.add(res.timings.duration);
  }

  // A 5xx or network failure counts as an application error
  errorRate.add(res.status === 0 || res.status >= 500 ? 1 : 0);
}
