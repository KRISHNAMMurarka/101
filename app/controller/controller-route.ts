export interface ControllerRoute {
  session: string;
  pairCode?: string;
  invalidPair?: boolean;
}

const SESSION_SHAPE = /^[A-Z0-9-]{4,128}$/i;

/** Keep hydration identical, then use this visit's URL rather than a cached page's route props. */
export function resolveControllerRoute(rendered: ControllerRoute, search: string | undefined): ControllerRoute & { ready: boolean } {
  if (search === undefined) return { ...rendered, ready: false };
  if (search.length > 8192) return { session: "101LAB", ready: true, invalidPair: true };
  const query = new URLSearchParams(search);
  const requested = query.get("session")?.trim();
  const invalidPair = query.getAll("pair").length > 1 || query.has("pair") && (!query.get("pair") || query.get("pair")!.length > 4096);
  return {
    session: requested && SESSION_SHAPE.test(requested) ? requested : "101LAB",
    pairCode: invalidPair ? undefined : query.get("pair") || undefined,
    ...(invalidPair ? { invalidPair: true } : {}),
    ready: true,
  };
}
