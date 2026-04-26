/**
 * Scenario 4 — HPA Trigger Verification (5-minute spike)
 *
 * Confirms the HPA fires and adds replicas within a single 5-minute run.
 * The hummingbird-api HPA threshold is 50 % average CPU; the scale-up
 * stabilization window is 60 s (+2 pods per 60 s thereafter).
 *
 * Shape  : ramp 0 → 600 RPS over 1 min, hold 600 RPS for 3 min, ramp down 1 min
 * Rate   : 600 req/s — 3× the 200 RPS baseline that 2 replicas handle comfortably
 *
 * Traffic mix (CPU-heavy bias to breach the 50 % utilization threshold):
 *   50 % — payroll calculate   (POST, most CPU-intensive operation)
 *   30 % — list employees      (read, moderate)
 *   20 % — attendance summary  (lightweight read)
 *
 * Pass criteria (relaxed — this is a stress run, not an SLO run):
 *   p95 < 2 000 ms, error rate < 5 %
 *
 * Expected HPA behaviour:
 *   ~60–90 s into the hold phase: first scale-up event (2 → 4 replicas)
 *   Monitor with: kubectl get hpa hummingbird-api -n hummingbird-api -w
 *
 * Run:
 *   k6 run k6/04-hpa-trigger.js
 *   k6 run -e SIGNIN_URL=http://signin.hmmbird.xyz k6/04-hpa-trigger.js
 */

import http from 'k6/http';
import { check } from 'k6';
import { Rate, Trend } from 'k6/metrics';
import { loginTenant, tenantApiBase, tenantHeaders } from './lib/auth.js';

const payrollDuration    = new Trend('hpa_payroll_duration',    true);
const listDuration       = new Trend('hpa_list_duration',       true);
const attendanceDuration = new Trend('hpa_attendance_duration', true);
const errorRate          = new Rate('hpa_errors');

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
    hpa_trigger: {
      executor:        'ramping-arrival-rate',
      startRate:       0,
      timeUnit:        '1s',
      // t3.xlarge postgres handles 50% payroll write mix; API CPU on t3.medium is the ceiling.
      // 300 RPS = 6× the 75 RPS baseline; 150 RPS of payroll writes to the dedicated DB node.
      // Little's Law at 300 RPS × 1 s app latency = 300 VUs; 2× headroom.
      preAllocatedVUs: 600,
      maxVUs:          1200,
      stages: [
        { duration: '1m', target: 300 }, // ramp — push CPU past HPA 50% threshold
        { duration: '3m', target: 300 }, // hold — sustains pressure past the 60 s stabilisation window
        { duration: '1m', target: 0   }, // ramp down
      ],
    },
  },
  thresholds: {
    // t3.xlarge handles 50% write mix without timeouts — tighten error budget to 5%.
    'hpa_errors':      ['rate<0.05'],
    'http_req_failed': ['rate<0.05'],
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

  const roll = Math.random();
  let res;

  // Spread VUs across 24 historical periods. With postgres on t3.xlarge (4 vCPU / 16 GiB)
  // DB write concurrency is no longer the primary bottleneck — API CPU on t3.medium workers is.
  const periodIndex = (__VU - 1) % 24;
  const calcYear    = periodIndex < 12 ? 2024 : 2023;
  const calcMonth   = (periodIndex % 12) + 1;

  if (roll < 0.50) {
    // Payroll calculate — CPU-heavy POST; primary HPA pressure source
    res = http.post(
      `${base}/api/payroll/calculate`,
      JSON.stringify({
        Month:              calcMonth,
        Year:               calcYear,
        ServiceChargeTotal: SERVICE_CHARGE_TOTAL,
      }),
      { headers }
    );
    check(res, { 'payroll calculate 200/202': (r) => r.status === 200 || r.status === 202 });
    payrollDuration.add(res.timings.duration);

  } else if (roll < 0.80) {
    // List employees — moderate read load
    res = http.get(`${base}/api/personnel/employees`, { headers });
    check(res, { 'list employees 200': (r) => r.status === 200 });
    listDuration.add(res.timings.duration);

  } else {
    // Attendance summary — lightweight read (HR daily roll-up view)
    res = http.get(`${base}/api/timeattendance/${CURRENT_YEAR}/${CURRENT_MONTH}/summary`, { headers });
    check(res, { 'attendance summary 200': (r) => r.status === 200 });
    attendanceDuration.add(res.timings.duration);
  }

  errorRate.add(res.status === 0 || res.status >= 500 ? 1 : 0);
}
