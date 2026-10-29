export type SupervisorReason = 'deadline' | 'capture-overflow' | 'abnormal-exit' | 'result-invalid' | 'termination-unverified';

/** A supervised operation that failed or whose termination could not be proven, by its closed reason. */
export class SupervisorError extends Error {
  override readonly name = 'SupervisorError';
  readonly reason: SupervisorReason;
  constructor(reason: SupervisorReason, message: string, options?: ErrorOptions) { super(message, options); this.reason = reason; }
}
