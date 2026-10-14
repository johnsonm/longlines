import { Chip } from "@mui/material";
import type { SourceInfo } from "./sources";

/** The two-letter source mark. A Chip carries the colour: Avatar has no colour prop and sx colours are off limits. */
export function SourceMark({ source, size = "medium" }: { source: SourceInfo; size?: "medium" | "large" }) {
  return (
    <Chip
      aria-hidden
      label={source.mark}
      color={source.markColor}
      variant={source.status === "live" ? "filled" : "outlined"}
      sx={size === "large" ? { height: 56, minWidth: 56, "& .MuiChip-label": { px: 2 } } : undefined}
    />
  );
}
