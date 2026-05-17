// Shim for the `server-only` package under vitest. The real package
// throws on import in any non-server runtime; tests don't run under
// Next's server runtime, so we replace it with an empty module. The
// build-time guarantee (server-only imports break the client bundle)
// is enforced by Next at build time, not by tests.
export {};
