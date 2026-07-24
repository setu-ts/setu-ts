/**
 * E2E fixture: a "task module" that loads cleanly but NEVER calls
 * `defineWorkerTask`, so it never signals ready. The pool must time such a
 * task out (via the enqueue-armed timer) rather than hang forever.
 */
// Intentionally no defineWorkerTask() call.
