// Follows a run-gates.ts log and prints one line per event worth acting on: each run's end, a run timeout, a settling run
// that did not end with ready safety, an error-looking line, a stale log (no write for longer than any run's deadline), and
// the driver's exit line, after which it exits. Usage: node watch-log.mjs <log> [staleMs]
import { existsSync, readFileSync, statSync } from 'node:fs';

const [log, staleArg] = process.argv.slice(2);
const staleMs = Number(staleArg ?? 480000);
const newline = String.fromCharCode(10);
let offset = 0;
let staleReported = false;
let lastChange = Date.now();

function report(text) { process.stdout.write(text + newline); }

function scan() {
  if (!existsSync(log)) { return false; }
  const content = readFileSync(log, 'utf8');
  if (content.length > offset) {
    lastChange = Date.now();
    staleReported = false;
    const fresh = content.slice(offset);
    offset = content.length;
    for (const line of fresh.split(newline)) {
      const text = line.trim();
      if (text === '') { continue; }
      if (text.startsWith('exit=')) { report(`driver exited: ${text}`); return true; }
      if (/"event":"(end|timeout|unsettled)"/.test(text) || text.includes('sourcesUnchanged')) { report(text); continue; }
      if (/error|exception|assert/i.test(text) && !text.includes('"event":"start"')) { report(`problem: ${text.slice(0, 400)}`); }
    }
  }
  const quietMs = Date.now() - Math.max(lastChange, statSync(log).mtimeMs);
  if (!staleReported && quietMs > staleMs) { staleReported = true; report(`STALE: no log write for ${Math.round(quietMs / 1000)} s`); }
  return false;
}

const timer = setInterval(() => { try { if (scan()) { clearInterval(timer); } } catch (error) { report(`watcher error: ${error.message}`); } }, 2000);
