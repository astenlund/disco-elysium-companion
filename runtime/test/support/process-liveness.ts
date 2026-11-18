/** True unless the process is positively gone; any probe failure other than a missing process counts as running. */
export function processRunning(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}
