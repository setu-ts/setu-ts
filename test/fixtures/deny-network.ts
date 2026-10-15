/** Test preload: the real registry gate must report an unreachable registry as a visible skip. */
globalThis.fetch = () => Promise.reject(new Error('offline negative control'));
