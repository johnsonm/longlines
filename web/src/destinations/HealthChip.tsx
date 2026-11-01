import { Chip } from "@mui/material";
import type { Destination } from "../lib/api";

/**
 * Health as SQL reports it; a healthy push destination with blocked member devices shows how many instead.
 * `paused` (a webhook's or Discord destination's auto_disabled_at is set) wins over health: the pause turned it off.
 * `relayOffline` (a Local DX cluster whose relay has no spots stream open) says so instead: its spots are
 * dropped while offline, which is never a failure.
 */
export function HealthChip({ health, blocked = 0, paused = false, relayOffline = false }: {
  health: Destination["health"];
  blocked?: number;
  paused?: boolean;
  relayOffline?: boolean;
}) {
  if (paused) return <Chip size="small" variant="outlined" label="Paused" />;
  if (relayOffline) return <Chip size="small" color="warning" variant="outlined" label="Relay offline" />;
  if (health === "failing") return <Chip size="small" color="error" label="Failing" />;
  if (health === "paused") return <Chip size="small" variant="outlined" label="Paused" />;
  if (blocked > 0) return <Chip size="small" color="warning" label={`${blocked} device${blocked === 1 ? "" : "s"} blocked`} />;
  return <Chip size="small" color="success" variant="outlined" label="Healthy" />;
}
