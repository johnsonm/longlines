import { useEffect, useState } from "react";
import {
  Alert, AlertTitle, Button, Chip, Dialog, DialogActions, DialogContent, DialogTitle, Divider, IconButton, Stack, TextField, Typography,
} from "@mui/material";
import CloseIcon from "@mui/icons-material/Close";
import LaptopIcon from "@mui/icons-material/Laptop";
import SmartphoneIcon from "@mui/icons-material/Smartphone";
import { errorText, useApp } from "../app/hooks";
import { Steps, type Step } from "../layout/Steps";
import { DENIED_TEXT, deviceAgent, enablePush, isIos, pushSupport, UNSUPPORTED_TEXT, type PushSupport } from "../pwa/push";

interface Props {
  open: boolean;
  fullScreen: boolean;
  onClose: () => void;
  /** The registered device's id, once this browser is on. */
  onAdded: (id: string) => void;
}

const IOS_STEPS: Step[] = [
  { title: "Tap Share", text: "The square with an arrow, in the Safari toolbar." },
  { title: "Choose Add to Home Screen", text: "Then tap Add." },
  { title: "Open Long Lines from the Home Screen", text: "Sign in, go to Destinations, and choose Add this device." },
];

/**
 * Page 5's Add a device dialog. "This device" turns notifications on here
 * (enablePush, whose first statement asks for permission on this click);
 * "Another device" tells the user what to do on their phone. A Safari that
 * is not installed sees the Home Screen steps instead.
 */
export function AddDeviceDialog({ open, fullScreen, onClose, onAdded }: Props) {
  const { notify, profile } = useApp();
  const [support, setSupport] = useState<PushSupport | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const agent = deviceAgent();
  const Icon = isIos() || /\bAndroid\b/.test(agent) ? SmartphoneIcon : LaptopIcon;

  useEffect(() => {
    if (!open) return;
    let active = true;
    setSupport(null);
    setName(deviceAgent());
    setError(null);
    setBusy(false);
    pushSupport()
      .then((s) => {
        if (active) setSupport(s);
      })
      .catch(() => {
        if (active) setSupport("unsupported");
      });
    return () => {
      active = false;
    };
  }, [open]);

  const enable = async () => {
    setBusy(true);
    setError(null);
    try {
      const id = await enablePush(name.trim() || agent);
      notify("Notifications turned on");
      onAdded(id);
    } catch (err) {
      setError(errorText(err, "Couldn't turn on notifications."));
      setBusy(false);
    }
  };

  const thisDevice = support === "ios-needs-install" ? (
    <Stack spacing={2}>
      <Alert severity="warning">
        <AlertTitle>Add Long Lines to your Home Screen first</AlertTitle>
        Safari on iPhone only allows notifications for web apps added to the Home Screen.
      </Alert>
      <Steps steps={IOS_STEPS} />
      <div>
        <Button variant="contained" disabled>Enable notifications</Button>
        <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 1 }}>
          Available once Long Lines is opened from the Home Screen.
        </Typography>
      </div>
    </Stack>
  ) : (
    <Stack spacing={2}>
      <Stack direction="row" spacing={1.5} sx={{ alignItems: "center" }}>
        <Icon color="action" aria-hidden />
        <Typography variant="subtitle1">This device</Typography>
        <Chip size="small" label={agent} />
      </Stack>
      <Typography variant="body2" color="text.secondary">
        Your browser will ask for permission. Choose Allow. You can change this later in the browser site settings.
      </Typography>
      <TextField label="Device name" value={name} onChange={(e) => setName(e.target.value)} fullWidth disabled={busy} />
      {error && <Alert severity="error">{error}</Alert>}
      {support === "denied" ? (
        <Typography variant="body2" color="text.secondary">{DENIED_TEXT}</Typography>
      ) : support === "unsupported" ? (
        <Typography variant="body2" color="text.secondary">{UNSUPPORTED_TEXT}</Typography>
      ) : (
        <div>
          <Button variant="contained" disabled={support === null || busy || !name.trim()} onClick={() => void enable()}>
            Enable notifications
          </Button>
        </div>
      )}
    </Stack>
  );

  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} fullWidth maxWidth="sm" fullScreen={fullScreen}>
      <DialogTitle sx={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        Add a device
        {fullScreen && (
          <IconButton edge="end" aria-label="Close" onClick={onClose} disabled={busy}>
            <CloseIcon />
          </IconButton>
        )}
      </DialogTitle>
      <DialogContent>
        <Stack spacing={3}>
          {thisDevice}
          <Divider />
          <Stack spacing={1}>
            <Typography variant="subtitle1">Another device</Typography>
            <Steps
              steps={[
                { title: "Open Long Lines on that device", text: `Go to longlines.io and sign in as ${profile?.callsign ?? "your callsign"}.` },
                { title: "Open Destinations and choose Add this device", text: "Allow notifications when asked. The device appears here when it is ready." },
              ]}
            />
            <Alert severity="info">
              On iPhone and iPad, first add Long Lines to the Home Screen from the Share menu. Safari only allows notifications for installed web apps.
            </Alert>
          </Stack>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>Cancel</Button>
      </DialogActions>
    </Dialog>
  );
}
