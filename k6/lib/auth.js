import http from 'k6/http';
import { check } from 'k6';

const SIGNIN_BASE = __ENV.SIGNIN_URL || 'http://signin.hmmbird.xyz';
const API_ADMIN_KEY = __ENV.ADMIN_KEY || 'hb-admin-dev-key';

// Returns a JWT token for a given tenant user via the signin service.
export function loginTenant(tenantSlug, username, password) {
  const res = http.post(
    `${SIGNIN_BASE}/api/auth/login`,
    JSON.stringify({ tenantSlug, emailOrUsername: username, password }),
    { headers: { 'Content-Type': 'application/json' } }
  );
  check(res, { 'login 200': (r) => r.status === 200 });
  return res.json('token') || '';
}

// Returns shared headers for authenticated tenant API calls.
export function tenantHeaders(tenantSlug, token) {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
    // Host routing: k6 resolves the subdomain via DNS or __ENV.API_IP override
  };
}

// Base URL for a given tenant's API.
export function tenantApiBase(tenantSlug) {
  const apiHost = __ENV.API_IP
    ? `http://${__ENV.API_IP}` // e.g. 13.214.98.131 with Host header override
    : `http://${tenantSlug}.hmmbird.xyz`;
  return apiHost;
}

export { API_ADMIN_KEY };
