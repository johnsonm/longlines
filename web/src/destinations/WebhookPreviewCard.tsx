import { useEffect, useMemo, useState } from "react";
import { Alert, Box, Button, Card, CardContent, MenuItem, Paper, Stack, TextField, Typography } from "@mui/material";
import { previewWebhookRequest, sendTest, type WebhookSettings } from "../lib/api";
import { errorText } from "../app/hooks";
import { spotLabel, useRecentSpotPicker } from "./previewSpots";
import { fixedHeaderLines, sendTestBlocker } from "./webhookModel";

const DEBOUNCE_MS = 300;

export interface WebhookPreviewCardProps {
  settings: WebhookSettings;
  /** Set once the destination exists: the preview names one of its connections, and Send test needs it. */
  destinationId?: string;
  /** The request line's path (requestPath). */
  path: string;
  /** The extra header lines, value masked (extraHeaderLines). */
  headerLines: string[];
  /** Whether a URL is saved or typed. */
  hasUrl: boolean;
  /** Unsaved changes disable the test, since it uses the saved settings. */
  dirty: boolean;
}

function unixNow(): number {
  return Math.floor(Date.now() / 1000);
}

type Result = { ok: true; status: number } | { ok: false; message: string };

/**
 * Page 7's Request preview: the request line, the headers in the order they
 * are sent (decision 19), and the body preview_webhook_request builds for a
 * recent spot or the sample, pretty-printed as it comes (SQL's key order is
 * kept). Send test request posts the saved settings and shows the status.
 */
export function WebhookPreviewCard({ settings, destinationId, path, headerLines, hasUrl, dirty }: WebhookPreviewCardProps) {
  const { spots, spotId, setSpotId } = useRecentSpotPicker();
  const [body, setBody] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  // X-LongLines-Timestamp as it would be sent: the time of the latest preview.
  const [stamp, setStamp] = useState(unixNow);

  // The editor builds a new settings object on every change; key the request on its content.
  const key = JSON.stringify(settings);
  const stable = useMemo(() => JSON.parse(key) as WebhookSettings, [key]);
  useEffect(() => {
    let active = true;
    const timer = setTimeout(() => {
      previewWebhookRequest(stable, spotId, destinationId ?? null)
        .then((b) => {
          if (!active) return;
          setBody(JSON.stringify(b, null, 2));
          setStamp(unixNow());
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
  }, [stable, spotId, destinationId]);

  const head = [`POST ${path}`, ...fixedHeaderLines(stamp), ...headerLines].join("\n");

  const blocker = sendTestBlocker(destinationId, hasUrl, dirty);
  const send = async () => {
    if (!destinationId) return;
    setSending(true);
    setResult(null);
    try {
      const { status } = await sendTest(destinationId, spotId);
      if (status !== null) setResult({ ok: true, status });
    } catch (err) {
      setResult({ ok: false, message: errorText(err, "Couldn't send the test.") });
    } finally {
      setSending(false);
    }
  };

  return (
    <Card variant="outlined">
      <CardContent>
        <Stack spacing={2}>
          <Typography variant="overline" color="text.secondary">Request preview</Typography>
          <TextField
            select label="Preview with this spot" value={spotId ?? ""} fullWidth size="small"
            onChange={(e) => setSpotId(e.target.value === "" ? null : Number(e.target.value))}
          >
            <MenuItem value="">Sample spot</MenuItem>
            {spots.map((s) => <MenuItem key={s.id} value={s.id!}>{spotLabel(s)}</MenuItem>)}
          </TextField>
          {error && <Alert severity="error">{error}</Alert>}
          <Paper variant="outlined" sx={{ p: 1.5, overflow: "auto", maxHeight: 560 }}>
            {/* A bare <pre> keeps the browser's monospace font and the body's line breaks; MUI 9 has no fontFamily prop. */}
            <Box component="pre" aria-label="Request" sx={{ m: 0 }}>{body === null ? head : `${head}\n\n${body}`}</Box>
          </Paper>
          <div>
            <Button variant="outlined" fullWidth disabled={blocker !== null || sending} onClick={() => void send()}>
              Send test request
            </Button>
            <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 1 }}>
              {blocker ?? "Sends this example to your URL and shows the response code. The test is marked as a test and is not counted as a delivery."}
            </Typography>
          </div>
          {result && (result.ok
            ? <Alert severity="success">{`Your URL answered HTTP ${result.status}.`}</Alert>
            : <Alert severity="error">{result.message}</Alert>)}
        </Stack>
      </CardContent>
    </Card>
  );
}
