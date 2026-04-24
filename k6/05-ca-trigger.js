/**
 * Scenario 5 — Cluster-Autoscaler Trigger Verification
 *
 * Confirms the cluster-autoscaler provisions a new node when pod demand
 * exceeds current node capacity. This is the end-to-end scaling chain:
 *
 *   load → HPA scales pods → cluster runs out of room → pods go Pending
 *        → CA adds a node → scheduler binds the Pending pods → recovery
 *
 * Shape   : ramp 0 → 800 RPS over 1 min, hold 800 RPS for 10 min, ramp down 1 min
 * Rate    : 800 req/s — well above what 8-replica minReplicas can absorb,
 *           forces HPA to climb toward maxReplicas over several minutes
 * Mix     : 90% payroll calculate (CPU-heavy), 10% list employees
 *           Heavy skew toward compute so per-pod CPU stays pinned at its limit.
 *
 * Pass criterion — THE test: cluster CPU commitment reaches 100%.
 *
 *   "Committed CPU" = sum of all pod CPU requests across all nodes, divided
 *   by sum of allocatable CPU across all nodes. When this hits 100%, the
 *   scheduler cannot place any more pods, new HPA-created replicas stay in
 *   Pending, and the cluster-autoscaler is forced to provision a node.
 *
 *   The run is considered successful when ALL of the following are observed:
 *
 *   ✓ Cluster CPU commitment reaches ≥ 100% during the hold phase
 *   ✓ At least one hummingbird-api pod enters Pending with reason
 *     "Insufficient cpu" (kubectl describe pod shows FailedScheduling)
 *   ✓ cluster-autoscaler logs a "scale-up: setting group size" event
 *   ✓ kubectl get nodes shows node count increase during the run
 *   ✓ After new node becomes Ready, Pending count returns to 0 and
 *     committed CPU drops (new headroom)
 *
 * PREREQUISITES — the test cannot push commitment to 100% unless:
 *
 *   a) HPA maxReplicas × API cpu request exceeds cluster allocatable CPU.
 *      Formula: total_committed_at_max = other_workloads_cpu
 *                                      + (maxReplicas × api_cpu_request)
 *                                      + postgres_cpu_request
 *      This must exceed: SUM(allocatable cpu) across all current nodes.
 *      Bump maxReplicas in hpa.yaml until the inequality holds.
 *
 *   b) ASG has room to grow (DesiredCapacity < MaxSize). Otherwise CA will
 *      log "max node group size reached" and stop.
 *      aws autoscaling describe-auto-scaling-groups \
 *        --query 'AutoScalingGroups[].[AutoScalingGroupName,DesiredCapacity,MaxSize]'
 *
 *   c) cluster-autoscaler has IAM and ASG-tag permissions.
 *      kubectl -n kube-system logs deploy/cluster-autoscaler --tail=5
 *      (no AccessDenied, and it's discovering the ASG)
 *
 * Monitor in separate terminals during the run:
 *
 *   # Live cluster CPU commitment percentage (the primary pass/fail signal)
 *   while true; do
 *     kubectl describe nodes \
 *       | awk '/Allocated resources:/,/Events:/' \
 *       | awk '/cpu/ {gsub(/[()%]/,""); sum_req+=$2; sum_pct+=$3; n++}
 *              END {printf "committed: %s%% (avg across %d nodes)\n", sum_pct/n, n}'
 *     sleep 5
 *   done
 *
 *   kubectl get hpa hummingbird-api -n hummingbird-api -w
 *   kubectl get pods -A --field-selector=status.phase=Pending -w
 *   kubectl get nodes -w
 *   kubectl -n kube-system logs deploy/cluster-autoscaler -f \
 *     | grep -iE 'scale-up|triggered|expanded|noScaleUp|insufficient'
 *
 * Run:
 *   k6 run k6/05-ca-trigger.js
 *   k6 run -e SIGNIN_URL=http://signin.hmmbird.xyz k6/05-ca-trigger.js
 */

import http from 'k6/http';
import { check } from 'k6';
import { Rate, Trend } from 'k6/metrics';
import { loginTenant, tenantApiBase, tenantHeaders } from './lib/auth.js';

const payrollDuration = new Trend('ca_payroll_duration', true);
const listDuration    = new Trend('ca_list_duration',    true);
const errorRate       = new Rate('ca_errors');

const TENANTS = [
  { slug: 'hotel-a', username: 'hr_admin', password: 'admin123' },
  { slug: 'hotel-b', username: 'hr_admin', password: 'admin123' },
  { slug: 'hotel-c', username: 'hr_admin', password: 'admin123' },
  { slug: 'hotel-d', username: 'hr_admin', password: 'admin123' },
  { slug: 'hotel-e', username: 'hr_admin', password: 'admin123' },
];

const CURRENT_MONTH        = 7;
const CURRENT_YEAR         = 2024;
const SERVICE_CHARGE_TOTAL = 500000;

export const options = {
  scenarios: {
    ca_trigger: {
      executor:        'ramping-arrival-rate',
      startRate:       0,
      timeUnit:        '1s',
      // Little's Law at 800 RPS × 2 s worst-case latency under stress = 1600 VUs
      preAllocatedVUs: 1600,
      maxVUs:          3200,
      stages: [
        { duration: '1m',  target: 800 }, // ramp up
        { duration: '10m', target: 800 }, // long hold — gives HPA time to hit ceiling, CA time to react, node time to provision (~3 min)
        { duration: '1m',  target: 0   }, // ramp down
      ],
    },
  },
  thresholds: {
    // Loose — this is a scale-out verification, not an SLO run.
    // Errors during the CA scale-up window are expected while pods are Pending.
    'ca_errors':       ['rate<0.15'],
    'http_req_failed': ['rate<0.15'],
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

  if (roll < 0.90) {
    // Payroll calculate — CPU-heavy POST; drives pods to their CPU limit
    res = http.post(
      `${base}/api/payroll/calculate`,
      JSON.stringify({
        Month:              CURRENT_MONTH,
        Year:               CURRENT_YEAR,
        ServiceChargeTotal: SERVICE_CHARGE_TOTAL,
      }),
      { headers }
    );
    check(res, { 'payroll calculate 200/202': (r) => r.status === 200 || r.status === 202 });
    payrollDuration.add(res.timings.duration);

  } else {
    // List employees — lighter read, keeps the mix realistic
    res = http.get(`${base}/api/personnel/employees`, { headers });
    check(res, { 'list employees 200': (r) => r.status === 200 });
    listDuration.add(res.timings.duration);
  }

  errorRate.add(res.status === 0 || res.status >= 500 ? 1 : 0);
}
