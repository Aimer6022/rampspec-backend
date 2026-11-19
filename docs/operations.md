# Operations

Liveness is exposed at `/health`; dependency readiness is exposed at `/ready`. Review trace IDs and audit events together when investigating a run. Treat evidence as immutable and use the retention planner before deleting expired artifacts.

Deploy only immutable image digests through the protected staging or production environment. Verify backup manifests before restores and stop traffic when tenant isolation, readiness, or signature checks fail.

## Incoming webhook signatures

The webhook service accepts `POST /v1/webhooks/incoming` only from senders
that sign the raw request body. Configure the signing secret as a secret
reference; raw secrets must never appear in configuration or logs:

```
WEBHOOK_SIGNING_SECRET_REF=vault://webhooks/signing-secret
```

Senders must include both headers:

```
X-RampSpec-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256>
X-RampSpec-Delivery-Id: <opaque delivery identifier>
```

The signature is HMAC-SHA256 over `<timestamp>.<delivery-id>.<raw body>`.
Verification rejects, with `401` and a reason code, any request that is
missing or malformed, has a timestamp more than 300 seconds from the server
clock in either direction, fails the constant-time signature comparison, or
reuses a delivery ID seen inside the tolerance window. Only requests that
pass every check reach event processing; failed attempts never poison the
replay store. Rotate the signing secret by updating the secret reference and
restarting the webhook service. Rejection responses contain only the reason
code (`missing-signature`, `malformed-signature`, `missing-delivery-id`,
`malformed-delivery-id`, `stale-timestamp`, `invalid-signature`,
`replayed-delivery`); never log request bodies or secrets when investigating
a rejection.

## Scheduled-run misfire policy

When the scheduler is down, runs whose scheduled time passes are missed. On
recovery, `ScheduleService.recover` applies the schedule's misfire policy
deterministically for the recovery instant:

- `skip` (default): missed runs are dropped; the next run is the first
  occurrence after recovery. No replayed execution is ever created.
- `run-once`: exactly one execution is due, however many occurrences were
  missed; the next run is the first occurrence after recovery.
- `catch-up`: each missed occurrence is due, bounded by the schedule's
  `maxCatchUp` (1–10, default 10). When more occurrences were missed than
  the limit, the recovery is flagged `capped: true` and the excess is
  dropped, never queued. Catch-up therefore cannot create an unreviewed
  burst of executions after a long outage.

Recovery is idempotent: repeating it at the same instant reports zero
missed occurrences because the next run already lies in the future.
Disabled schedules refuse recovery. Every recovery records
`lastMisfire` on the schedule and returns audit metadata
(`misfire_policy`, `missed_occurrences`, `executions_due`,
`misfire_capped`, `schedule_id`) for the audit trail; the durable record
lives in `rampspec.schedule_misfires` (migration 0010). Changing a
schedule's misfire policy requires the `schedule.write` action
(maintainer and above); reading schedule state requires `schedule.read`.
