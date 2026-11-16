/** The counted healthy attachment of the startup objective: owner, fresh, ready safety, healthy journal, running watcher, ready provider. */
export function healthy(observed: Readonly<Record<string, unknown>>): boolean {
  return observed['consumer'] === 'owner' && observed['freshness'] === 'fresh' && observed['safety'] === 'ready'
    && observed['journal'] === 'healthy' && observed['watcher'] === 'running' && observed['provider'] === 'ready';
}
