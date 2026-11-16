// Prints a run-gates.ts report: one line per run with its gate verdict, exit code, attach time, attach-time health and its inputs, the time
// healthy status arrived when the run awaited it, and the turn outcome. With a label, prints that run's turn timeline too.
// Usage: node summarize.mjs <report.json> [label]
import { readFileSync } from 'node:fs';

const [file, label] = process.argv.slice(2);
const report = JSON.parse(readFileSync(file, 'utf8'));
const seconds = value => value === null || value === undefined ? '-' : (value / 1000).toFixed(1);
console.log(`root=${report.root} started=${report.startedAt} finished=${report.finishedAt ?? '-'} sourcesUnchanged=${report.sourcesUnchanged ?? '-'} stagedUnchanged=${report.stagedUnchanged ?? '-'}`);
for (const run of report.runs) {
  if (run.skipped) { continue; }
  const a = run.attached;
  const turn = run.result?.turn;
  console.log([run.label.padEnd(50), `verdict=${run.verdict ?? '-'}`, `code=${run.code}`, run.timedOut ? 'TIMED-OUT' : '', `attach=${seconds(run.attachedMs)}`,
    a === null ? 'no-attach' : `healthy=${a.healthy} fresh=${a.freshness}/${a.freshnessReason} safety=${a.safety}/${a.correction} provider=${a.provider} watcher=${a.watcher}`,
    run.result?.healthyAtMs !== undefined ? `healthyAt=${seconds(run.result.healthyAtMs)}` : '',
    turn ? `turn=${turn.outcome} ack=${turn.acknowledged} after=${turn.after?.safety}/${turn.after?.correction}` : '',
    run.result?.status === 'failed' ? `failed=${run.result.name}: ${run.result.message}` : '',
    run.result?.status === 'returned' ? `returned=${run.result.code} ${JSON.stringify(run.result.lines)}` : ''].filter(part => part !== '').join(' '));
}
if (label !== undefined) {
  const turn = report.runs.find(entry => entry.label === label)?.result?.turn;
  if (turn === undefined || turn === null || turn.submittedAtMs === undefined) { console.log(`No turn timeline recorded for ${label}.`); process.exit(1); }
  const at = value => `${((value - turn.submittedAtMs) / 1000).toFixed(1)}s`;
  console.log(`${label}: outcome=${turn.outcome} turn=${seconds(turn.turnMs)} acknowledged=${turn.acknowledged}`);
  for (const event of turn.hostEvents ?? []) {
    if (event.type !== 'status.changed') { console.log(`  event ${at(event.processMs)} ${event.type}${event.code ? ` ${event.code}` : ''}${event.reason ? ` ${event.reason}` : ''}`); }
  }
  let previous = '';
  for (const sample of turn.samples ?? []) {
    const state = `fresh=${sample.freshness}/${sample.freshnessReason} safety=${sample.safety}/${sample.correction} provider=${sample.provider}`;
    if (state !== previous) { console.log(`  sample ${at(sample.processMs)} ${state}`); previous = state; }
  }
}
