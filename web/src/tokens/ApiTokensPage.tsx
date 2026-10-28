import { useCallback, useEffect, useState } from "react";
import {
  Alert, Box, Button, Chip, Dialog, DialogActions, DialogContent, DialogTitle, MenuItem, Paper, Stack, Table, TableBody, TableCell,
  TableHead, TableRow, TextField, Typography,
} from "@mui/material";
import AddIcon from "@mui/icons-material/Add";
import MenuBookIcon from "@mui/icons-material/MenuBook";
import { PageTitle } from "../layout/PageTitle";
import { createApiToken, deleteApiToken, loadApiTokens, rotateApiToken, type ApiToken, type ApiTokenScope } from "../lib/api";
import { formatDate, timeAgo } from "../lib/time";
import { API_BASE_URL, API_DOCS_URL, EXAMPLE, EXPIRY, expiresLabel, scopeLabel } from "./model";
import { errorText, useNotify } from "../app/hooks";
import { RelayTokensCard } from "./RelayTokensCard";

/** Personal tokens for the management API: create, rotate and revoke. */
export function ApiTokensPage() {
  const notify = useNotify();
  const [tokens, setTokens] = useState<ApiToken[]>([]);
  // A failed load shows in the table, so it never reads as "No tokens yet." or as a stale list.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [busy, setBusy] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [scope, setScope] = useState<ApiTokenScope>("read");
  const [expiry, setExpiry] = useState("never");
  const [secret, setSecret] = useState<string | null>(null);
  const [rotating, setRotating] = useState<ApiToken | null>(null);
  const [revoking, setRevoking] = useState<ApiToken | null>(null);

  const reload = useCallback(async () => {
    try {
      setTokens(await loadApiTokens());
      setLoadError(null);
    } catch (err) {
      setLoadError(errorText(err, "Couldn't load your tokens."));
    }
  }, []);

  const retry = async () => {
    setRetrying(true);
    await reload();
    setRetrying(false);
  };

  useEffect(() => {
    void reload();
  }, [reload]);

  const run = async (work: () => Promise<void>, fallback: string) => {
    setBusy(true);
    try {
      await work();
    } catch (err) {
      notify(errorText(err, fallback));
    } finally {
      setBusy(false);
    }
  };

  const closeCreate = () => {
    setCreateOpen(false);
    setName("");
    setScope("read");
    setExpiry("never");
  };

  const create = () => run(async () => {
    const days = EXPIRY.find((e) => e.value === expiry)?.days ?? null;
    const token = await createApiToken(name.trim(), scope, days);
    closeCreate();
    setSecret(token);
    await reload();
  }, "Couldn't create the token.");

  const rotate = (t: ApiToken) => run(async () => {
    setRotating(null);
    setSecret(await rotateApiToken(t.id));
    await reload();
  }, "Couldn't rotate the token.");

  const revoke = (t: ApiToken) => run(async () => {
    setRevoking(null);
    await deleteApiToken(t.id);
    await reload();
    notify("Token revoked.");
  }, "Couldn't revoke the token.");

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(secret ?? "");
      notify("Token copied.");
    } catch {
      // No clipboard access: the field selects itself on focus for a manual copy.
    }
  };

  // Created and Last used drop out on phones, as the Stats tables drop columns.
  const wide = { display: { xs: "none", md: "table-cell" } };

  return (
    <Stack spacing={3} sx={{ maxWidth: 1152, width: "100%" }}>
      <Box>
        <PageTitle>API tokens</PageTitle>
        <Stack direction={{ xs: "column", md: "row" }} spacing={2} sx={{ alignItems: { md: "center" } }}>
          <Typography color="text.secondary" sx={{ flexGrow: 1 }}>
            Use the Long Lines API to manage connections, groups, and destinations from your own scripts, bots, and club tools.
            Each token acts as you, limited to the permissions you give it.
          </Typography>
          <Stack direction="row" spacing={1} sx={{ flexShrink: 0 }}>
            <Button startIcon={<MenuBookIcon />} href={API_DOCS_URL} target="_blank" rel="noopener">API docs</Button>
            <Button variant="contained" startIcon={<AddIcon />} disabled={busy} onClick={() => setCreateOpen(true)}>New token</Button>
          </Stack>
        </Stack>
      </Box>

      <Paper variant="outlined" sx={{ overflowX: "auto" }}>
        <Table>
          <TableHead>
            <TableRow>
              <TableCell>Name</TableCell>
              <TableCell>Permissions</TableCell>
              <TableCell sx={wide}>Created</TableCell>
              <TableCell sx={wide}>Last used</TableCell>
              <TableCell>Expires</TableCell>
              <TableCell />
            </TableRow>
          </TableHead>
          <TableBody>
            {loadError !== null && (
              <TableRow>
                <TableCell colSpan={6}>
                  <Alert
                    severity="error"
                    action={<Button color="inherit" size="small" disabled={retrying} onClick={() => void retry()}>Retry</Button>}
                  >
                    {loadError}
                  </Alert>
                </TableCell>
              </TableRow>
            )}
            {loadError === null && tokens.length === 0 && (
              <TableRow>
                <TableCell colSpan={6}><Typography variant="body2" color="text.secondary">No tokens yet.</Typography></TableCell>
              </TableRow>
            )}
            {loadError === null && tokens.map((t) => (
              <TableRow key={t.id}>
                <TableCell>
                  <Typography variant="subtitle2">{t.name}</Typography>
                  <Typography variant="caption" color="text.secondary">{t.token_prefix}…</Typography>
                </TableCell>
                <TableCell><Chip size="small" variant="outlined" label={scopeLabel(t.scope)} /></TableCell>
                <TableCell sx={wide}>{formatDate(t.created_at)}</TableCell>
                <TableCell sx={wide}>{t.last_used_at ? timeAgo(t.last_used_at) : "Never"}</TableCell>
                <TableCell>{expiresLabel(t.expires_at)}</TableCell>
                <TableCell align="right" sx={{ whiteSpace: "nowrap" }}>
                  <Button size="small" disabled={busy} onClick={() => setRotating(t)} aria-label={`Rotate ${t.name}`}>Rotate</Button>
                  <Button size="small" color="error" disabled={busy} onClick={() => setRevoking(t)} aria-label={`Revoke ${t.name}`}>Revoke</Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Paper>

      <RelayTokensCard />

      <Paper variant="outlined" sx={{ p: 3 }}>
        <Typography variant="h6" gutterBottom>Using the API</Typography>
        <Typography variant="body2" sx={{ mb: 2 }}>
          Send the token in the <code>Authorization</code> header. Base URL: <code>{API_BASE_URL}</code>
        </Typography>
        <Paper variant="outlined" sx={{ px: 2, overflowX: "auto" }}>
          <Box component="pre">{EXAMPLE}</Box>
        </Paper>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>
          Limit: 60 requests per minute per token. Revoked and expired tokens stop working immediately.
        </Typography>
      </Paper>

      <Dialog open={createOpen} onClose={closeCreate} fullWidth maxWidth="xs">
        <DialogTitle>New API token</DialogTitle>
        <DialogContent>
          <Stack spacing={2.5} sx={{ mt: 1 }}>
            <TextField
              label="Name" value={name} onChange={(e) => setName(e.target.value)} autoFocus fullWidth
              helperText="Something to recognize it by, like Club roster sync."
            />
            <TextField select label="Access" value={scope} onChange={(e) => setScope(e.target.value as ApiTokenScope)} fullWidth>
              <MenuItem value="read">Read only</MenuItem>
              <MenuItem value="write">Read and write</MenuItem>
            </TextField>
            <TextField select label="Expires" value={expiry} onChange={(e) => setExpiry(e.target.value)} fullWidth>
              {EXPIRY.map((e) => <MenuItem key={e.value} value={e.value}>{e.label}</MenuItem>)}
            </TextField>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={closeCreate}>Cancel</Button>
          <Button variant="contained" disabled={!name.trim() || busy} onClick={() => void create()}>Create token</Button>
        </DialogActions>
      </Dialog>

      {/* No onClose: a backdrop click or Escape would lose a token that can never be shown again. Done closes it. */}
      <Dialog open={secret !== null} fullWidth maxWidth="sm">
        <DialogTitle>Copy your token</DialogTitle>
        <DialogContent>
          <Typography variant="body2" sx={{ mb: 2 }}>Copy this token now. You won't see it again.</Typography>
          <TextField
            value={secret ?? ""} fullWidth slotProps={{ input: { readOnly: true }, htmlInput: { "aria-label": "Token" } }}
            onFocus={(e) => e.target.select()}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => void copy()}>Copy</Button>
          <Button variant="contained" onClick={() => setSecret(null)}>Done</Button>
        </DialogActions>
      </Dialog>

      <Dialog open={rotating !== null} onClose={() => setRotating(null)} fullWidth maxWidth="xs">
        <DialogTitle>Rotate this token?</DialogTitle>
        <DialogContent>
          <Typography variant="body2">Scripts using the current token stop working right away. You'll get a new one to copy.</Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setRotating(null)}>Cancel</Button>
          <Button variant="contained" onClick={() => rotating && void rotate(rotating)}>Rotate</Button>
        </DialogActions>
      </Dialog>

      <Dialog open={revoking !== null} onClose={() => setRevoking(null)} fullWidth maxWidth="xs">
        <DialogTitle>Revoke this token?</DialogTitle>
        <DialogContent>
          <Typography variant="body2">Scripts using it stop working right away.</Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setRevoking(null)}>Cancel</Button>
          <Button color="error" variant="contained" onClick={() => revoking && void revoke(revoking)}>Revoke</Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}
