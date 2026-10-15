import { Box } from "@mui/material";
import { flagUrl } from "./flags";

/**
 * The flag of the entity cty.dat places a call in, next to the callsign in the
 * profile header. Renders nothing for an entity without a flag.
 */
export function Flag({ country }: { country: string | null | undefined }) {
  const src = flagUrl(country);
  if (!src || !country) return null;
  return <Box component="img" src={src} alt={country} title={country} sx={{ height: 24, width: 32, flexShrink: 0 }} />;
}
