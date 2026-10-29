import { Alert, Card, CardContent, CardHeader, Chip, Link, MenuItem, Stack, TextField, Typography } from "@mui/material";
import type { RelayToken } from "../lib/api";
import { RELAY_DOWNLOAD_URL } from "../tokens/model";
import { relayChoices, relayLabel } from "./localClusterModel";

export interface LocalClusterRelayCardProps {
  /** The caller's relays, or null while they load. */
  relays: RelayToken[] | null;
  /** Why the relays could not be loaded, or null. */
  loadError: string | null;
  relayId: string | null;
  onChange: (relayId: string) => void;
}

/**
 * The Local DX cluster editor's Relay card (DestinationDxCluster): which
 * paired relay receives the spots, and whether its spots stream is open now
 * (relay_tokens.cluster_connected_at, set only by the sender).
 */
export function LocalClusterRelayCard({ relays, loadError, relayId, onChange }: LocalClusterRelayCardProps) {
  const choices = relayChoices(relays ?? [], relayId);
  const chosen = choices.find((r) => r.id === relayId) ?? null;
  return (
    <Card variant="outlined">
      <CardHeader title="Relay" subheader="Which computer receives the spots" slotProps={{ title: { variant: "subtitle1" } }} />
      <CardContent sx={{ pt: 0 }}>
        <Stack spacing={2}>
          {loadError !== null && <Alert severity="error">{loadError}</Alert>}
          <Stack direction="row" spacing={2} sx={{ alignItems: "flex-start" }}>
            <TextField
              select id="local-cluster-relay" label="Relay" value={chosen ? chosen.id : ""} fullWidth disabled={relays === null}
              onChange={(e) => onChange(e.target.value)}
              helperText="The relay runs a small DX cluster on that computer. Your logging software connects to it. The address and port are shown in the relay."
            >
              {choices.map((r) => <MenuItem key={r.id} value={r.id}>{relayLabel(r)}</MenuItem>)}
            </TextField>
            {chosen && (
              <Chip
                sx={{ flexShrink: 0, mt: 2 }}
                {...(chosen.cluster_connected_at === null
                  ? { label: "Offline", variant: "outlined" }
                  : { label: "Connected", color: "success" })}
              />
            )}
          </Stack>
          <Typography variant="body2" color="text.secondary">
            If the relay is offline, spots are dropped. Nothing is queued, because an old spot isn't useful in a bandmap.
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Don't have the relay yet?{" "}
            <Link href={RELAY_DOWNLOAD_URL} target="_blank" rel="noopener noreferrer">Get the Long Lines Relay</Link>
          </Typography>
        </Stack>
      </CardContent>
    </Card>
  );
}
