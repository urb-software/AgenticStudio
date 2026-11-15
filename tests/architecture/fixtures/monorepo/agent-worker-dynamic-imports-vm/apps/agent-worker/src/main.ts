// A literal dynamic import passes the worker lint; the gate must still see it.
export const load = async (code: string) => (await import('node:vm')).runInThisContext(code);
