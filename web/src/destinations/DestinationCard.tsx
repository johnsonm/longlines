import { Box, Button, Card, CardActions, CardContent, Chip, Divider, Paper, Stack, Tooltip, Typography } from "@mui/material";
import type { Destination, PushDevice } from "../lib/api";
import { cardMeta } from "./cardMeta";
import { HealthChip } from "./HealthChip";
import { typeLabel } from "./types";

interface Props {
  dest: Destination;
  /** Subscriptions that send to it. */
  usedBy: number;
  /** For a push destination: its member devices, from the page's one listPushDevices call. */
  devices: PushDevice[];
  busy: boolean;
  mobile: boolean;
  onSendTest: () => void;
  onRotateSecret: () => void;
  onEdit: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}

export function DestinationCard({ dest, usedBy, devices, busy, mobile, onSendTest, onRotateSecret, onEdit, onDuplicate, onDelete }: Props) {
  const push = dest.type === "push";
  const blocked = devices.filter((d) => d.blocked_at !== null).length;
  const deleteTip = usedBy > 0 ? `Used by ${usedBy} subscriptions. Remove it from them first.` : "Delete";

  return (
    <Card variant="outlined" sx={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <CardContent sx={{ flexGrow: 1 }}>
        <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: "center", flexWrap: "wrap", mb: 0.5 }}>
          <Typography variant="h6" component="h2" sx={{ minWidth: 0, overflowWrap: "anywhere" }}>{dest.name}</Typography>
          <HealthChip health={dest.health} blocked={push ? blocked : 0} />
        </Stack>
        <Typography color="text.secondary" gutterBottom>{typeLabel(dest.type)}</Typography>
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
        ) : (
          <Paper variant="outlined" sx={{ px: 1.5, py: 1, my: 1.5, overflow: "hidden" }}>
            {/* A bare <code> keeps the browser's monospace font; MUI 9 has no fontFamily prop. */}
            <Box component="code" sx={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{dest.url_display}</Box>
          </Paper>
        )}
        <Typography variant="body2" color="text.secondary">{cardMeta(dest, usedBy)}</Typography>
      </CardContent>
      <Divider />
      <CardActions sx={{ flexWrap: "wrap", gap: 1, px: 2, py: 1.5, flexDirection: mobile ? "column" : "row", alignItems: mobile ? "stretch" : "center" }}>
        <Button size="small" variant="outlined" disabled={busy} onClick={onSendTest}>Send test</Button>
        {dest.type === "webhook" && <Button size="small" disabled={busy} onClick={onRotateSecret}>Rotate secret</Button>}
        {push && <Button size="small" disabled={busy} onClick={onEdit}>Edit</Button>}
        {push && <Button size="small" disabled={busy} onClick={onDuplicate}>Duplicate</Button>}
        <Tooltip title={deleteTip}>
          <Box component="span" sx={{ ml: mobile ? 0 : "auto", display: mobile ? "flex" : "inline-flex", flexDirection: "column" }}>
            <Button size="small" color="error" aria-label={`Delete ${dest.name}`} disabled={usedBy > 0 || busy} onClick={onDelete} fullWidth={mobile}>
              Delete
            </Button>
          </Box>
        </Tooltip>
      </CardActions>
    </Card>
  );
}
