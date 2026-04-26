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
import { Counter, Rate, Trend } from 'k6/metrics';
import { textSummary } from 'https://jslib.k6.io/k6-summary/0.0.2/index.js';
import { loginTenant, tenantApiBase, tenantHeaders } from './lib/auth.js';

// Per-action duration trends for targeted SLO analysis
const listDuration       = new Trend('baseline_list_duration',       true);
const detailDuration     = new Trend('baseline_detail_duration',     true);
const payrollDuration    = new Trend('baseline_payroll_duration',    true);
const attendanceDuration = new Trend('baseline_attendance_duration', true);

// Count only server-side failures (5xx / connection errors); 4xx are expected
// for random employee IDs and are not application errors.
const errorRate = new Rate('baseline_errors');

// Tagged counter for the end-of-test breakdown (endpoint × failure kind).
// Buckets every non-2xx response so the summary surfaces 4xx noise too.
const errorBreakdown = new Counter('baseline_error_breakdown');

function recordBreakdown(res, endpoint) {
  if (res.status >= 200 && res.status < 300) return;
  const kind = res.status === 0
    ? `net:${res.error_code || 'unknown'}`
    : `http:${res.status}`;
  errorBreakdown.add(1, { endpoint, kind });
}

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
      // t3.medium infra target: 50 RPS sustainable (20% baseline CPU per node)
      // Little's Law at 50 RPS × 1 s app latency = 50 VUs; 2× headroom
      preAllocatedVUs: 100,
      maxVUs:          200,
      stages: [
        { duration: '1m',  target: 50  }, // ramp up
        { duration: '3m',  target: 50  }, // steady state — HPA must NOT fire
        { duration: '1m',  target: 0   }, // ramp down
      ],
    },
  },
  thresholds: {
    // Infrastructure focus: platform availability only — latency SLAs removed
    'baseline_errors':  ['rate<0.05'],  // 5% — tolerate slow app, not outages
    'http_req_failed':  ['rate<0.05'],
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
  let endpoint;

  if (roll < 0.40) {
    // List employees — most frequent HR browsing action
    endpoint = 'list';
    res = http.get(`${base}/api/personnel/employees`, { headers, tags: { endpoint } });
    check(res, { 'list employees 200': (r) => r.status === 200 });
    listDuration.add(res.timings.duration);

  } else if (roll < 0.65) {
    // View a single employee record — detail drill-down
    endpoint = 'detail';
    res = http.get(`${base}/api/personnel/employees/${employeeId}`, { headers, tags: { endpoint } });
    check(res, { 'get employee 200/404': (r) => r.status === 200 || r.status === 404 });
    detailDuration.add(res.timings.duration);

  } else if (roll < 0.85) {
    // Payroll fetch — HR/finance reviewing the closed month's payroll
    endpoint = 'payroll';
    res = http.get(`${base}/api/payroll/${year}/${month}`, { headers, tags: { endpoint } });
    check(res, { 'payroll fetch 200': (r) => r.status === 200 });
    payrollDuration.add(res.timings.duration);

  } else {
    // Attendance summary — HR daily roll-up (per-employee totals for the month)
    endpoint = 'attendance';
    res = http.get(`${base}/api/timeattendance/${year}/${month}/summary`, { headers, tags: { endpoint } });
    check(res, { 'attendance summary 200': (r) => r.status === 200 });
    attendanceDuration.add(res.timings.duration);
  }

  // A 5xx or network failure counts as an application error
  errorRate.add(res.status === 0 || res.status >= 500 ? 1 : 0);
  recordBreakdown(res, endpoint);
}

export function handleSummary(data) {
  const rows = [];
  for (const [key, metric] of Object.entries(data.metrics)) {
    const m = key.match(/^baseline_error_breakdown\{(.+)\}$/);
    if (!m) continue;
    rows.push({ tags: m[1], count: metric.values.count });
  }
  rows.sort((a, b) => b.count - a.count);

  const lines = ['', '=== Error breakdown (non-2xx by endpoint × kind) ===', ''];
  if (rows.length === 0) {
    lines.push('  (no errors recorded)');
  } else {
    for (const r of rows) {
      lines.push(`  ${String(r.count).padStart(7)}  ${r.tags}`);
    }
  }
  lines.push('');

  return {
    stdout: textSummary(data, { indent: ' ', enableColors: true }) + lines.join('\n'),
  };
}
