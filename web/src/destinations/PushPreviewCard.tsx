import { useEffect, useState } from "react";
import { Alert, Button, Card, CardContent, MenuItem, Stack, TextField, Typography } from "@mui/material";
import { previewPushNotification, sendTest, type PushPreview, type PushSettings } from "../lib/api";
import { errorText, useNotify } from "../app/hooks";
import { sourceName } from "../sources/sources";
import { NotificationMockup } from "./NotificationMockup";
import { SAMPLE_SOURCE, spotLabel, useRecentSpotPicker } from "./previewSpots";
import { sendTestBlocker, type MockupVariant } from "./pushModel";

const DEBOUNCE_MS = 300;
const VARIANTS: MockupVariant[] = ["android", "iphone", "desktop"];

interface Props {
  settings: PushSettings;
  /** Set once the destination exists; a new one cannot send a test. */
  destinationId: string | undefined;
  /** The saved name, for the toast. */
  name: string;
  /** Members as last saved: the test goes to them. */
  savedDeviceCount: number;
  /** Unsaved changes disable the test, since it uses the saved settings (decision 10). */
  dirty: boolean;
}

/**
 * Page 5's Preview card: the notification SQL would build for a recent spot
 * or the sample, as the three platforms show it, and Send test. The text is
 * preview_push_notification's; nothing here joins fields.
 */
export function PushPreviewCard({ settings, destinationId, name, savedDeviceCount, dirty }: Props) {
  const notify = useNotify();
  const { spots, spotId, setSpotId, chosen } = useRecentSpotPicker();
  const [preview, setPreview] = useState<PushPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  const { title_fields: titleFields, body_fields: bodyFields, show_field_names: showFieldNames, body_separator: bodySeparator } = settings;
  useEffect(() => {
    let active = true;
    const timer = setTimeout(() => {
      previewPushNotification(titleFields, bodyFields, showFieldNames, bodySeparator, spotId)
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
  }, [titleFields, bodyFields, showFieldNames, bodySeparator, spotId]);

  const source = sourceName(chosen?.source ?? SAMPLE_SOURCE);
  const actions = settings.action_buttons && preview
    ? ["Open profile", ...(preview.source_url ? [`Open on ${source}`] : [])]
    : [];

  const blocker = sendTestBlocker(destinationId, savedDeviceCount, dirty);
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
          {VARIANTS.map((v) => (
            <NotificationMockup key={v} variant={v} title={preview?.title ?? "…"} body={preview?.body ?? ""} actions={actions} />
          ))}
          <div>
            <Button variant="outlined" fullWidth disabled={blocker !== null || sending} onClick={() => void send()}>
              Send test notification
            </Button>
            <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 1 }}>
              {blocker ?? `Sends this example to the ${savedDeviceCount} selected device${savedDeviceCount === 1 ? "" : "s"}.`}
            </Typography>
          </div>
        </Stack>
      </CardContent>
    </Card>
  );
}
