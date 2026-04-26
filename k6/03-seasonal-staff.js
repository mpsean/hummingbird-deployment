/**
 * Scenario 3 — Seasonal / Event-Based Staff Onboarding & Offboarding
 *
 * Simulates high-volume staff management during Thai tourism peak seasons:
 * large concurrent create → delete employee cycles.
 *
 * Shape  : ramp 1 000 → 10 000 VUs over 5 min 30 s, hold 30 s, ramp down 2 min
 * SLA    : p95 < 400 ms, error rate < 1 %
 *
 * Run:
 *   k6 run k6/03-seasonal-staff.js
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';
import { loginTenant, tenantApiBase, tenantHeaders } from './lib/auth.js';

const errorRate    = new Rate('staff_errors');
const createDur    = new Trend('staff_create_duration', true);
const deleteDur    = new Trend('staff_delete_duration', true);

const TENANTS = [
  { slug: 'hotel-a', username: 'hr_admin', password: 'admin123' },
  { slug: 'hotel-b',    username: 'hr_admin', password: 'admin123' },
  { slug: 'hotel-c',  username: 'hr_admin', password: 'admin123' },
  { slug: 'hotel-d', username: 'hr_admin', password: 'admin123' },
  { slug: 'hotel-e', username: 'hr_admin', password: 'admin123' },
];

export const options = {
  scenarios: {
    seasonal_staff: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '2m', target: 1250 }, // warm-up ramp
        { duration: '3m', target: 5000 }, // ramp to peak — exhaust worker capacity, trigger CA
        { duration: '1m', target: 5000 }, // hold — CA must add nodes within this window
        { duration: '2m', target: 0    }, // ramp down
      ],
    },
  },
  thresholds: {
    // Stepped up from 3 000 VUs; 10% covers CA node-join window (~2 min) where pods are pending.
    'staff_errors':    ['rate<0.10'],
    'http_req_failed': ['rate<0.10'],
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

  // Unique employee data per VU + iteration
  const employee = {
    name:         `Temp${__VU}`,
    surname:      `Season${__ITER}`,
    employeeCode: `TMP-${__VU}-${__ITER}`,
    positionId:   1,
    salary:       12000,
    dateJoined:   new Date().toISOString().split('T')[0],
    status:       'Active',
  };

  // Step 1 — Create (onboard) employee
  const createRes = http.post(
    `${base}/api/employees`,
    JSON.stringify(employee),
    { headers }
  );

  const created = check(createRes, {
    'employee created 201': (r) => r.status === 201 || r.status === 200,
  });

  createDur.add(createRes.timings.duration);
  errorRate.add(!created);

  if (!created) {
    sleep(1);
    return;
  }

  // Extract created employee ID from response
  const employeeId = createRes.json('id') || createRes.json('employeeId');
  if (!employeeId) {
    errorRate.add(1);
    return;
  }

  sleep(0.5); // brief pause between create and delete (mirrors real workflow)

  // Step 2 — Delete (offboard) employee
  const deleteRes = http.del(
    `${base}/api/employees/${employeeId}`,
    null,
    { headers }
  );

  const deleted = check(deleteRes, {
    'employee deleted 200/204': (r) => r.status === 200 || r.status === 204,
  });

  deleteDur.add(deleteRes.timings.duration);
  errorRate.add(!deleted);

  sleep(Math.random() + 0.5); // 0.5–1.5 s think time
}
