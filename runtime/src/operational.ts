import type { CoreResult, CoreWarning, PublishReceipt } from './core-client.ts';

export interface OperationalStatus { readonly state: 'unknown' | 'current'; readonly warnings: readonly CoreWarning[] }
const reaperCode = 'pipeline-reaper-discovery-limit-exceeded';
const cleanupCode = 'pipeline-cleanup-degraded';

export class OperationalObservation {
  private retainedRoots = new Set<'tmp' | 'state'>();
  private value: OperationalStatus = Object.freeze({ state: 'unknown', warnings: Object.freeze([]) });

  get current(): OperationalStatus { return this.value; }

  unavailable(): boolean { return this.replace('unknown', this.value.warnings); }

  observe(result: CoreResult<PublishReceipt>): boolean {
    const warnings = result.success ? result.value.warnings : result.warnings;
    const clean = result.success && !warnings.some(warning => warning.code === cleanupCode);
    const roots = new Set<'tmp' | 'state'>();
    for (const warning of warnings) {
      if (warning.code === reaperCode) {
        if (warning.detail !== 'tmp' && warning.detail !== 'state') { throw new Error('Operational warning contains an invalid reaper root.'); }
        roots.add(warning.detail);
      }
    }
    if (clean) { this.retainedRoots = roots; }
    else { for (const root of roots) { this.retainedRoots.add(root); } }
    const merged = [...warnings];
    for (const root of this.retainedRoots) {
      if (!merged.some(warning => warning.code === reaperCode && warning.detail === root)) { merged.push({ code: reaperCode, detail: root }); }
    }
    return this.replace(clean ? 'current' : 'unknown', merged);
  }

  private replace(state: OperationalStatus['state'], warnings: readonly CoreWarning[]): boolean {
    const seen = new Set<string>();
    const frozen = warnings.filter(warning => {
      const key = JSON.stringify([warning.code, warning.detail]);
      if (seen.has(key)) { return false; }
      seen.add(key);
      return true;
    }).map(warning => Object.freeze({ ...warning }));
    if (state === this.value.state && JSON.stringify(frozen) === JSON.stringify(this.value.warnings)) { return false; }
    this.value = Object.freeze({ state, warnings: Object.freeze(frozen) });
    return true;
  }
}

export function operationallyCurrent(value: OperationalStatus): boolean {
  return value.state === 'current' && !value.warnings.some(warning => warning.code === reaperCode);
}
