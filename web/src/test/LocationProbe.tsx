import { useLocation } from "react-router";

/** Renders the current location so tests can assert where navigation went. */
export function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location" data-state={JSON.stringify(location.state ?? null)} data-search={location.search}>{location.pathname}</div>;
}
