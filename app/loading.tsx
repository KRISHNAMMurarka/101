/**
 * A quiet placeholder while a route's code arrives. Deliberately empty of text: a spinner labelled
 * "Loading" tells a player nothing they cannot already see, and a flash of copy on a fast connection
 * reads as a fault.
 */
export default function Loading() {
  return <div className="route-loading" aria-hidden="true" />;
}
