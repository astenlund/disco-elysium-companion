import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ProcessSupervisor } from '../../src/process.ts';

const candidate = process.argv[2];
if (candidate === undefined) { throw new Error('Supervisor scope required.'); }
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const childScript = fileURLToPath(new URL('./process-child.ts', import.meta.url));
const supervisor = await ProcessSupervisor.create(candidate);
const child = supervisor.spawn('watcher', { command: process.execPath, args: [childScript, 'wait'], cwd: root });
child.stdout.resume();
child.stderr.resume();
const identity = await child.ready;
process.stdout.write(JSON.stringify({ job: supervisor.jobName('watcher'), identity }) + '\n');
process.stdin.resume();
await new Promise<void>(resolve => process.stdin.once('end', resolve));
process.exit(0);
