export type Release = () => void;

/** FIFO per-key mutex, modelling Postgres row locks (FOR UPDATE / SKIP LOCKED). */
export class KeyedMutex {
  readonly #tails = new Map<string, Promise<void>>();

  async acquire(key: string): Promise<Release> {
    const previous = this.#tails.get(key) ?? Promise.resolve();
    let release: Release = () => undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.#tails.set(key, tail);
    await previous;
    return () => {
      if (this.#tails.get(key) === tail) this.#tails.delete(key);
      release();
    };
  }

  tryAcquire(key: string): Release | undefined {
    if (this.#tails.has(key)) return undefined;
    let release: Release = () => undefined;
    const tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#tails.set(key, tail);
    return () => {
      if (this.#tails.get(key) === tail) this.#tails.delete(key);
      release();
    };
  }
}
