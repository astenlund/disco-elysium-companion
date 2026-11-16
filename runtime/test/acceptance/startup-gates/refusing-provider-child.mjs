// The provider child of gate-main.ts's refusing provider: it answers once and exits with failure, so every start is refused.
process.stdout.write('refused' + String.fromCharCode(10));
process.exitCode = 1;
