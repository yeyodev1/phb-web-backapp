// Ejecuta trabajo después de responder.
// En Vercel usa waitUntil del contexto de la petición (el mismo mecanismo que
// @vercel/functions), para que la función no se congele antes de terminar.
// En local (o si no hay contexto) es un simple fire-and-forget.

const REQUEST_CONTEXT = Symbol.for("@vercel/request-context");

function getWaitUntil(): ((p: Promise<unknown>) => void) | undefined {
  try {
    const ctx = (globalThis as any)[REQUEST_CONTEXT]?.get?.();
    return typeof ctx?.waitUntil === "function" ? ctx.waitUntil : undefined;
  } catch {
    return undefined;
  }
}

export function hasWaitUntil(): boolean {
  return !!getWaitUntil();
}

export function runInBackground(task: () => Promise<unknown>, label = "background"): void {
  const promise = Promise.resolve()
    .then(task)
    .catch((err) => console.error(`[${label}]`, err?.message || err));
  const waitUntil = getWaitUntil();
  if (waitUntil) waitUntil(promise);
}
