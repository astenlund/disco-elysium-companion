import { takeInstanceGuard } from '../../src/guard.ts';

const candidate = process.argv[2];
if (candidate === undefined) { throw new Error('Guard candidate required.'); }
const guard = await takeInstanceGuard(candidate, () => { process.exitCode = 1; });
process.stdout.write(guard.held ? 'held\n' : 'failed\n');
process.stdin.resume();
await new Promise<void>(resolve => { process.stdin.once('end', resolve); });
await guard.release();
