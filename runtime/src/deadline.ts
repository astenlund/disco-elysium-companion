export class DeadlineExceededError extends Error {
  override readonly name = 'DeadlineExceededError';
}

// One monotonic deadline follows an operation through every queue and helper.
// Consumers may shorten a child allowance, never renew the enclosing budget.
export class Deadline {
  private readonly expiresAt: number;
  private readonly clock: () => number;

  private constructor(expiresAt: number, clock: () => number) { this.expiresAt = expiresAt; this.clock = clock; }

  static after(milliseconds: number, clock: () => number = () => performance.now()): Deadline {
    return Deadline.fromStart(clock(), milliseconds, clock);
  }

  static fromStart(startedAt: number, milliseconds: number, clock: () => number = () => performance.now()): Deadline {
    if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0 || milliseconds > 3_600_000) { throw new RangeError('Invalid operation deadline.'); }
    if (!Number.isFinite(startedAt) || !Number.isFinite(startedAt + milliseconds)) { throw new RangeError('Invalid operation start time.'); }
    return new Deadline(startedAt + milliseconds, clock);
  }

  remaining(maximum = 30000): number {
    if (!Number.isSafeInteger(maximum) || maximum <= 0) { throw new RangeError('Invalid child deadline.'); }
    const remaining = Math.floor(this.expiresAt - this.clock());
    if (remaining <= 0 || !Number.isFinite(remaining)) { throw new DeadlineExceededError('Operation deadline expired.'); }
    return Math.min(maximum, remaining);
  }

  check(): void { this.remaining(); }
}
