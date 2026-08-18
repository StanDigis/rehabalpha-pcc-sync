/**
 * Token-bucket limiter applied to outbound PCC calls.
 *
 * PointClickCare does not publish numeric rate limits; their terms reserve the right to
 * throttle or suspend an application whose traffic threatens platform stability. That makes
 * self-imposed pacing a requirement rather than an optimisation, because the penalty for
 * getting it wrong is not a 429 for one request but a suspended integration for every tenant.
 *
 * A bucket rather than a fixed delay because the real traffic shape is bursty: a facility's
 * morning census sweep wants to spend its allowance quickly, while the steady webhook trickle
 * should not be queued behind it. `capacity` bounds the burst, `refillPerSecond` bounds the
 * sustained rate.
 */
export type RateLimiterOptions = {
  capacity: number;
  refillPerSecond: number;
  /** Injected for deterministic tests. */
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
};

const defaultSleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

export class TokenBucketRateLimiter {
  private tokens: number;
  private lastRefillAt: number;
  /** Serialises waiters so throughput stays FIFO instead of favouring whoever wakes first. */
  private queue: Promise<void> = Promise.resolve();

  private readonly capacity: number;
  private readonly refillPerSecond: number;
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;

  constructor({
    capacity,
    refillPerSecond,
    now = Date.now,
    sleep = defaultSleep,
  }: RateLimiterOptions) {
    if (capacity <= 0 || refillPerSecond <= 0) {
      throw new RangeError('Rate limiter capacity and refill rate must both be positive');
    }
    this.capacity = capacity;
    this.refillPerSecond = refillPerSecond;
    this.now = now;
    this.sleep = sleep;
    this.tokens = capacity;
    this.lastRefillAt = now();
  }

  private refill(): void {
    const currentTime = this.now();
    const elapsedSeconds = Math.max(0, (currentTime - this.lastRefillAt) / 1000);
    this.tokens = Math.min(this.capacity, this.tokens + elapsedSeconds * this.refillPerSecond);
    this.lastRefillAt = currentTime;
  }

  async acquire(): Promise<void> {
    const run = this.queue.then(async () => {
      for (;;) {
        this.refill();
        if (this.tokens >= 1) {
          this.tokens -= 1;
          return;
        }
        const deficit = 1 - this.tokens;
        await this.sleep(Math.ceil((deficit / this.refillPerSecond) * 1000));
      }
    });

    // Keep the chain alive even if a waiter rejects, otherwise one failure wedges the bucket.
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );

    return run;
  }

  /** Exposed for the sync-health metrics, so operators can see how close to the limit we run. */
  availableTokens(): number {
    this.refill();
    return this.tokens;
  }
}
