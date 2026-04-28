/**
 * Scenario 2 — New Tenant Onboarding
 *
 * Provisions ONE new tenant end-to-end (API admin DB + signin DB + admin user)
 * then drives a moderate read mix against it for 5 min to verify the new tenant
 * is fully reachable: K8s namespace, ingress route, and DB connection all wired.
 *
 * Provisioning chain (setup):
 *   1. POST {API}/api/admin/tenants            — creates tenant DB + K8s resources
 *   2. POST {SIGNIN}/api/tenants               — registers tenant in auth DB
 *   3. POST {SIGNIN}/api/auth/register         — creates admin user, returns JWT
 *   4. Probe tenant ingress until 200          — Traefik routing settle
 *
 * Shape  : 10 VUs constant for 5 minutes against the new tenant
 * SLA    : reads p95 < 1 000 ms, error rate < 5 %
 *
 * Run:
 *   k6 run k6/02-tenant-onboarding.js
 *   k6 run -e ADMIN_KEY=hb-admin-dev-key k6/02-tenant-onboarding.js
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';
import { API_ADMIN_KEY, tenantApiBase, tenantHeaders } from './lib/auth.js';

const errorRate    = new Rate('onboarding_errors');
const setupDur     = new Trend('onboarding_setup_duration', true);
const readDur      = new Trend('onboarding_read_duration',  true);

const API_BASE    = __ENV.API_URL    || 'http://api.hmmbird.xyz';
const SIGNIN_BASE = __ENV.SIGNIN_URL || 'http://signin.hmmbird.xyz';

const ADMIN_HEADERS = {
  'Content-Type': 'application/json',
  'X-Admin-Key':  API_ADMIN_KEY,
};

export const options = {
  scenarios: {
    tenant_onboarding: {
      executor: 'constant-vus',
      vus:      10,
      duration: '5m',
    },
  },
  thresholds: {
    // Reads against the new tenant — empty tables, should be quick.
    'onboarding_errors':       ['rate<0.05'],
    'http_req_failed':         ['rate<0.05'],
    'onboarding_read_duration': ['p(95)<1000'],
  },
  setupTimeout:    '3m',
  teardownTimeout: '2m',
  ext: {
    prometheusRW: {
      url: __ENV.PROMETHEUS_URL || 'http://prometheus.hmmbird.xyz/api/v1/write',
      flushPeriod: '5s',
      staleMarkers: true,
    },
  },
};

export function setup() {
  const runId = Date.now().toString(36).slice(-5);
  const slug  = `t${runId}-onboard`;
  const name  = `Load Hotel ${runId}`;
  const t0    = Date.now();

  console.log(`[setup] Provisioning tenant: ${slug}`);

  // 1. API admin — creates tenant DB + K8s namespace/deployment/ingress
  const apiRes = http.post(
    `${API_BASE}/api/admin/tenants`,
    JSON.stringify({ Subdomain: slug, Name: name, ServiceChargeVersion: 'A' }),
    { headers: ADMIN_HEADERS }
  );
  if (apiRes.status !== 201 && apiRes.status !== 200) {
    throw new Error(`API tenant creation failed (${apiRes.status}): ${apiRes.body}`);
  }
  const tenantId = JSON.parse(apiRes.body).id;

  // 2. Signin — registers tenant in the auth DB so users can be associated
  const signinTenantRes = http.post(
    `${SIGNIN_BASE}/api/tenants`,
    JSON.stringify({ Slug: slug, Name: name, FrontendUrl: `http://${slug}.hmmbird.xyz` }),
    { headers: { 'Content-Type': 'application/json' } }
  );
  if (signinTenantRes.status !== 201 && signinTenantRes.status !== 200) {
    throw new Error(`Signin tenant creation failed (${signinTenantRes.status}): ${signinTenantRes.body}`);
  }

  // 3. Register an admin user under the new tenant — returns JWT directly
  const registerRes = http.post(
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
  if (registerRes.status !== 201 && registerRes.status !== 200) {
    throw new Error(`User registration failed (${registerRes.status}): ${registerRes.body}`);
  }
  const token = JSON.parse(registerRes.body).token;

  // 4. Probe tenant ingress until it responds — K8s ingress + Traefik settle (~10–30 s)
  const base    = tenantApiBase(slug);
  const headers = tenantHeaders(slug, token);
  let ready = false;
  for (let i = 0; i < 30; i++) {
    const probe = http.get(`${base}/api/personnel/positions`, { headers, timeout: '5s' });
    if (probe.status === 200) {
      console.log(`[setup] Tenant ready after ${i + 1} probe(s)`);
      ready = true;
      break;
    }
    sleep(2);
  }
  if (!ready) throw new Error(`Tenant ${slug} did not become reachable within 60 s`);

  const elapsed = Date.now() - t0;
  setupDur.add(elapsed);
  console.log(`[setup] Tenant ${slug} (id=${tenantId}) fully provisioned in ${elapsed}ms`);

  return { tenantId, slug, token };
}

export default function (data) {
  const base    = tenantApiBase(data.slug);
  const headers = tenantHeaders(data.slug, data.token);

  // Read-only mix against the brand-new tenant. Tables are empty so every
  // endpoint returns 200 with an empty list — exercises ingress + DB conn.
  const roll = Math.random();
  let res, ok;

  if (roll < 0.40) {
    res = http.get(`${base}/api/personnel/employees`, { headers });
    ok  = check(res, { 'list employees 200': (r) => r.status === 200 });
  } else if (roll < 0.70) {
    res = http.get(`${base}/api/personnel/positions`, { headers });
    ok  = check(res, { 'list positions 200': (r) => r.status === 200 });
  } else if (roll < 0.90) {
    res = http.get(`${base}/api/payroll/months`, { headers });
    ok  = check(res, { 'payroll months 200': (r) => r.status === 200 });
  } else {
    res = http.get(`${base}/api/timeattendance/months`, { headers });
    ok  = check(res, { 'attendance months 200': (r) => r.status === 200 });
  }

  readDur.add(res.timings.duration);
  errorRate.add(!ok);

  sleep(Math.random() * 1 + 0.5); // 0.5–1.5 s think time
}

export function teardown(data) {
  console.log(`[teardown] Deleting tenant ${data.slug} (id=${data.tenantId})`);
  const delRes = http.del(
    `${API_BASE}/api/admin/tenants/${data.tenantId}`,
    null,
    { headers: ADMIN_HEADERS }
  );
  if (delRes.status === 200 || delRes.status === 204 || delRes.status === 404) {
    console.log(`[teardown] Tenant ${data.slug} deleted (HTTP ${delRes.status})`);
  } else {
    console.warn(`[teardown] Delete returned ${delRes.status}: ${delRes.body}`);
  }
  // Note: signin DB tenant row leaks (no DELETE endpoint). Safe across runs
  // because each run uses a unique t{runId}- prefix.
}
