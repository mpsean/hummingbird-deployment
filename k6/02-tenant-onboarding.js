/**
 * Scenario 2 — New Tenant Onboarding (sequential, 5 tenants)
 *
 * Provisions and seeds 5 brand-new tenants one at a time, each loaded with a
 * realistic dataset from k6/demo-data/dataset_1 (~3 000 employees and
 * ~13 700–14 000 attendance rows per hotel). Per-step timings are recorded as
 * custom trend metrics so per-tenant averages can be reported.
 *
 * Per-iteration flow:
 *   1. Create tenant — POST {API}/api/admin/tenants  (DB + K8s namespace)
 *                    + POST {SIGNIN}/api/tenants     (auth registry)
 *                    + POST {SIGNIN}/api/auth/register (admin user, returns JWT)
 *                    + probe /api/personnel/positions until 200 (ingress settle)
 *   2. Append employees       — POST {tenant}/api/personnel/employees/import (CSV)
 *   3. Append time attendance — POST {tenant}/api/timeattendance/import      (CSV)
 *
 * Shape  : 1 VU × 5 sequential iterations (no concurrency)
 *
 * Custom metrics:
 *   tenant_provision_duration   — step 1 (ms)
 *   tenant_employees_duration   — step 2 (ms)
 *   tenant_attendance_duration  — step 3 (ms)
 *   tenant_completion_duration  — sum of all three (ms)
 *
 * Run:
 *   k6 run k6/02-tenant-onboarding.js
 *   k6 run -e ADMIN_KEY=hb-admin-dev-key k6/02-tenant-onboarding.js
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';
import { API_ADMIN_KEY, tenantApiBase, tenantHeaders } from './lib/auth.js';

const errorRate         = new Rate('onboarding_errors');
const provisionDur      = new Trend('tenant_provision_duration',  true);
const employeesDur      = new Trend('tenant_employees_duration',  true);
const attendanceDur     = new Trend('tenant_attendance_duration', true);
const completionDur     = new Trend('tenant_completion_duration', true);

const API_BASE    = __ENV.API_URL    || 'http://api.hmmbird.xyz';
const SIGNIN_BASE = __ENV.SIGNIN_URL || 'http://signin.hmmbird.xyz';

const ADMIN_HEADERS = {
  'Content-Type': 'application/json',
  'X-Admin-Key':  API_ADMIN_KEY,
};

// One hotel per iteration. CSVs loaded once at script init via open() and held
// in memory for the duration of the run (~8 MB total for all 5 datasets).
const HOTELS = [
  {
    slug:           'skyline',
    name:           'Skyline Palace Hotel',
    employeesCsv:   open('./demo-data/dataset_1/Skyline_Palace_Hotel_employees.csv'),
    attendanceCsv:  open('./demo-data/dataset_1/Skyline_Palace_Hotel_attendance.csv'),
  },
  {
    slug:           'pinnacle',
    name:           'Pinnacle Suites Bangkok',
    employeesCsv:   open('./demo-data/dataset_1/Pinnacle_Suites_Bangkok_employees.csv'),
    attendanceCsv:  open('./demo-data/dataset_1/Pinnacle_Suites_Bangkok_attendance.csv'),
  },
  {
    slug:           'azure',
    name:           'Azure Bay Resort',
    employeesCsv:   open('./demo-data/dataset_1/Azure_Bay_Resort_employees.csv'),
    attendanceCsv:  open('./demo-data/dataset_1/Azure_Bay_Resort_attendance.csv'),
  },
  {
    slug:           'horizon',
    name:           'The Grand Horizon Hotel',
    employeesCsv:   open('./demo-data/dataset_1/The_Grand_Horizon_Hotel_employees.csv'),
    attendanceCsv:  open('./demo-data/dataset_1/The_Grand_Horizon_Hotel_attendance.csv'),
  },
  {
    slug:           'orchid',
    name:           'The Royal Orchid Hotel',
    employeesCsv:   open('./demo-data/dataset_1/The_Royal_Orchid_Hotel_employees.csv'),
    attendanceCsv:  open('./demo-data/dataset_1/The_Royal_Orchid_Hotel_attendance.csv'),
  },
];

export const options = {
  scenarios: {
    sequential_onboarding: {
      executor:    'per-vu-iterations',
      vus:         1,
      iterations:  HOTELS.length,   // one per hotel in the dataset
      maxDuration: '90m',
    },
  },
  thresholds: {
    'onboarding_errors': ['rate<0.05'],
    'http_req_failed':   ['rate<0.05'],
  },
  setupTimeout:    '30s',
  teardownTimeout: '5m',
  ext: {
    prometheusRW: {
      url: __ENV.PROMETHEUS_URL || 'http://prometheus.hmmbird.xyz/api/v1/write',
      flushPeriod: '5s',
      staleMarkers: true,
    },
  },
};

// ── helpers ────────────────────────────────────────────────────────────────

function authOnlyHeaders(token) {
  return { Authorization: `Bearer ${token}` };
}

function csvRowCount(csv) {
  // header + N rows + optional trailing newline → subtract header
  const lines = csv.split('\n').filter((l) => l.length > 0);
  return Math.max(0, lines.length - 1);
}

function provisionTenant(slug, name) {
  // 1a. API admin — creates tenant DB + K8s namespace/deployment/ingress
  const apiRes = http.post(
    `${API_BASE}/api/admin/tenants`,
    JSON.stringify({ Subdomain: slug, Name: name, ServiceChargeVersion: 'A' }),
    { headers: ADMIN_HEADERS }
  );
  if (apiRes.status !== 201 && apiRes.status !== 200) {
    throw new Error(`API tenant create (${apiRes.status}): ${apiRes.body}`);
  }
  const tenantId = JSON.parse(apiRes.body).id;

  // 1b. Signin — register tenant in auth DB
  const signinTRes = http.post(
    `${SIGNIN_BASE}/api/tenants`,
    JSON.stringify({ Slug: slug, Name: name, FrontendUrl: `http://${slug}.hmmbird.xyz` }),
    { headers: { 'Content-Type': 'application/json' } }
  );
  if (signinTRes.status !== 201 && signinTRes.status !== 200) {
    throw new Error(`Signin tenant create (${signinTRes.status}): ${signinTRes.body}`);
  }

  // 1c. Register admin user — returns JWT directly
  const regRes = http.post(
    `${SIGNIN_BASE}/api/auth/register`,
    JSON.stringify({
      TenantSlug: slug,
      Email:      'load@hmmbird.xyz',
      Username:   'load_admin',
      Password:   'loadtest123',
      FirstName:  'Load',
      LastName:   'Admin',
    }),
    { headers: { 'Content-Type': 'application/json' } }
  );
  if (regRes.status !== 201 && regRes.status !== 200) {
    throw new Error(`User register (${regRes.status}): ${regRes.body}`);
  }
  const token = JSON.parse(regRes.body).token;

  // 1d. Probe ingress until 200 (Traefik route reload)
  const base    = tenantApiBase(slug);
  const headers = tenantHeaders(slug, token);
  let ready = false;
  for (let i = 0; i < 30; i++) {
    const probe = http.get(`${base}/api/personnel/positions`, { headers, timeout: '5s' });
    if (probe.status === 200) { ready = true; break; }
    sleep(2);
  }
  if (!ready) throw new Error(`Tenant ${slug} ingress did not settle within 60 s`);

  return { tenantId, token };
}

function uploadEmployees(slug, token, csv) {
  const base = tenantApiBase(slug);
  const res  = http.post(
    `${base}/api/personnel/employees/import`,
    { file: http.file(csv, 'employees.csv', 'text/csv') },
    { headers: authOnlyHeaders(token), timeout: '5m' }
  );
  const ok = check(res, { 'employees imported 200': (r) => r.status === 200 });
  if (!ok) console.warn(`[employees] HTTP ${res.status}: ${res.body && res.body.slice(0, 200)}`);
  return ok;
}

function uploadAttendance(slug, token, csv) {
  const base = tenantApiBase(slug);
  const res  = http.post(
    `${base}/api/timeattendance/import`,
    { file: http.file(csv, 'attendance.csv', 'text/csv') },
    { headers: authOnlyHeaders(token), timeout: '15m' }
  );
  const ok = check(res, { 'attendance imported 200': (r) => r.status === 200 });
  if (!ok) console.warn(`[attendance] HTTP ${res.status}: ${res.body && res.body.slice(0, 200)}`);
  return ok;
}

// ── lifecycle ──────────────────────────────────────────────────────────────

export function setup() {
  const runId = Date.now().toString(36).slice(-5);
  console.log(`[setup] Run ID: ${runId} — tenants will be t${runId}-1 .. t${runId}-5`);
  return { runId };
}

export default function (data) {
  const iter   = __ITER + 1;
  const hotel  = HOTELS[__ITER];
  const slug   = `t${data.runId}-${hotel.slug}`;
  const empRows = csvRowCount(hotel.employeesCsv);
  const attRows = csvRowCount(hotel.attendanceCsv);

  console.log(`\n[iter ${iter}] === Onboarding ${hotel.name} as ${slug} ===`);
  let allOk = true;

  // Step 1 — provision
  const t0 = Date.now();
  let tenantId, token;
  try {
    ({ tenantId, token } = provisionTenant(slug, hotel.name));
  } catch (e) {
    console.error(`[iter ${iter}] provision failed: ${e.message}`);
    errorRate.add(1);
    return;
  }
  const provMs = Date.now() - t0;
  provisionDur.add(provMs);
  console.log(`[iter ${iter}] step 1 (provision) : ${provMs} ms`);

  // Step 2 — employees CSV
  const t1 = Date.now();
  if (!uploadEmployees(slug, token, hotel.employeesCsv)) allOk = false;
  const empMs = Date.now() - t1;
  employeesDur.add(empMs);
  console.log(`[iter ${iter}] step 2 (employees) : ${empMs} ms (${empRows} rows)`);

  // Step 3 — attendance CSV
  const t2 = Date.now();
  if (!uploadAttendance(slug, token, hotel.attendanceCsv)) allOk = false;
  const attMs = Date.now() - t2;
  attendanceDur.add(attMs);
  console.log(`[iter ${iter}] step 3 (attendance): ${attMs} ms (${attRows} rows)`);

  const totalMs = provMs + empMs + attMs;
  completionDur.add(totalMs);
  errorRate.add(!allOk);
  console.log(`[iter ${iter}] TOTAL completion   : ${totalMs} ms`);
}

export function teardown(data) {
  console.log(`\n[teardown] Cleaning up tenants with prefix t${data.runId}-`);

  const listRes = http.get(`${API_BASE}/api/admin/tenants`, { headers: ADMIN_HEADERS });
  if (listRes.status !== 200) {
    console.error(`[teardown] List failed (${listRes.status}) — manual cleanup may be required`);
    return;
  }

  const all  = JSON.parse(listRes.body);
  const mine = all.filter((t) => t.subdomain && t.subdomain.startsWith(`t${data.runId}-`));
  console.log(`[teardown] Found ${mine.length} tenants to delete`);

  let deleted = 0;
  let failed  = 0;
  for (const tenant of mine) {
    const delRes = http.del(
      `${API_BASE}/api/admin/tenants/${tenant.id}`,
      null,
      { headers: ADMIN_HEADERS }
    );
    if (delRes.status === 200 || delRes.status === 204 || delRes.status === 404) {
      deleted++;
    } else {
      console.warn(`[teardown] Failed to delete ${tenant.subdomain} (id=${tenant.id}): HTTP ${delRes.status}`);
      failed++;
    }
  }
  console.log(`[teardown] Done — deleted ${deleted}, failed ${failed}`);
  // Note: signin DB tenant rows leak (no DELETE endpoint). Safe across runs
  // because each run uses a unique t{runId}- prefix.
}
