import { useEffect, useMemo, useState } from "react";
import { Alert, Button, Card, CardContent, MenuItem, Stack, TextField, Typography } from "@mui/material";
import { previewDiscordMessage, sendTest, type DiscordPreview, type DiscordSettings } from "../lib/api";
import { errorText, useNotify } from "../app/hooks";
import { DiscordMockup } from "./DiscordMockup";
import { sendTestBlocker } from "./discordModel";
import { spotLabel, useRecentSpotPicker } from "./previewSpots";

const DEBOUNCE_MS = 300;

export interface DiscordPreviewCardProps {
  settings: DiscordSettings;
  /** Set once the destination exists; a new one cannot send a test. */
  destinationId?: string;
  /** The saved name, for the toast. */
  name: string;
  /** Whether a webhook URL is saved: the test posts to it. */
  hasUrl: boolean;
  /** Unsaved changes disable the test, since it uses the saved settings. */
  dirty: boolean;
}

/**
 * The editor's Preview card: the message SQL would build for a recent spot
 * or the sample, drawn in Discord's dark theme, and Send test. The text is
 * preview_discord_message's; nothing here joins fields.
 */
export function DiscordPreviewCard({ settings, destinationId, name, hasUrl, dirty }: DiscordPreviewCardProps) {
  const notify = useNotify();
  const { spots, spotId, setSpotId } = useRecentSpotPicker();
  const [preview, setPreview] = useState<DiscordPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  // The editor builds a new settings object on every change; key the request on its content.
  const key = JSON.stringify(settings);
  const stable = useMemo(() => JSON.parse(key) as DiscordSettings, [key]);
  useEffect(() => {
    let active = true;
    const timer = setTimeout(() => {
      previewDiscordMessage(stable, spotId)
        .then((p) => {
          if (!active) return;
          setPreview(p);
          setError(null);
        })
        .catch((err: unknown) => {
          if (active) setError(errorText(err, "Couldn't load the preview."));
        });
    }, DEBOUNCE_MS);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [stable, spotId]);

  const blocker = sendTestBlocker(destinationId, hasUrl, dirty);
  const send = async () => {
    if (!destinationId) return;
    setSending(true);
    try {
      await sendTest(destinationId, spotId);
      notify(`Test spot sent to ${name}`);
    } catch (err) {
      notify(errorText(err, "Couldn't send the test."));
    } finally {
      setSending(false);
    }
  };

  return (
    <Card variant="outlined">
      <CardContent>
        <Stack spacing={2}>
          <Typography variant="overline" color="text.secondary">Preview</Typography>
          <TextField
            select label="Preview with this spot" value={spotId ?? ""} fullWidth size="small"
            onChange={(e) => setSpotId(e.target.value === "" ? null : Number(e.target.value))}
          >
            <MenuItem value="">Sample spot</MenuItem>
            {spots.map((s) => <MenuItem key={s.id} value={s.id!}>{spotLabel(s)}</MenuItem>)}
          </TextField>
          {error && <Alert severity="error">{error}</Alert>}
          <DiscordMockup preview={preview} />
          <Typography variant="caption" color="text.secondary">
            Shown in Discord dark theme. Light theme and mobile follow the viewer's settings.
          </Typography>
          <div>
            <Button variant="outlined" fullWidth disabled={blocker !== null || sending} onClick={() => void send()}>
              Send test message
            </Button>
            <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 1 }}>
              {blocker ?? "Posts this example to the channel, marked as a test."}
            </Typography>
          </div>
        </Stack>
      </CardContent>
    </Card>
  );
}
