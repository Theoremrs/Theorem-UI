// SOURCING: hand-rolled over the platform's AbortController, as the frame
// connections (src/lib/blocks/sandbox/) own their listeners. One scope owns
// everything one running instance set up, so replacing the instance can end
// all of it, and a message from the old instance can be told from the new.

type Cleanup = () => void

/** What one running instance owns, and the generation its messages carry. */
export class InstanceScope {
  private cleanups: Cleanup[] = []
  private done = false
  readonly signal: AbortSignal
  private readonly abort = new AbortController()

  constructor(
    readonly instanceId: string,
    /** The release this instance runs. */
    readonly releaseId: string,
  ) {
    this.signal = this.abort.signal
  }

  get disposed() {
    return this.done
  }

  /** Keeps something to undo on disposal; undone at once if already disposed. */
  own(cleanup: Cleanup): void {
    if (this.done) cleanup()
    else this.cleanups.push(cleanup)
  }

  /** A listener removed on disposal. */
  listen(
    target: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>,
    type: string,
    listener: EventListenerOrEventListenerObject,
  ): void {
    target.addEventListener(type, listener, { signal: this.signal })
    this.own(() => target.removeEventListener(type, listener))
  }

  interval(run: () => void, ms: number): void {
    const id = setInterval(() => this.guard(run)(), ms)
    this.own(() => clearInterval(id))
  }

  timeout(run: () => void, ms: number): void {
    const id = setTimeout(() => this.guard(run)(), ms)
    this.own(() => clearTimeout(id))
  }

  /** A function that does nothing once this instance is replaced. */
  guard<TArgs extends unknown[]>(
    run: (...args: TArgs) => void,
  ): (...args: TArgs) => void {
    return (...args) => {
      if (!this.done) run(...args)
    }
  }

  /** Ends everything the instance owns. Idempotent; each cleanup runs once. */
  dispose(): { failures: unknown[] } {
    const failures: unknown[] = []
    if (this.done) return { failures }
    this.done = true
    this.abort.abort()
    for (const cleanup of this.cleanups.splice(0).reverse()) {
      try {
        cleanup()
      } catch (error) {
        failures.push(error)
      }
    }
    return { failures }
  }
}

/**
 * The one active scope per module. Putting a new one in place disposes the old,
 * and a message is accepted only if it names the scope now in place.
 */
export class ActiveInstances {
  private readonly scopes = new Map<string, InstanceScope>()

  /** Makes `next` the active instance of `identity`; returns what disposing the old one gave. */
  replace(identity: string, next: InstanceScope): { failures: unknown[] } {
    const old = this.scopes.get(identity)
    this.scopes.set(identity, next)
    return old ? old.dispose() : { failures: [] }
  }

  remove(identity: string): { failures: unknown[] } {
    const old = this.scopes.get(identity)
    this.scopes.delete(identity)
    return old ? old.dispose() : { failures: [] }
  }

  current(identity: string): InstanceScope | undefined {
    return this.scopes.get(identity)
  }

  /** Whether a message from `scope` may reach the module's current instance. */
  accepts(identity: string, scope: InstanceScope): boolean {
    return !scope.disposed && this.scopes.get(identity) === scope
  }
}

export const activeInstances = new ActiveInstances()
