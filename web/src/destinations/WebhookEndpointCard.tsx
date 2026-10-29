import { Box, Button, Card, CardContent, CardHeader, IconButton, Paper, Stack, TextField, Typography } from "@mui/material";
import AddIcon from "@mui/icons-material/Add";
import CloseIcon from "@mui/icons-material/Close";
import { timeAgo } from "../lib/time";
import {
  addHeader, headerNeedsName, headerNeedsValue, HEADERS_MAX, looksLikeHttpsUrl, removeHeader, updateHeader, type HeaderRow,
} from "./webhookModel";

export interface WebhookEndpointCardProps {
  /** The stored URL, masked by SQL; null for a new destination. */
  urlDisplay: string | null;
  /** The typed URL; null while the field is closed (the stored URL is kept). */
  url: string | null;
  onUrlChange: (url: string | null) => void;
  /** When the signing secret was last rotated, or null if never. */
  rotatedAt: string | null;
  /** Rotates the secret at once (not part of the save); absent for a new destination. */
  onRotate?: () => void;
  rotating: boolean;
  headers: HeaderRow[];
  onHeadersChange: (rows: HeaderRow[]) => void;
  /** A saved destination's URL is being replaced, which clears the stored header values. */
  urlReplaced: boolean;
}

const SECRET_HELP = "We sign each request with this secret so you can check it came from Long Lines. It is only shown once, when created or rotated.";

/**
 * Page 7's Endpoint card: the Webhook URL (masked with Replace URL once
 * saved), the signing secret with Rotate, and the extra header rows. A saved
 * header's value is never sent to the browser; its field is empty with a
 * masked placeholder, and typing replaces it.
 */
export function WebhookEndpointCard({ urlDisplay, url, onUrlChange, rotatedAt, onRotate, rotating, headers, onHeadersChange, urlReplaced }: WebhookEndpointCardProps) {
  const editing = urlDisplay !== null && url === null;
  const replacing = urlDisplay !== null && url !== null;
  const value = url ?? "";
  const wrong = value.trim() !== "" && !looksLikeHttpsUrl(value);

  return (
    <Card variant="outlined">
      <CardHeader title="Endpoint" subheader="Requests are sent as POST with a JSON body." slotProps={{ title: { variant: "subtitle1" } }} />
      <CardContent sx={{ pt: 0 }}>
        <Stack spacing={3}>
          {editing ? (
            <Stack spacing={1.5}>
              <Paper variant="outlined" sx={{ px: 1.5, py: 1, overflow: "hidden" }}>
                {/* A bare <code> keeps the browser's monospace font; MUI 9 has no fontFamily prop. */}
                <Box component="code" sx={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{urlDisplay}</Box>
              </Paper>
              <Box>
                <Button variant="outlined" size="small" onClick={() => onUrlChange("")}>Replace URL</Button>
              </Box>
              <Typography variant="body2" color="text.secondary">The URL is hidden after saving.</Typography>
            </Stack>
          ) : (
            <Stack direction={{ xs: "column", sm: "row" }} spacing={1} sx={{ alignItems: "flex-start" }}>
              <TextField
                id="webhook-url" label="Webhook URL" fullWidth autoComplete="off" value={value}
                // The field mounts on a saved destination only after Replace URL, whose button just left the DOM.
                autoFocus={replacing}
                onChange={(e) => onUrlChange(e.target.value)} error={wrong} helperText="Must start with https://"
              />
              {replacing && (
                <Button onClick={() => onUrlChange(null)} sx={{ flexShrink: 0, whiteSpace: "nowrap", mt: { sm: 1 } }}>Keep current URL</Button>
              )}
            </Stack>
          )}

          <Stack spacing={1}>
            <Typography variant="subtitle2" component="h3">Signing secret</Typography>
            {onRotate ? (
              <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
                <Paper variant="outlined" sx={{ px: 1.5, py: 1, flexGrow: 1, minWidth: 0 }}>
                  <Box component="code" data-testid="masked-secret">whsec_••••••••</Box>
                </Paper>
                <Button variant="outlined" size="small" disabled={rotating} onClick={onRotate} sx={{ flexShrink: 0 }}>Rotate</Button>
              </Stack>
            ) : (
              <Typography variant="body2">A signing secret is created when you add the destination.</Typography>
            )}
            <Typography variant="body2" color="text.secondary">
              {rotatedAt ? `${SECRET_HELP} Rotated ${timeAgo(rotatedAt)}.` : SECRET_HELP}
            </Typography>
          </Stack>

          <Stack spacing={1.5}>
            <Typography variant="subtitle2" component="h3">Extra headers</Typography>
            {headers.map((row) => {
              const needsName = headerNeedsName(row);
              const needsValue = headerNeedsValue(row, urlReplaced);
              const masked = row.saved !== null && !urlReplaced;
              return (
                <Stack key={row.key} direction={{ xs: "column", sm: "row" }} spacing={1} sx={{ alignItems: { sm: "flex-start" } }}>
                  <TextField
                    label="Header" size="small" fullWidth autoComplete="off" value={row.name} error={needsName}
                    helperText={needsName ? "Give each header a name." : undefined}
                    onChange={(e) => onHeadersChange(updateHeader(headers, row.key, { name: e.target.value }))}
                  />
                  <Stack direction="row" spacing={1} sx={{ alignItems: "flex-start", width: "100%" }}>
                    <TextField
                      label="Value" size="small" fullWidth autoComplete="off" value={row.value} error={needsValue}
                      placeholder={masked ? "••••••••••••" : undefined}
                      slotProps={{ inputLabel: masked ? { shrink: true } : undefined }}
                      helperText={needsValue ? `Give the ${row.name.trim()} header a value.` : undefined}
                      onChange={(e) => onHeadersChange(updateHeader(headers, row.key, { value: e.target.value }))}
                    />
                    <IconButton aria-label="Remove header" onClick={() => onHeadersChange(removeHeader(headers, row.key))}>
                      <CloseIcon fontSize="small" />
                    </IconButton>
                  </Stack>
                </Stack>
              );
            })}
            <Box>
              <Button size="small" startIcon={<AddIcon />} disabled={headers.length >= HEADERS_MAX} onClick={() => onHeadersChange(addHeader(headers))}>
                Add a header
              </Button>
            </Box>
            <Typography variant="body2" color="text.secondary">
              Sent with every request, for example an API key. Stored encrypted and never shown again after saving.
            </Typography>
            {urlReplaced && headers.some((r) => r.saved !== null) && (
              <Typography variant="body2" color="text.secondary">
                A new URL clears the saved header values, so enter them again.
              </Typography>
            )}
          </Stack>
        </Stack>
      </CardContent>
    </Card>
  );
}
