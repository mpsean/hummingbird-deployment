/**
 * Scenario 0 — Ordinary Working Day (Steady-State Baseline)
 *
 * Validates that the system performs acceptably under routine traffic — the
 * precondition all other scenarios depend on. Uses a constant-arrival-rate
 * (open) model so request throughput is controlled independently of VU count,
 * matching how real users arrive at the system.
 *
 * Shape  : ramp 0 → 200 RPS over 1 min, hold 200 RPS for 3 min, ramp down 1 min
 * Rate   : 200 req/s across all five tenants (~40 req/s per tenant)
 * Basis  : ~50 concurrent active HR users per tenant, 1–2 requests/min each
 *
 * Traffic mix (weighted random per iteration):
 *   40 % — list employees          (most frequent browsing action)
 *   25 % — view single employee    (detail drill-down)
 *   20 % — payroll fetch           (routine check of a calculated payroll month)
 *   15 % — attendance summary      (HR daily roll-up view)
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
  { slug: 'hotel-b',    username: 'hr_admin', password: 'admin123' },
  { slug: 'hotel-c',  username: 'hr_admin', password: 'admin123' },
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
        { duration: '1m',  target: 200 }, // ramp up
        { duration: '3m',  target: 200 }, // steady state
        { duration: '1m',  target: 0   }, // ramp down
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
  ext: {
    prometheusRW: {
      url: __ENV.PROMETHEUS_URL || 'http://prometheus.hmmbird.xyz/api/v1/write',
      flushPeriod: '5s',
      staleMarkers: true,
    },
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

  const month = 7;
  const year  = 2024;

  // Randomly sample an employee ID within a realistic range per tenant
  const employeeId = Math.floor(Math.random() * 3000) + 1;

  const roll = Math.random();
  let res;

  if (roll < 0.40) {
    // List employees — most frequent HR browsing action
    res = http.get(`${base}/api/personnel/employees`, { headers });
    check(res, { 'list employees 200': (r) => r.status === 200 });
    listDuration.add(res.timings.duration);

  } else if (roll < 0.65) {
    // View a single employee record — detail drill-down
    res = http.get(`${base}/api/personnel/employees/${employeeId}`, { headers });
    check(res, { 'get employee 200/404': (r) => r.status === 200 || r.status === 404 });
    detailDuration.add(res.timings.duration);

  } else if (roll < 0.85) {
    // Payroll fetch — HR/finance reviewing the closed month's payroll
    res = http.get(`${base}/api/payroll/${year}/${month}`, { headers });
    check(res, { 'payroll fetch 200': (r) => r.status === 200 });
    payrollDuration.add(res.timings.duration);

  } else {
    // Attendance summary — HR daily roll-up (per-employee totals for the month)
    res = http.get(`${base}/api/timeattendance/${year}/${month}/summary`, { headers });
    check(res, { 'attendance summary 200': (r) => r.status === 200 });
    attendanceDuration.add(res.timings.duration);
  }

  // A 5xx or network failure counts as an application error
  errorRate.add(res.status === 0 || res.status >= 500 ? 1 : 0);
}
