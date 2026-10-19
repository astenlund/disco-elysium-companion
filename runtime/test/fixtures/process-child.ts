import { spawn } from 'node:child_process';

const mode = process.argv[2];
if (mode === 'arguments') {
  process.stdout.write(JSON.stringify(process.argv.slice(3)));
  process.stderr.write('diagnostic');
} else if (mode === 'echo') {
  process.stdin.pipe(process.stdout);
} else if (mode === 'environment') {
  process.stdout.write(JSON.stringify({ TEMP: process.env.TEMP ?? null, APPDATA: process.env.APPDATA ?? null }));
} else if (mode === 'exit') {
  process.exitCode = Number(process.argv[3]);
} else if (mode === 'overflow') {
  process.stdout.write('x'.repeat(70_000));
} else if (mode === 'wait') {
  setInterval(() => {}, 1000);
} else if (mode === 'wait-tree') {
  const descendant = spawn(process.execPath, [process.argv[1]!, 'wait'], { stdio: 'ignore' });
  process.stdout.write('ready');
  setInterval(() => {}, 1000);
} else {
  process.exitCode = 1;
}
