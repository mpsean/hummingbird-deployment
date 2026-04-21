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
  { slug: 'acme',    username: 'hr_admin', password: 'admin123' },
  { slug: 'maipro',  username: 'hr_admin', password: 'admin123' },
  { slug: 'hotel-d', username: 'hr_admin', password: 'admin123' },
  { slug: 'hotel-e', username: 'hr_admin', password: 'admin123' },
];

export const options = {
  scenarios: {
    seasonal_staff: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '2m',   target: 1000  }, // warm-up ramp
        { duration: '3m30s', target: 10000 }, // aggressive ramp to peak
        { duration: '30s',  target: 10000 }, // hold peak
        { duration: '2m',   target: 0     }, // ramp down
      ],
    },
  },
  thresholds: {
    'staff_create_duration': ['p(95)<400'],
    'staff_delete_duration': ['p(95)<400'],
    'staff_errors':          ['rate<0.01'],
    'http_req_failed':       ['rate<0.01'],
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
    firstName:  `Temp${__VU}`,
    lastName:   `Season${__ITER}`,
    email:      `temp${__VU}.${__ITER}@load-test.internal`,
    position:   'Seasonal Staff',
    department: 'Hospitality',
    hireDate:   new Date().toISOString().split('T')[0],
    isTemporary: true,
  };

  // Step 1 — Create (onboard) employee
  const createRes = http.post(
    `${base}/api/v1/employees`,
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
    `${base}/api/v1/employees/${employeeId}`,
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
