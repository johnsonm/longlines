import { useEffect, useState } from "react";
import { Alert, Box, Card, CardContent, Divider, Paper, Stack, Typography } from "@mui/material";
import { previewLocalClusterLine, type LocalClusterField, type LocalClusterPreview } from "../lib/api";
import { errorText } from "../app/hooks";
import { clusterFrequency, clusterTime } from "./localClusterModel";

const DEBOUNCE_MS = 300;

/**
 * The Local DX cluster editor's Preview card: the line SQL renders for the
 * sample spot with these fields (preview_local_cluster_line), and its parts.
 * Nothing here builds the line. There is no Send test: only the relay's own
 * test spot reaches its DX cluster.
 */
export function LocalClusterPreviewCard({ fields }: { fields: LocalClusterField[] }) {
  const [preview, setPreview] = useState<LocalClusterPreview | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The editor builds a new list on every change; key the request on its content.
  const key = fields.join(",");
  useEffect(() => {
    let active = true;
    const timer = setTimeout(() => {
      previewLocalClusterLine(key === "" ? [] : (key.split(",") as LocalClusterField[]), null)
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
  }, [key]);

  const rows: [string, string][] = preview
    ? [
      ["Spotter", preview.spotter],
      ["Frequency", clusterFrequency(preview.frequency_khz)],
      ["Station", preview.callsign],
      ["Comment", preview.comment],
      ["Time (UTC)", clusterTime(preview.time_utc)],
    ]
    : [];

  return (
    <Card variant="outlined">
      <CardContent>
        <Stack spacing={2}>
          <Box>
            <Typography variant="overline" color="text.secondary">Preview</Typography>
            <Typography variant="h6" component="h2">One spot, as your logging software sees it</Typography>
          </Box>
          {error && <Alert severity="error">{error}</Alert>}
          {preview && (
            <>
              <Paper variant="outlined" sx={{ p: 1.5, overflowX: "auto" }}>
                {/* A bare <code> keeps the browser's monospace font, so the line's columns line up as in a logger. */}
                <Box component="code" data-testid="cluster-line" sx={{ display: "block", whiteSpace: "pre" }}>{preview.line}</Box>
              </Paper>
              <Divider />
              <Stack spacing={1}>
                {rows.map(([label, value]) => (
                  <Stack key={label} direction="row" spacing={2} sx={{ justifyContent: "space-between" }}>
                    <Typography variant="body2" color="text.secondary">{label}</Typography>
                    <Typography variant="body2">{value}</Typography>
                  </Stack>
                ))}
              </Stack>
            </>
          )}
        </Stack>
      </CardContent>
    </Card>
  );
}
