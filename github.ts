import type { JobQueue } from "./job-queue";
import type { Env } from "./types";

export function queueStub(env: Env): JobQueue {
  return env.QUEUE.getByName("instagram-creative-global-queue");
}
