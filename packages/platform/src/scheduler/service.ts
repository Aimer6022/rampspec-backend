import {
  DEFAULT_MISFIRE_POLICY,
  MAX_MISFIRE_CATCH_UP,
  isMisfirePolicy,
  resolveMisfire,
  type MisfirePolicy,
} from "./recurrence.js";

export {
  DEFAULT_MISFIRE_POLICY,
  MAX_MISFIRE_CATCH_UP,
  misfirePolicies,
  type MisfirePolicy,
} from "./recurrence.js";

export interface MisfireRecord {
  readonly auditMetadata: Readonly<
    Record<string, boolean | number | string>
  >;
  readonly capped: boolean;
  readonly executionsDue: number;
  readonly missedOccurrences: number;
  readonly policy: MisfirePolicy;
  readonly recoveredAt: string;
}

export interface Schedule {
  readonly enabled: boolean;
  readonly id: string;
  readonly intervalSeconds: number;
  readonly lastMisfire: MisfireRecord | null;
  readonly maxCatchUp: number;
  readonly misfirePolicy: MisfirePolicy;
  readonly nextRunAt: string;
}

export interface MisfireRecovery {
  readonly auditMetadata: Readonly<
    Record<string, boolean | number | string>
  >;
  readonly capped: boolean;
  readonly executionsDue: number;
  readonly missedOccurrences: number;
  readonly nextRunAt: string;
  readonly policy: MisfirePolicy;
  readonly scheduleId: string;
}

export interface ScheduleOptions {
  readonly maxCatchUp?: number;
  readonly misfirePolicy?: MisfirePolicy;
}

export class ScheduleService {
  private readonly schedules = new Map<string, Schedule>();
  private readonly clock: () => Date;

  constructor(options: { readonly clock?: () => Date } = {}) {
    this.clock = options.clock ?? (() => new Date());
  }

  create(
    id: string,
    intervalSeconds: number,
    options: ScheduleOptions = {},
  ): Schedule {
    if (
      !/^[a-z][a-z0-9_-]{2,63}$/u.test(id) ||
      !Number.isInteger(intervalSeconds) ||
      intervalSeconds < 60 ||
      intervalSeconds > 31_536_000
    ) {
      throw new Error("Invalid schedule.");
    }
    const misfirePolicy = options.misfirePolicy ?? DEFAULT_MISFIRE_POLICY;
    if (!isMisfirePolicy(misfirePolicy)) {
      throw new Error("Invalid misfire policy.");
    }
    const maxCatchUp = options.maxCatchUp ?? MAX_MISFIRE_CATCH_UP;
    if (
      !Number.isInteger(maxCatchUp) ||
      maxCatchUp < 1 ||
      maxCatchUp > MAX_MISFIRE_CATCH_UP
    ) {
      throw new Error("Invalid misfire catch-up limit.");
    }
    const nextRunAt = new Date(
      this.clock().getTime() + intervalSeconds * 1000,
    ).toISOString();
    const schedule = Object.freeze({
      enabled: true,
      id,
      intervalSeconds,
      lastMisfire: null,
      maxCatchUp,
      misfirePolicy,
      nextRunAt,
    });
    this.schedules.set(id, schedule);
    return schedule;
  }

  get(id: string): Schedule {
    const schedule = this.schedules.get(id);
    if (!schedule) throw new Error("Schedule not found.");
    return schedule;
  }

  disable(id: string): Schedule {
    const schedule = this.get(id);
    const updated = Object.freeze({ ...schedule, enabled: false });
    this.schedules.set(id, updated);
    return updated;
  }

  /**
   * Applies the schedule's misfire policy after downtime. Deterministic for
   * a given clock reading: the same recovery instant always yields the same
   * missed count, executions due, and next run. The returned audit metadata
   * records the selected policy and missed occurrence count for the audit
   * trail; the service itself executes nothing, so catch-up stays bounded
   * and cannot burst. A second recovery at the same instant is a no-op:
   * the next run already lies in the future, so zero occurrences are missed.
   */
  recover(id: string, now: Date = this.clock()): MisfireRecovery {
    const schedule = this.get(id);
    if (!schedule.enabled) throw new Error("Schedule is disabled.");
    const resolution = resolveMisfire({
      firstDueAt: new Date(schedule.nextRunAt),
      intervalSeconds: schedule.intervalSeconds,
      maxCatchUp: schedule.maxCatchUp,
      now,
      policy: schedule.misfirePolicy,
    });
    const auditMetadata = Object.freeze({
      executions_due: resolution.executionsDue,
      misfire_capped: resolution.capped,
      misfire_policy: resolution.policy,
      missed_occurrences: resolution.missedOccurrences,
      schedule_id: schedule.id,
    });
    const record = Object.freeze({
      auditMetadata,
      capped: resolution.capped,
      executionsDue: resolution.executionsDue,
      missedOccurrences: resolution.missedOccurrences,
      policy: resolution.policy,
      recoveredAt: now.toISOString(),
    });
    this.schedules.set(
      id,
      Object.freeze({
        ...schedule,
        lastMisfire: record,
        nextRunAt: resolution.nextRunAt.toISOString(),
      }),
    );
    return Object.freeze({
      auditMetadata,
      capped: resolution.capped,
      executionsDue: resolution.executionsDue,
      missedOccurrences: resolution.missedOccurrences,
      nextRunAt: resolution.nextRunAt.toISOString(),
      policy: resolution.policy,
      scheduleId: schedule.id,
    });
  }
}
