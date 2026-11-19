// Node 26 ships localStorage only behind a file flag; the browser-facing suites
// expect a global one. A throwaway in-memory store stands in when the runtime
// provides none, and stays inert when it does.
if (typeof globalThis.localStorage === "undefined") {
  const entries = new Map<string, { value: string }>();
  const storage: Storage = {
    get length() { return entries.size; },
    clear: () => entries.clear(),
    getItem: (key) => entries.get(key)?.value ?? null,
    key: (index) => [...entries.keys()][index] ?? null,
    removeItem: (key) => void entries.delete(key),
    setItem: (key, value) => void entries.set(key, { value: String(value) }),
  };
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
}
