export interface XrLaunchAttempt {
  id: number;
  completion: Promise<boolean>;
  owner: boolean;
  signal: AbortSignal;
}

interface PendingXrLaunch {
  controller: AbortController;
  completion: Promise<boolean>;
  id: number;
  resolve(started: boolean): void;
}

export class XrLaunchSingleFlight {
  private nextLaunchId = 1;
  private pendingLaunch: PendingXrLaunch | null = null;

  get pending() {
    return this.pendingLaunch !== null;
  }

  begin(): XrLaunchAttempt {
    if (this.pendingLaunch) {
      return {
        id: this.pendingLaunch.id,
        completion: this.pendingLaunch.completion,
        owner: false,
        signal: this.pendingLaunch.controller.signal,
      };
    }

    const controller = new AbortController();
    const id = this.nextLaunchId;
    this.nextLaunchId += 1;
    let resolveLaunch!: (started: boolean) => void;
    const completion = new Promise<boolean>((resolve) => {
      resolveLaunch = resolve;
    });
    this.pendingLaunch = {
      controller,
      completion,
      id,
      resolve: resolveLaunch,
    };
    return {
      id,
      completion,
      owner: true,
      signal: controller.signal,
    };
  }

  isCurrent(attempt: Pick<XrLaunchAttempt, "id">) {
    return this.pendingLaunch?.id === attempt.id;
  }

  settle(attempt: Pick<XrLaunchAttempt, "id">, started: boolean) {
    const launch = this.pendingLaunch;
    if (!launch || launch.id !== attempt.id) return false;
    this.pendingLaunch = null;
    launch.resolve(started);
    return true;
  }

  cancel() {
    const launch = this.pendingLaunch;
    if (!launch) return false;
    this.pendingLaunch = null;
    launch.controller.abort();
    launch.resolve(false);
    return true;
  }
}
