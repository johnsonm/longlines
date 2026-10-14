import { Chip } from "@mui/material";
import type { Destination } from "../lib/api";

export function HealthChip({ health }: { health: Destination["health"] }) {
  if (health === "failing") return <Chip size="small" color="error" label="Failing" />;
  if (health === "paused") return <Chip size="small" variant="outlined" label="Paused" />;
  return <Chip size="small" color="success" variant="outlined" label="Healthy" />;
}
