import type { Theme } from "@mui/material";
import { SOURCES } from "../sources/sources";

/** A source's catalog mark colour, the same everywhere in the app; grey for none. */
export function sourceColor(theme: Theme, id: string | null): string {
  const mark = SOURCES.find((s) => s.id === id)?.markColor;
  return mark === undefined || mark === "default" ? theme.palette.text.disabled : theme.palette[mark].main;
}
