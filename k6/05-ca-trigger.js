/**
 * Scenario 5 — Cluster-Autoscaler Trigger Verification
 *
 * Confirms the cluster-autoscaler provisions a new node when pod demand
 * exceeds current node capacity. This is the end-to-end scaling chain:
 *
 *   load → HPA scales pods → cluster runs out of room → pods go Pending
 *        → CA adds a node → scheduler binds the Pending pods → recovery
 *
 * Shape   : ramp 0 → 1200 RPS over 30 s, hold 1200 RPS for 2 min, ramp down 30 s (3 min total)
 * Rate    : 1200 req/s — sized so per-pod CPU stays comfortably above the 50%
 *           HPA target even after the cluster scales toward maxReplicas, e.g.
 *           at 16 replicas this is 75 RPS/pod of CPU-heavy work.
 *
 * Note on the short hold: 2 min is enough to trigger the CA scale-up event
 * (HPA hits ceiling → pods Pending → CA logs scale-up), but the new node
 * typically becomes Ready ~2–3 min after CA fires, which usually lands
 * AFTER ramp-down. Keep the kubectl watchers running for a few minutes past
 * test end to capture the "Pending → 0 + new node Ready" half of the chain.
 * Mix     : 100% payroll calculate (CPU-heavy POST). Every request is the
 *           expensive code path so per-pod CPU stays pinned above 50% — no
 *           light reads diluting the CPU profile.
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
      // Little's Law at 1200 RPS × 2 s worst-case latency under stress = 2400 VUs
      preAllocatedVUs: 2400,
      maxVUs:          4800,
      stages: [
        { duration: '30s', target: 1200 }, // ramp up
        { duration: '2m',  target: 1200 }, // hold — long enough to push HPA to ceiling and fire CA; new-node Ready may land after ramp-down
        { duration: '30s', target: 0    }, // ramp down
      ],
    },
  },
  thresholds: {
    // Loose — this is a scale-out verification, not an SLO run.
    // Errors during the CA scale-up window are expected while pods are Pending.
    'ca_errors':       ['rate<0.15'],
    'http_req_failed': ['rate<0.15'],
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

  // 100% payroll calculate — every request is the CPU-heavy POST so per-pod
  // CPU stays pinned above the 50% HPA target throughout the run.
  const res = http.post(
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

  errorRate.add(res.status === 0 || res.status >= 500 ? 1 : 0);
}
