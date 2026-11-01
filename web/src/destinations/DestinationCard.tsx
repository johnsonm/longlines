import { Box, Button, Card, CardActions, CardContent, Chip, Divider, Paper, Stack, Typography } from "@mui/material";
import type { Destination, DiscordSettingsSummary, LocalClusterSettingsSummary, PushDevice, WebhookSettingsSummary } from "../lib/api";
import { cardMeta } from "./cardMeta";
import { discordCardLine } from "./discordModel";
import { HealthChip } from "./HealthChip";
import { localClusterCardLine, relayOffline } from "./localClusterModel";
import { webhookCardLine } from "./webhookModel";
import { typeLabel } from "./types";

interface Props {
  dest: Destination;
  /** Subscriptions that send to it. */
  usedBy: number;
  /** For a push destination: its member devices, from the page's one listPushDevices call. */
  devices: PushDevice[];
  /** For a Discord destination: its style and field count, from the page's one listDiscordDestinationSettings call; null until loaded. */
  discord: DiscordSettingsSummary | null;
  /** For a webhook: its field count and window, from the page's one listWebhookDestinationSettings call; null until loaded. */
  webhook: WebhookSettingsSummary | null;
  /** For a Local DX cluster: its relay and whether that relay is connected, from the page's one listLocalClusterDestinationSettings call; null until loaded. */
  localCluster: LocalClusterSettingsSummary | null;
  /** Spots waiting to be sent, from the page's one listDestinationQueues call; 0 until loaded. */
  waiting: number;
  busy: boolean;
  mobile: boolean;
  onSendTest: () => void;
  onEdit: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}

export function DestinationCard({ dest, usedBy, devices, discord, webhook, localCluster, waiting, busy, mobile, onSendTest, onEdit, onDuplicate, onDelete }: Props) {
  const push = dest.type === "push";
  const cluster = dest.type === "local_cluster";
  const editable = push || cluster || dest.type === "discord" || dest.type === "webhook";
  const typeLine = cluster
    ? localClusterCardLine(localCluster)
    : dest.type === "discord" && discord
    ? discordCardLine(discord.style, discord.field_count)
    : dest.type === "webhook" && webhook
    ? webhookCardLine(webhook.field_count, webhook.batch_seconds)
    : typeLabel(dest.type);
  const blocked = devices.filter((d) => d.blocked_at !== null).length;

  return (
    <Card variant="outlined" sx={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <CardContent sx={{ flexGrow: 1 }}>
        <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: "center", flexWrap: "wrap", mb: 0.5 }}>
          <Typography variant="h6" component="h2" sx={{ minWidth: 0, overflowWrap: "anywhere" }}>{dest.name}</Typography>
          <HealthChip
            health={dest.health} blocked={push ? blocked : 0} paused={Boolean(dest.auto_disabled_at)}
            relayOffline={cluster && relayOffline(localCluster)}
          />
        </Stack>
        <Typography color="text.secondary" gutterBottom>{typeLine}</Typography>
        {push ? (
          devices.length > 0 ? (
            <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: "wrap", my: 1.5 }}>
              {devices.map((d) => (
                <Chip
                  key={d.id} size="small" variant="outlined" color={d.blocked_at ? "error" : "default"}
                  label={d.blocked_at ? `${d.label} (blocked)` : d.label}
                />
              ))}
            </Stack>
          ) : (
            <Typography color="text.secondary" sx={{ my: 1.5 }}>No devices yet</Typography>
          )
        ) : cluster ? null : (
          <Paper variant="outlined" sx={{ px: 1.5, py: 1, my: 1.5, overflow: "hidden" }}>
            {/* A bare <code> keeps the browser's monospace font; MUI 9 has no fontFamily prop. */}
            <Box component="code" sx={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{dest.url_display}</Box>
          </Paper>
        )}
        <Typography variant="body2" color="text.secondary">{cardMeta(dest, usedBy, waiting)}</Typography>
      </CardContent>
      <Divider />
      <CardActions sx={{ flexWrap: "wrap", gap: 1, px: 2, py: 1.5, flexDirection: mobile ? "column" : "row", alignItems: mobile ? "stretch" : "center" }}>
        {/* No web Send test for a Local DX cluster: only the relay's own test spot reaches its DX cluster. */}
        {!cluster && <Button size="small" variant="outlined" disabled={busy} onClick={onSendTest}>Send test</Button>}
        {editable && <Button size="small" aria-label={`Edit ${dest.name}`} disabled={busy} onClick={onEdit}>Edit</Button>}
        {editable && <Button size="small" aria-label={`Duplicate ${dest.name}`} disabled={busy} onClick={onDuplicate}>Duplicate</Button>}
        {/* Allowed while connections use it: the page's confirmation names them. */}
        <Button
          size="small" color="error" aria-label={`Delete ${dest.name}`} disabled={busy} onClick={onDelete} fullWidth={mobile}
          sx={{ ml: mobile ? 0 : "auto" }}
        >
          Delete
        </Button>
      </CardActions>
    </Card>
  );
}
