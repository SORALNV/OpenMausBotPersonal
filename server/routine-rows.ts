// Row-level utilities for routines and their runs: the clone every read of the store's rows hands out, and the
// request-receipt key an exactly-once recovery is matched by.
import { cloneAttachments } from "./routine-attachments.ts";
import { cloneSchedule } from "./routine-schedules.ts";
import type { Routine, RoutineRequestReceipt, RoutineRun } from "./routines.ts";

export type RoutineRequestOwner = Pick<RoutineRequestReceipt, "requestId" | "messageId" | "botId" | "threadId">;

export function routineRequestOwnerKey(owner: RoutineRequestOwner): string {
  return JSON.stringify([owner.requestId, owner.messageId, owner.botId, owner.threadId]);
}

export function cloneRoutine(routine: Routine): Routine {
  return {
    ...routine,
    schedule: cloneSchedule(routine.schedule),
    attachments: cloneAttachments(routine.attachments),
  };
}

export function cloneRun(run: RoutineRun): RoutineRun {
  return {
    ...run,
    attachments: cloneAttachments(run.attachments),
    denials: run.denials ? [...run.denials] : undefined,
  };
}
