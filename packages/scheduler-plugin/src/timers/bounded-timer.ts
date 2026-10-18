/** Timer waits that honour an absolute wall-clock deadline. @module */
import type { IRuntimeServices, TimerHandle } from '@setu-ts/common';

const MAX_TIMER_MS = 2_147_483_647;

/**
 * Arms bounded chunks, checking the clock after every wake before dispatching.
 * An early wake (including a clock step backwards) re-arms for at least 1 ms.
 *
 * @param runtime - Clock and timer services
 * @param dueAtMs - Absolute deadline in epoch milliseconds
 * @param onDue - Called once, only at or after the deadline
 * @param onArm - Receives every live handle so the owner can cancel it
 * @returns The initial timer handle
 * @internal
 */
export function armAt(
  runtime: IRuntimeServices,
  dueAtMs: number,
  onDue: () => void | Promise<void>,
  onArm: (handle: TimerHandle) => void,
): TimerHandle {
  const arm = (minimum: number): TimerHandle => {
    const delay = Math.min(Math.max(minimum, dueAtMs - runtime.now()), MAX_TIMER_MS);
    const handle = runtime.setTimeout(() => {
      if (runtime.now() < dueAtMs) {
        arm(1);
        return;
      }
      return onDue();
    }, delay);
    onArm(handle);
    return handle;
  };
  return arm(0);
}

/**
 * Waits until an absolute deadline using bounded, due-checked timer chunks.
 *
 * @param runtime - Clock and timer services
 * @param dueAtMs - Absolute deadline in epoch milliseconds
 * @returns A promise resolved at or after the deadline, even for long waits
 * @internal
 */
export function sleepUntil(runtime: IRuntimeServices, dueAtMs: number): Promise<void> {
  return new Promise<void>((resolve) => {
    armAt(runtime, dueAtMs, resolve, () => {});
  });
}
