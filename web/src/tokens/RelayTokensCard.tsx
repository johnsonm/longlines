import { useCallback, useEffect, useState } from "react";
import {
  Alert, Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, Paper, Stack, Table, TableBody, TableCell, TableHead,
  TableRow, Typography,
} from "@mui/material";
import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import { deleteRelayToken, loadRelayTokens, type RelayToken } from "../lib/api";
import { formatDate, timeAgo } from "../lib/time";
import { errorText, useNotify } from "../app/hooks";
import { RELAY_DOWNLOAD_URL } from "./model";

/**
 * The computers signed in with Long Lines Relay (relay_tokens), each revocable. A relay signs in from the app
 * through /relay/approve, so there is no create here; revoking one signs it out on its next request.
 */
export function RelayTokensCard() {
  const notify = useNotify();
  const [relays, setRelays] = useState<RelayToken[]>([]);
  // A failed load shows in the table, so it never reads as "none" or as a stale list.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [busy, setBusy] = useState(false);
  const [revoking, setRevoking] = useState<RelayToken | null>(null);

  const reload = useCallback(async () => {
    try {
      setRelays(await loadRelayTokens());
      setLoadError(null);
    } catch (err) {
      setLoadError(errorText(err, "Couldn't load your relays."));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const retry = async () => {
    setRetrying(true);
    await reload();
    setRetrying(false);
  };

  const revoke = async (r: RelayToken) => {
    setRevoking(null);
    setBusy(true);
    try {
      await deleteRelayToken(r.id);
      await reload();
      notify("Relay revoked.");
    } catch (err) {
      notify(errorText(err, "Couldn't revoke the relay."));
    } finally {
      setBusy(false);
    }
  };

  // Connected and Last used drop out on phones, as in the API token table.
  const wide = { display: { xs: "none", md: "table-cell" } };

  return (
    <Paper variant="outlined">
      <Stack direction={{ xs: "column", md: "row" }} spacing={2} sx={{ p: 3, pb: 2, alignItems: { md: "center" } }}>
        <Box sx={{ flexGrow: 1 }}>
          <Typography variant="h6" component="h2" gutterBottom>Long Lines Relay</Typography>
          <Typography variant="body2" color="text.secondary">
            Computers running Long Lines Relay post the contacts you log as spots. Revoke one to sign it out.
          </Typography>
        </Box>
        <Button href={RELAY_DOWNLOAD_URL} target="_blank" rel="noopener noreferrer" endIcon={<OpenInNewIcon />} sx={{ flexShrink: 0 }}>
          Get the relay
        </Button>
      </Stack>
      <Box sx={{ overflowX: "auto" }}>
        <Table>
          <TableHead>
            <TableRow>
              <TableCell>Computer</TableCell>
              <TableCell sx={wide}>Connected</TableCell>
              <TableCell>Last used</TableCell>
              <TableCell />
            </TableRow>
          </TableHead>
          <TableBody>
            {loadError !== null && (
              <TableRow>
                <TableCell colSpan={4}>
                  <Alert
                    severity="error"
                    action={<Button color="inherit" size="small" disabled={retrying} onClick={() => void retry()}>Retry</Button>}
                  >
                    {loadError}
                  </Alert>
                </TableCell>
              </TableRow>
            )}
            {loadError === null && relays.length === 0 && (
              <TableRow>
                <TableCell colSpan={4}><Typography variant="body2" color="text.secondary">No relays connected.</Typography></TableCell>
              </TableRow>
            )}
            {loadError === null && relays.map((r) => (
              <TableRow key={r.id}>
                <TableCell>
                  <Typography variant="subtitle2">{r.device_name}</Typography>
                  <Typography variant="caption" color="text.secondary">{r.token_prefix}… · version {r.client_version}</Typography>
                </TableCell>
                <TableCell sx={wide}>{formatDate(r.created_at)}</TableCell>
                <TableCell>{r.last_used_at ? timeAgo(r.last_used_at) : "Never"}</TableCell>
                <TableCell align="right">
                  <Button size="small" color="error" disabled={busy} onClick={() => setRevoking(r)} aria-label={`Revoke ${r.device_name}`}>
                    Revoke
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Box>

      <Dialog open={revoking !== null} onClose={() => setRevoking(null)} fullWidth maxWidth="xs">
        <DialogTitle>Revoke this relay?</DialogTitle>
        <DialogContent>
          <Typography variant="body2">
            {revoking?.device_name ?? "That computer"} stops posting your logged contacts right away and signs out.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setRevoking(null)}>Cancel</Button>
          <Button color="error" variant="contained" onClick={() => revoking && void revoke(revoking)}>Revoke</Button>
        </DialogActions>
      </Dialog>
    </Paper>
  );
}
