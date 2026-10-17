import {
  Button, Card, CardContent, CardHeader, Checkbox, Chip, IconButton, LinearProgress, List, ListItem, ListItemIcon, ListItemText, Paper, Stack,
  Tooltip, Typography,
} from "@mui/material";
import { styled } from "@mui/material/styles";
import AddIcon from "@mui/icons-material/Add";
import DeleteOutlinedIcon from "@mui/icons-material/DeleteOutlined";
import DriveFileRenameOutlineIcon from "@mui/icons-material/DriveFileRenameOutline";
import LaptopIcon from "@mui/icons-material/Laptop";
import SmartphoneIcon from "@mui/icons-material/Smartphone";
import type { PushDevice } from "../lib/api";
import { deviceCaption } from "./cardMeta";

/** The empty state's box, dashed as page 5 draws it. */
const EmptyBox = styled(Paper)(({ theme }) => ({
  borderStyle: "dashed",
  padding: theme.spacing(3),
  textAlign: "center",
}));

/** A phone icon for Android and iOS descriptors, a laptop for the rest. */
function isPhone(agent: string): boolean {
  return /\b(Android|iPhone|iPad)\b/.test(agent);
}

interface Props {
  /** Every device of the account; null while loading. */
  devices: PushDevice[] | null;
  /** The members: the form's device ids. */
  checked: string[];
  busy: boolean;
  onToggle: (id: string, on: boolean) => void;
  onAdd: () => void;
  onRename: (device: PushDevice) => void;
  onRemove: (device: PushDevice) => void;
}

/** Page 5's Devices card: one row per account device, checked when the destination sends to it. */
export function DevicesCard({ devices, checked, busy, onToggle, onAdd, onRename, onRemove }: Props) {
  return (
    <Card variant="outlined">
      <CardHeader
        title="Devices" subheader="Pick which devices receive notifications. Each device is a browser you have allowed."
        slotProps={{ title: { variant: "subtitle1" } }}
      />
      <CardContent sx={{ pt: 0 }}>
        {devices === null ? (
          <LinearProgress />
        ) : devices.length === 0 ? (
          <EmptyBox variant="outlined">
            <Typography variant="subtitle2" gutterBottom>No devices yet</Typography>
            <Typography variant="body2" color="text.secondary" gutterBottom>
              Add the device you are on now, or open Long Lines on your phone to add it. A destination needs at least one device to deliver.
            </Typography>
            <Stack direction="row" spacing={1} useFlexGap sx={{ justifyContent: "center", flexWrap: "wrap", mt: 2 }}>
              <Button variant="contained" size="small" onClick={onAdd}>Add this device</Button>
              <Button variant="outlined" size="small" onClick={onAdd}>Add my phone</Button>
            </Stack>
          </EmptyBox>
        ) : (
          <Stack spacing={1}>
            <List disablePadding>
              {devices.map((d) => {
                const Icon = isPhone(d.agent) ? SmartphoneIcon : LaptopIcon;
                const blocked = d.blocked_at !== null;
                return (
                  <ListItem
                    key={d.id} divider disableGutters
                    secondaryAction={
                      <Stack direction="row" spacing={0.5}>
                        <Tooltip title="Rename device">
                          <IconButton aria-label={`Rename ${d.label}`} disabled={busy} onClick={() => onRename(d)}>
                            <DriveFileRenameOutlineIcon />
                          </IconButton>
                        </Tooltip>
                        <Tooltip title="Remove device">
                          <IconButton edge="end" aria-label={`Remove ${d.label}`} disabled={busy} onClick={() => onRemove(d)}>
                            <DeleteOutlinedIcon />
                          </IconButton>
                        </Tooltip>
                      </Stack>
                    }
                  >
                    <ListItemIcon>
                      <Checkbox
                        edge="start" checked={checked.includes(d.id)} disabled={busy || (blocked && !checked.includes(d.id))}
                        onChange={(e) => onToggle(d.id, e.target.checked)} slotProps={{ input: { "aria-label": `Send to ${d.label}` } }}
                      />
                    </ListItemIcon>
                    <ListItemIcon>
                      <Icon color={blocked ? "disabled" : "action"} aria-hidden />
                    </ListItemIcon>
                    <ListItemText
                      sx={{ pr: 10 }}
                      primary={
                        <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: "center", flexWrap: "wrap" }}>
                          <span>{d.label}</span>
                          {d.is_current && <Chip size="small" label="This device" />}
                          {blocked && <Chip size="small" color="error" label="Blocked" />}
                        </Stack>
                      }
                      secondary={deviceCaption(d)}
                      slotProps={{ primary: { component: "div" } }}
                    />
                  </ListItem>
                );
              })}
            </List>
            <div>
              <Button size="small" startIcon={<AddIcon />} onClick={onAdd} disabled={busy}>Add a device</Button>
            </div>
          </Stack>
        )}
      </CardContent>
    </Card>
  );
}
