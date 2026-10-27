import { Avatar, Chip } from "@mui/material";
import type { SourceInfo } from "./sources";
import aprsLogo from "../assets/sources/aprs.png";
import dxclusterLogo from "../assets/sources/dxcluster.png";
import potaLogo from "../assets/sources/pota.png";
import rbnLogo from "../assets/sources/rbn.png";
import sotawatchLogo from "../assets/sources/sotawatch.png";
import wwbotaLogo from "../assets/sources/wwbota.png";
import wwffLogo from "../assets/sources/wwff.png";

/** Program logos by source id: 128 px squares on an opaque background, so they read in both colour schemes. */
const LOGOS: Record<string, string> = {
  pota: potaLogo,
  sotawatch: sotawatchLogo,
  wwff: wwffLogo,
  wwbota: wwbotaLogo,
  dxcluster: dxclusterLogo,
  aprs: aprsLogo,
  rbn: rbnLogo,
};

/**
 * The source's logo, or its two-letter mark when it has none (planned sources).
 * A Chip carries the mark's colour: Avatar has no colour prop and sx colours are off limits.
 */
export function SourceMark({ source, size = "medium" }: { source: SourceInfo; size?: "medium" | "large" }) {
  const side = size === "large" ? 56 : 32;
  const logo = LOGOS[source.id];
  if (logo) return <Avatar aria-hidden variant="rounded" src={logo} alt="" sx={{ width: side, height: side }} />;
  return (
    <Chip
      aria-hidden
      label={source.mark}
      color={source.markColor}
      variant={source.status === "live" ? "filled" : "outlined"}
      sx={size === "large" ? { height: side, minWidth: side, "& .MuiChip-label": { px: 2 } } : undefined}
    />
  );
}
