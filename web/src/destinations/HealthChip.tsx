import { Chip } from "@mui/material";
import type { Destination } from "../lib/api";

/** Health as SQL reports it; a healthy push destination with blocked member devices shows how many instead. */
export function HealthChip({ health, blocked = 0 }: { health: Destination["health"]; blocked?: number }) {
  if (health === "failing") return <Chip size="small" color="error" label="Failing" />;
  if (health === "paused") return <Chip size="small" variant="outlined" label="Paused" />;
  if (blocked > 0) return <Chip size="small" color="warning" label={`${blocked} device${blocked === 1 ? "" : "s"} blocked`} />;
  return <Chip size="small" color="success" variant="outlined" label="Healthy" />;
}
