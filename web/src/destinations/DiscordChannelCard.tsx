import { Box, Button, Card, CardContent, CardHeader, Paper, Stack, TextField, Typography } from "@mui/material";
import { looksLikeWebhookUrl } from "./discordModel";

export interface DiscordChannelCardProps {
  /** The stored URL, masked by SQL; null for a new destination. */
  urlDisplay: string | null;
  /** The typed replacement; null when not replacing (the stored URL is kept). */
  url: string | null;
  onUrlChange: (url: string | null) => void;
}

const WARNING = "Treat the URL like a password. Anyone who has it can post to the channel.";

/** The Discord editor's "Discord channel" card: the masked URL with Replace URL, or the Webhook URL field (with Keep current URL while replacing). */
export function DiscordChannelCard({ urlDisplay, url, onUrlChange }: DiscordChannelCardProps) {
  const editing = urlDisplay !== null && url === null;
  const replacing = urlDisplay !== null && url !== null;
  const value = url ?? "";
  const wrong = value.trim() !== "" && !looksLikeWebhookUrl(value);

  return (
    <Card variant="outlined">
      <CardHeader title="Discord channel" subheader="Where messages are posted" slotProps={{ title: { variant: "subtitle1" } }} />
      <CardContent sx={{ pt: 0 }}>
        {editing ? (
          <Stack spacing={1.5}>
            <Paper variant="outlined" sx={{ px: 1.5, py: 1, overflow: "hidden" }}>
              {/* A bare <code> keeps the browser's monospace font; MUI 9 has no fontFamily prop. */}
              <Box component="code" sx={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{urlDisplay}</Box>
            </Paper>
            <Box>
              <Button variant="outlined" size="small" onClick={() => onUrlChange("")}>Replace URL</Button>
            </Box>
            <Typography variant="body2" color="text.secondary">{`${WARNING} It is hidden after saving.`}</Typography>
          </Stack>
        ) : (
          <Stack spacing={2}>
            <Stack direction={{ xs: "column", sm: "row" }} spacing={1} sx={{ alignItems: "flex-start" }}>
              <TextField
                id="discord-webhook-url" label="Webhook URL" fullWidth autoComplete="off" value={value}
                // The field mounts on a saved destination only after Replace URL, whose button just left the DOM.
                autoFocus={replacing}
                onChange={(e) => onUrlChange(e.target.value)} error={wrong}
                helperText={wrong ? "That is a channel link, not a webhook URL. A webhook URL starts with https://discord.com/api/webhooks/" : undefined}
              />
              {replacing && (
                <Button onClick={() => onUrlChange(null)} sx={{ flexShrink: 0, whiteSpace: "nowrap", mt: { sm: 1 } }}>Keep current URL</Button>
              )}
            </Stack>
            <Paper variant="outlined" sx={{ p: 2 }}>
              <Typography variant="subtitle2" component="h3" gutterBottom>Get a webhook URL from Discord</Typography>
              <Typography variant="body2" component="ol" sx={{ m: 0, pl: 3 }}>
                <li>Open the channel settings and choose Integrations.</li>
                <li>Choose Webhooks, then New Webhook.</li>
                <li>Copy the webhook URL and paste it here.</li>
              </Typography>
            </Paper>
            <Typography variant="body2" color="text.secondary">{WARNING}</Typography>
          </Stack>
        )}
      </CardContent>
    </Card>
  );
}
