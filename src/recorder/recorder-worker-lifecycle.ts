export class RecorderWorkerLifecycle {
  private tail: Promise<void> = Promise.resolve();
  private closing = false;

  constructor(private readonly onError: (error: unknown) => void) {}

  queueArm(operation: () => Promise<void>) {
    if (this.closing) return false;
    void this.enqueue(operation);
    return true;
  }

  queueClose(operation: () => Promise<void>) {
    if (this.closing) return this.tail;
    this.closing = true;
    return this.enqueue(operation);
  }

  private enqueue(operation: () => Promise<void>) {
    const queued = this.tail.then(operation);
    this.tail = queued.catch((error) => this.onError(error));
    return this.tail;
  }
}
