export interface ControllerRoute {
  session: string;
  pairCode?: string;
}

const SESSION_SHAPE = /^[A-Z0-9-]{4,128}$/i;

/** Keep hydration identical, then use this visit's URL rather than a cached page's route props. */
export function resolveControllerRoute(rendered: ControllerRoute, search: string | undefined): ControllerRoute & { ready: boolean } {
  if (search === undefined) return { ...rendered, ready: false };
  const query = new URLSearchParams(search);
  const requested = query.get("session")?.trim();
  return {
    session: requested && SESSION_SHAPE.test(requested) ? requested : "101LAB",
    pairCode: query.get("pair") || undefined,
    ready: true,
  };
}
