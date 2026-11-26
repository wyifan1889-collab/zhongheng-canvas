import "fake-indexeddb/auto";

// localforage performs its driver capability check at module evaluation time.
// Keep the browser-shaped globals in this test-only module so IndexedDB claim
// tests exercise the same initialization path as the app without a DOM shim.
if (typeof window === "undefined") Object.defineProperty(globalThis, "window", { value: { indexedDB: globalThis.indexedDB }, configurable: true });
