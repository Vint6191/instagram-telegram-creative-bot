import type { JobQueue } from "./job-queue";
import type { Env } from "./types";

const GLOBAL_QUEUE_NAME = "instagram-creative-global-queue";

export function queueStub(env: Env): JobQueue {
  return env.QUEUE.getByName(GLOBAL_QUEUE_NAME);
}
