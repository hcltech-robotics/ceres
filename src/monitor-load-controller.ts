export const monitorOverloadOrder = [
  "reduce-render-rate",
  "drop-mirror-frames",
  "disable-history",
  "reduce-dom-rate",
  "suspend-secondary-work",
] as const;

export class MonitorLoadController {
  private slowFrames = 0;
  private healthyFrames = 0;
  stage = 0;

  observe(renderDurationMs: number, socketBufferedAmount: number) {
    const overloaded = renderDurationMs > 12 || socketBufferedAmount > 256 * 1024;
    if (overloaded) {
      this.healthyFrames = 0;
      this.slowFrames += 1;
      if (this.slowFrames >= 4 && this.stage < monitorOverloadOrder.length) {
        this.stage += 1;
        this.slowFrames = 0;
      }
    } else {
      this.slowFrames = 0;
      this.healthyFrames += 1;
      if (this.healthyFrames >= 240 && this.stage > 0) {
        this.stage -= 1;
        this.healthyFrames = 0;
      }
    }
    return this.stage;
  }

  get renderIntervalMs() { return this.stage >= 1 ? 66 : 33; }
  get dropMirrorFrames() { return this.stage >= 2; }
  get keepHistory() { return this.stage < 3; }
  get domIntervalMs() { return this.stage >= 4 ? 500 : 100; }
  get runSecondaryWork() { return this.stage < 5; }
}
