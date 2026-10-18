// Keeps the panel's data fresh without piling up requests. One refresh runs at a time; a trigger
// that arrives meanwhile (a focus event, the refresh button) is remembered and answered by a single
// follow-up run, and the next timed refresh is scheduled only after the current one finished. A slow
// answer therefore always has time to be used, however short the interval is.

export class RefreshLoop {
  private running = false
  private again = false
  private stopped = true
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly refresh: () => Promise<void>,
    private readonly intervalMs: number
  ) {}

  /** Starts refreshing now and then every `intervalMs` after each refresh finishes. */
  start(): void {
    this.stopped = false
    this.trigger()
  }

  /** Stops for good: no timer is left, and a refresh still running does not schedule another. */
  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  /** Asks for a refresh as soon as possible, without starting a second one beside a running one. */
  trigger(): void {
    if (this.stopped) return
    if (this.running) {
      this.again = true
      return
    }
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    void this.runOnce()
  }

  private async runOnce(): Promise<void> {
    this.running = true
    this.again = false
    try {
      await this.refresh()
    } catch {
      // The refresh reports its own errors; the loop keeps going.
    } finally {
      this.running = false
    }
    if (this.stopped) return
    if (this.again) {
      void this.runOnce()
      return
    }
    this.timer = setTimeout(() => {
      this.timer = null
      this.trigger()
    }, this.intervalMs)
  }
}
