import { Link } from "@mui/material";
import { Link as RouterLink } from "react-router";
import { referencePath } from "./paths";

/**
 * A reference linked to its page, for programs with pages (POTA, SOTA, WWFF);
 * a WWBOTA bunker or an IOTA island stays plain text. `program` is a payload's
 * name ("POTA") or the route's ("pota").
 */
export function ReferenceLink({ program, reference }: { program: string; reference: string }) {
  const path = referencePath(program, reference);
  if (!path) return <>{reference}</>;
  return <Link component={RouterLink} to={path} underline="hover">{reference}</Link>;
}
