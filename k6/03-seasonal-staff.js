/**
 * Scenario 3 — Seasonal Staff Lifecycle (load → access → offload)
 *
 * Simulates a high-season staff cycle: bring in temporary employees, have the
 * system serve traffic against the now-larger workforce, then offload them.
 *
 * Phase timeline (5–7 min total):
 *   0:00 → 1:00   Load     constant-arrival-rate 50/s   POST /api/personnel/employees   (~3 000 creates, ~600/tenant)
 *   1:00 → 4:00   Access   constant-arrival-rate 200/s  GET  /api/personnel/employees, /positions, /timeattendance/months
 *   4:00 → 7:00   Offload  per-vu-iterations 5×1        Lists SEAS-* per tenant, deletes each
 *
 * Each created employee carries a `SEAS-{vu}-{iter}-{ts}` code so the offload
 * phase can locate them deterministically without sharing state across phases.
 *
 * Custom metrics:
 *   staff_load_duration     — POST timing during phase 1 (ms)
 *   staff_access_duration   — GET timing during phase 2 (ms)
 *   staff_offload_duration  — total list+delete loop per tenant (ms)
 *
 * Run:
 *   k6 run k6/03-seasonal-staff.js
 *   k6 run -e SIGNIN_URL=http://signin.hmmbird.xyz k6/03-seasonal-staff.js
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';
import exec from 'k6/execution';
import { loginTenant, tenantApiBase, tenantHeaders } from './lib/auth.js';

const errorRate  = new Rate('staff_errors');
const loadDur    = new Trend('staff_load_duration',    true);
const accessDur  = new Trend('staff_access_duration',  true);
const offloadDur = new Trend('staff_offload_duration', true);

const TENANTS = [
  { slug: 'hotel-a', username: 'hr_admin', password: 'admin123' },
  { slug: 'hotel-b', username: 'hr_admin', password: 'admin123' },
  { slug: 'hotel-c', username: 'hr_admin', password: 'admin123' },
  { slug: 'hotel-d', username: 'hr_admin', password: 'admin123' },
  { slug: 'hotel-e', username: 'hr_admin', password: 'admin123' },
];

const STAFF_PREFIX = 'SEAS';

export const options = {
  scenarios: {
    load_staff: {
      executor:        'constant-arrival-rate',
      rate:            50,
      timeUnit:        '1s',
      duration:        '1m',
      preAllocatedVUs: 100,
      maxVUs:          200,
      startTime:       '0s',
      tags:            { phase: 'load' },
    },
    access_info: {
      executor:        'constant-arrival-rate',
      rate:            200,
      timeUnit:        '1s',
      duration:        '3m',
      preAllocatedVUs: 100,
      maxVUs:          250,
      startTime:       '1m',
      tags:            { phase: 'access' },
    },
    offload_staff: {
      executor:    'per-vu-iterations',
      vus:         5,            // one VU per tenant — parallel cleanup
      iterations:  1,
      startTime:   '4m',
      maxDuration: '3m',
      tags:        { phase: 'offload' },
    },
  },
  thresholds: {
    // Wide error budget — phase 1 is concurrent inserts, phase 2 sustained reads, phase 3 sequential deletes.
    'staff_errors':    ['rate<0.10'],
    'http_req_failed': ['rate<0.10'],
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

export function setup() {
  const tokens = {};
  for (const t of TENANTS) {
    tokens[t.slug] = loginTenant(t.slug, t.username, t.password);
  }
  return tokens;
}

export default function (tokens) {
  const phase  = exec.scenario.name;
  const tenant = TENANTS[(__VU - 1) % TENANTS.length];
  const token  = tokens[tenant.slug];
  if (!token) return;

  const base    = tenantApiBase(tenant.slug);
  const headers = tenantHeaders(tenant.slug, token);

  if (phase === 'load_staff') {
    // Phase 1 — create one seasonal employee with a uniquely-coded SEAS-* identifier
    const code = `${STAFF_PREFIX}-${__VU}-${__ITER}-${Date.now() % 100000}`;
    const employee = {
      name:         `Temp${__VU}`,
      surname:      `Season${__ITER}`,
      employeeCode: code,
      positionId:   1,
      salary:       12000,
      dateJoined:   new Date().toISOString().split('T')[0],
      status:       'Active',
    };

    const t0  = Date.now();
    const res = http.post(`${base}/api/personnel/employees`,
      JSON.stringify(employee), { headers });
    const ok = check(res, {
      'staff loaded 201': (r) => r.status === 201 || r.status === 200,
    });
    loadDur.add(Date.now() - t0);
    errorRate.add(!ok);

  } else if (phase === 'access_info') {
    // Phase 2 — GET-only mix simulating staff browsing their info.
    // Authenticated as hr_admin since seasonal employees aren't users in the
    // signin DB; the request pattern still mirrors a staff portal session.
    const periodIndex = (__VU - 1) % 24;
    const year  = periodIndex < 12 ? 2024 : 2023;
    const month = (periodIndex % 12) + 1;
    const empId = ((__VU + __ITER) % 50) + 1;   // hit various seeded/temp IDs

    const roll = Math.random();
    const t0 = Date.now();
    let res, ok;

    if (roll < 0.30) {
      // Staff directory
      res = http.get(`${base}/api/personnel/employees`, { headers });
      ok  = check(res, { 'list employees 200': (r) => r.status === 200 });
    } else if (roll < 0.55) {
      // Individual employee profile (404 acceptable — IDs are sampled)
      res = http.get(`${base}/api/personnel/employees/${empId}`, {
        headers,
        responseCallback: http.expectedStatuses(200, 404),
      });
      ok  = check(res, { 'employee detail 200/404': (r) => r.status === 200 || r.status === 404 });
    } else if (roll < 0.75) {
      // Payroll for a period
      res = http.get(`${base}/api/payroll/${year}/${month}`, {
        headers,
        responseCallback: http.expectedStatuses(200, 404),
      });
      ok  = check(res, { 'payroll period 200/404': (r) => r.status === 200 || r.status === 404 });
    } else if (roll < 0.90) {
      // Attendance summary for a period
      res = http.get(`${base}/api/timeattendance/${year}/${month}/summary`, {
        headers,
        responseCallback: http.expectedStatuses(200, 404),
      });
      ok  = check(res, { 'attendance summary 200/404': (r) => r.status === 200 || r.status === 404 });
    } else {
      // Lookup tables — positions reference
      res = http.get(`${base}/api/personnel/positions`, { headers });
      ok  = check(res, { 'list positions 200': (r) => r.status === 200 });
    }
    accessDur.add(Date.now() - t0);
    errorRate.add(!ok);

  } else if (phase === 'offload_staff') {
    // Phase 3 — one VU per tenant; list all SEAS-* employees and delete each.
    const t0 = Date.now();
    const listRes = http.get(`${base}/api/personnel/employees`, { headers });
    if (listRes.status !== 200) {
      console.error(`[offload] ${tenant.slug}: list failed (HTTP ${listRes.status})`);
      errorRate.add(1);
      return;
    }

    let all;
    try { all = JSON.parse(listRes.body); }
    catch (e) { console.error(`[offload] ${tenant.slug}: list parse failed`); errorRate.add(1); return; }

    const seasonal = all.filter((e) => (e.employeeCode || '').startsWith(`${STAFF_PREFIX}-`));
    console.log(`[offload] ${tenant.slug}: draining ${seasonal.length} seasonal staff`);

    let deleted = 0, failed = 0;
    for (const emp of seasonal) {
      const delRes = http.del(`${base}/api/personnel/employees/${emp.id}`, null, { headers });
      if (delRes.status === 200 || delRes.status === 204 || delRes.status === 404) {
        deleted++;
      } else {
        failed++;
      }
    }
    offloadDur.add(Date.now() - t0);
    errorRate.add(failed > 0);
    console.log(`[offload] ${tenant.slug}: deleted ${deleted}, failed ${failed}`);
  }

  if (phase !== 'offload_staff') sleep(Math.random() * 0.5);
}

export function teardown(tokens) {
  // Safety net: catch any SEAS-* survivors if a phase was interrupted
  console.log(`[teardown] Sweeping for any remaining ${STAFF_PREFIX}-* across tenants`);
  for (const t of TENANTS) {
    const token   = tokens[t.slug];
    if (!token) continue;
    const base    = tenantApiBase(t.slug);
    const headers = tenantHeaders(t.slug, token);

    const listRes = http.get(`${base}/api/personnel/employees`, { headers });
    if (listRes.status !== 200) {
      console.warn(`[teardown] ${t.slug}: list failed (${listRes.status}) — skipping`);
      continue;
    }
    const all = JSON.parse(listRes.body);
    const stragglers = all.filter((e) => (e.employeeCode || '').startsWith(`${STAFF_PREFIX}-`));
    if (stragglers.length === 0) continue;

    console.log(`[teardown] ${t.slug}: cleaning up ${stragglers.length} stragglers`);
    for (const emp of stragglers) {
      http.del(`${base}/api/personnel/employees/${emp.id}`, null, { headers });
    }
  }
}
