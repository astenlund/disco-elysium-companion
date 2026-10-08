const mode = process.argv[2];
if (mode === 'arguments') {
  process.stdout.write(JSON.stringify(process.argv.slice(3)));
  process.stderr.write('diagnostic');
} else if (mode === 'echo') {
  process.stdin.pipe(process.stdout);
} else if (mode === 'overflow') {
  process.stdout.write('x'.repeat(70_000));
} else if (mode === 'wait') {
  setInterval(() => {}, 1000);
} else {
  process.exitCode = 1;
}
