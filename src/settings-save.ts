/** Serialize full settings snapshots so a slower earlier write cannot win. */
export function serializeWrites<T>(write: (value: T) => Promise<void>) {
  let tail: Promise<void> = Promise.resolve();
  return (value: T): Promise<void> => {
    const request = tail.catch(() => {}).then(() => write(value));
    tail = request;
    // Event handlers may intentionally ignore this promise. Awaited callers
    // still receive the original rejection and can keep their form open.
    void request.catch(() => {});
    return request;
  };
}

/** Rebase edited fields onto current backend settings, including engine changes. */
export function createSettingsWriter<T extends object>(load: () => Promise<T>, write: (value: T) => Promise<void>) {
  let tail: Promise<unknown> = Promise.resolve();
  let unsaved: Partial<T> = {};
  const save = (before: T, after: T): Promise<T> => {
    const patch: Partial<T> = {};
    for (const key of Object.keys(after) as (keyof T)[]) {
      if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) patch[key] = after[key];
    }
    const request = tail.catch(() => {}).then(async () => {
      unsaved = { ...unsaved, ...patch };
      await write({ ...await load(), ...unsaved });
      // Keep failed edits for retry, including a failure to read back the result.
      const canonical = await load();
      unsaved = {};
      return canonical;
    });
    tail = request;
    void request.catch(() => {});
    return request;
  };
  // Call only after the queue drains and a backend reset succeeds.
  return Object.assign(save, { reset: () => { unsaved = {}; } });
}
