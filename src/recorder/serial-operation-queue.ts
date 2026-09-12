export class SerialOperationQueue {
  private tail = Promise.resolve();
  private accepting = true;

  constructor(private readonly reportError: (error: unknown, fallback: string) => void) {}

  enqueue(operation: () => void | Promise<void>, fallback: string) {
    if (!this.accepting) return false;
    this.tail = this.tail.then(operation).catch((error) => this.reportError(error, fallback));
    return true;
  }

  finish(operation: () => void | Promise<void>, fallback: string) {
    if (!this.accepting) return false;
    this.accepting = false;
    this.tail = this.tail.then(operation).catch((error) => this.reportError(error, fallback));
    return true;
  }

  idle() {
    return this.tail;
  }
}
