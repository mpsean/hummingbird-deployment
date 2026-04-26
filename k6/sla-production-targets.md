# Hummingbird — Production SLA Test Targets

This document captures the **original application-performance test parameters** designed for
production-class hardware (e.g. m5.xlarge or equivalent — 4 vCPU / 16 GiB per node).

The current scenario files have been adjusted for **infrastructure verification on t3.medium**
(2 vCPU burstable, 4 GiB). Use this file as the reference when upgrading node types or
validating that optimised application code meets the original SLAs.

---

## How to restore a scenario to production targets

Replace the `scenarios` + `thresholds` + `ext` blocks in the relevant script with the
configuration shown below, keeping all other logic (login, request functions, etc.) unchanged.

---

## Scenario 00 — Regular Load (Steady-State Baseline)

**Intent:** Validate the system handles routine traffic without autoscaling. No HPA event
should fire during this run.

```js
export const options = {
  scenarios: {
    ordinary_working_day: {
      executor:        'ramping-arrival-rate',
      startRate:       0,
      timeUnit:        '1s',
      preAllocatedVUs: 120,
      maxVUs:          400,
      stages: [
        { duration: '1m', target: 200 }, // ramp to 200 RPS
        { duration: '3m', target: 200 }, // steady state
        { duration: '1m', target: 0   }, // ramp down
      ],
    },
  },
  thresholds: {
    'baseline_list_duration':       ['p(95)<300', 'p(99)<600'],
    'baseline_detail_duration':     ['p(95)<300', 'p(99)<600'],
    'baseline_payroll_duration':    ['p(95)<300', 'p(99)<600'],
    'baseline_attendance_duration': ['p(95)<300', 'p(99)<600'],
    'baseline_errors':              ['rate<0.005'],
    'http_req_failed':              ['rate<0.005'],
  },
  ext: { prometheusRW: { url: __ENV.PROMETHEUS_URL || 'http://prometheus.hmmbird.xyz/api/v1/write', flushPeriod: '5s', staleMarkers: true } },
};
```

**Traffic mix (weighted random):**
- 40 % `GET /api/personnel/employees` (list)
- 25 % `GET /api/personnel/employees/{id}` (detail)
- 20 % `GET /api/payroll/{year}/{month}` (payroll fetch)
- 15 % `GET /api/timeattendance/{year}/{month}/summary` (attendance)

---

## Scenario 01 — Bulk Month-End Payroll Processing

**Intent:** Simulate all HR admins triggering payroll simultaneously. HPA expected to fire.

```js
export const options = {
  scenarios: {
    bulk_payroll: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '2m',  target: 2000  }, // ramp to initial load
        { duration: '30s', target: 10000 }, // spike to peak
        { duration: '5m',  target: 10000 }, // hold peak
        { duration: '2m',  target: 0     }, // ramp down
      ],
    },
  },
  thresholds: {
    'payroll_bulk_duration': ['p(95)<500'],
    'payroll_errors':        ['rate<0.01'],
    'http_req_failed':       ['rate<0.01'],
  },
  ext: { prometheusRW: { url: __ENV.PROMETHEUS_URL || 'http://prometheus.hmmbird.xyz/api/v1/write', flushPeriod: '5s', staleMarkers: true } },
};
```

**Endpoint:** `POST /api/payroll/calculate` with `{ Month, Year, ServiceChargeTotal }`

**Note:** Requires pre-populated employee data per tenant and unique month/year per VU group
to avoid concurrent write deadlocks on `PayrollRecords`.

---

## Scenario 02 — New Tenant Onboarding

**Intent:** Verify the admin API can provision tenant DB schemas at sustained concurrency.
VU count unchanged between original and t3.medium targets.

```js
export const options = {
  scenarios: {
    tenant_onboarding: {
      executor: 'constant-vus',
      vus:      50,
      duration: '5m',
    },
  },
  thresholds: {
    'onboarding_provision_duration': ['p(95)<1000'],
    'onboarding_errors':             ['rate<0.01'],
    'http_req_failed':               ['rate<0.01'],
  },
  ext: { prometheusRW: { url: __ENV.PROMETHEUS_URL || 'http://prometheus.hmmbird.xyz/api/v1/write', flushPeriod: '5s', staleMarkers: true } },
};
```

**Endpoint:** `POST /api/admin/tenants` with `{ subdomain, name }`

---

## Scenario 03 — Seasonal Staff Onboarding / Offboarding

**Intent:** Simulate Thai peak-tourism staff churn at full scale. Cluster Autoscaler expected
to add nodes within the hold phase.

```js
export const options = {
  scenarios: {
    seasonal_staff: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '2m',    target: 1000  }, // warm-up ramp
        { duration: '3m30s', target: 10000 }, // aggressive ramp to peak
        { duration: '30s',   target: 10000 }, // hold peak
        { duration: '2m',    target: 0     }, // ramp down
      ],
    },
  },
  thresholds: {
    'staff_create_duration': ['p(95)<400'],
    'staff_delete_duration': ['p(95)<400'],
    'staff_errors':          ['rate<0.01'],
    'http_req_failed':       ['rate<0.01'],
  },
  ext: { prometheusRW: { url: __ENV.PROMETHEUS_URL || 'http://prometheus.hmmbird.xyz/api/v1/write', flushPeriod: '5s', staleMarkers: true } },
};
```

**Endpoints:** `POST /api/employees` → `DELETE /api/employees/{id}`

---

## Scenario 04 — HPA Trigger Verification

**Intent:** Confirm that 3× baseline load causes the HPA to scale within the 60 s stabilisation
window. First scale-up expected ~60–90 s into the hold phase.

```js
export const options = {
  scenarios: {
    hpa_trigger: {
      executor:        'ramping-arrival-rate',
      startRate:       0,
      timeUnit:        '1s',
      preAllocatedVUs: 600,
      maxVUs:          1200,
      stages: [
        { duration: '1m', target: 600 }, // aggressive ramp — push past HPA CPU threshold
        { duration: '3m', target: 600 }, // hold — sustains pressure past 60 s stabilisation window
        { duration: '1m', target: 0   }, // ramp down
      ],
    },
  },
  thresholds: {
    'hpa_payroll_duration':    ['p(95)<2000'],
    'hpa_list_duration':       ['p(95)<2000'],
    'hpa_attendance_duration': ['p(95)<2000'],
    'hpa_errors':              ['rate<0.05'],
    'http_req_failed':         ['rate<0.05'],
  },
  ext: { prometheusRW: { url: __ENV.PROMETHEUS_URL || 'http://prometheus.hmmbird.xyz/api/v1/write', flushPeriod: '5s', staleMarkers: true } },
};
```

**Traffic mix (CPU-heavy bias to breach 50 % HPA threshold):**
- 50 % `POST /api/payroll/calculate`
- 30 % `GET /api/personnel/employees`
- 20 % `GET /api/timeattendance/{year}/{month}/summary`

---

## Comparison: t3.medium infrastructure targets vs production SLA targets

| Scenario | Metric | t3.medium (current) | Production target |
|---|---|---|---|
| 00 Baseline | Arrival rate | 50 RPS | 200 RPS |
| 00 Baseline | p95 latency | *(removed)* | < 300 ms |
| 00 Baseline | Error rate | < 5% | < 0.5% |
| 01 Payroll Bulk | Peak VUs | 300 | 10 000 |
| 01 Payroll Bulk | p95 latency | *(removed)* | < 500 ms |
| 01 Payroll Bulk | Error rate | < 20% | < 1% |
| 02 Onboarding | Peak VUs | 50 | 50 |
| 02 Onboarding | Provision p95 | < 10 000 ms | < 1 000 ms |
| 02 Onboarding | Error rate | < 5% | < 1% |
| 03 Seasonal Staff | Peak VUs | 2 000 | 10 000 |
| 03 Seasonal Staff | p95 latency | *(removed)* | < 400 ms |
| 03 Seasonal Staff | Error rate | < 30% | < 1% |
| 04 HPA Trigger | Arrival rate | 150 RPS | 600 RPS |
| 04 HPA Trigger | p95 latency | *(removed)* | < 2 000 ms |
| 04 HPA Trigger | Error rate | < 10% | < 5% |
