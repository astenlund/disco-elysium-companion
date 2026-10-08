// A promise-chain queue that runs one task at a time in submission order. A task must not
// enqueue on its own queue and await the result, which would wait on itself.
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private pending = 0;

  run<T>(task: () => Promise<T>): Promise<T> {
    this.pending += 1;
    const result = this.tail.then(task, task).finally(() => { this.pending -= 1; });
    this.tail = result.catch(() => undefined);

    return result;
  }

  get busy(): boolean {
    return this.pending > 0;
  }

  // Resolves once every task submitted so far has settled.
  idle(): Promise<void> {
    return this.tail.then(() => undefined);
  }
}
