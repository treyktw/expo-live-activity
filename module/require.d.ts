// Metro provides CommonJS `require` at runtime; index.ts uses it to load the
// native binding lazily so a missing module never throws at import time.
declare function require(id: string): any;
