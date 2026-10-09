const recordName = /^event-([0-9]{16})\.json$/;

export function outboxRecordSequence(name: string): number | null {
  const match = recordName.exec(name);
  if (match === null) { return null; }
  const sequence = Number(match[1]);
  return Number.isSafeInteger(sequence) && sequence >= 1 ? sequence : null;
}
