process.stdout.write('ready' + String.fromCharCode(10));
process.stdin.resume();
process.stdin.once('end', () => { process.exitCode = 0; });
