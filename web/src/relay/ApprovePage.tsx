import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Link as RouterLink, useSearchParams } from "react-router";
import { Alert, AlertTitle, Box, Button, LinearProgress, Link, Paper, Stack, TextField, Typography } from "@mui/material";
import AccessTimeIcon from "@mui/icons-material/AccessTime";
import CancelIcon from "@mui/icons-material/Cancel";
import CheckIcon from "@mui/icons-material/Check";
import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import CloseIcon from "@mui/icons-material/Close";
import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import { answerRelayPairing, lookupRelayPairing } from "../lib/api";
import { errorText, useApp } from "../app/hooks";
import { LOGGERS_URL } from "./model";

/** Where the page is: checking a code, asking for one, or one of the drawn states (Brad's relay canvas, page 2). */
type View =
  | { kind: "checking" }
  | { kind: "entry"; typed: string; unknown: boolean; error: string | null }
  | { kind: "pending"; code: string; error: string | null }
  | { kind: "expired"; code: string }
  | { kind: "approved" }
  | { kind: "denied" };

const TITLE = "Connect Long Lines Relay";

/**
 * /relay/approve (and /relay): a signed-in user allows or denies a Long Lines Relay that is signing in. The code
 * comes from ?code= (the relay opens the page with it) or is typed; SQL reads it in any case, with or without
 * the hyphen.
 */
export function ApprovePage() {
  const { profile } = useApp();
  const [search, setSearch] = useSearchParams();
  const initial = search.get("code") ?? "";
  const [view, setView] = useState<View>(initial.trim() ? { kind: "checking" } : { kind: "entry", typed: "", unknown: false, error: null });
  const [busy, setBusy] = useState(false);
  const started = useRef(false);

  const check = async (typed: string) => {
    setBusy(true);
    try {
      const found = await lookupRelayPairing(typed);
      if (found.code !== null) setSearch({ code: found.code }, { replace: true });
      if (found.status === "pending") setView({ kind: "pending", code: found.code, error: null });
      else if (found.status === "expired") setView({ kind: "expired", code: found.code });
      else setView({ kind: "entry", typed, unknown: true, error: null });
    } catch (err) {
      setView({ kind: "entry", typed, unknown: false, error: errorText(err, "Couldn't check the code.") });
    } finally {
      setBusy(false);
    }
  };

  // The code the relay opened the page with, checked once (the ref keeps a re-render or StrictMode from asking again).
  useEffect(() => {
    if (started.current || !initial.trim()) return;
    started.current = true;
    void check(initial);
  });

  const answer = async (code: string, approve: boolean) => {
    setBusy(true);
    try {
      const result = await answerRelayPairing(code, approve);
      if (result.status === "approved") setView({ kind: "approved" });
      else if (result.status === "denied") setView({ kind: "denied" });
      else if (result.status === "expired") setView({ kind: "expired", code });
      else setView({ kind: "entry", typed: code, unknown: true, error: null });
    } catch (err) {
      setView({ kind: "pending", code, error: errorText(err, "Couldn't answer the relay.") });
    } finally {
      setBusy(false);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (view.kind === "entry" && view.typed.trim()) void check(view.typed);
  };

  let body: ReactNode;
  if (view.kind === "checking") {
    body = <LinearProgress />;
  } else if (view.kind === "entry") {
    body = (
      <Stack component="form" spacing={2} onSubmit={submit} noValidate>
        <Box>
          <Typography variant="h5" component="h1" gutterBottom>{TITLE}</Typography>
          <Typography variant="body2" color="text.secondary">Enter the code shown in the relay on your computer.</Typography>
        </Box>
        {view.error !== null && <Alert severity="error">{view.error}</Alert>}
        <TextField
          label="Code" value={view.typed} autoFocus fullWidth error={view.unknown}
          helperText={view.unknown ? "We don't recognize this code. Check it against the relay and try again." : undefined}
          onChange={(e) => setView({ kind: "entry", typed: e.target.value, unknown: false, error: null })}
          slotProps={{ htmlInput: { autoCapitalize: "characters", autoComplete: "off", spellCheck: false } }}
        />
        <Stack direction="row" sx={{ justifyContent: "flex-end" }}>
          <Button type="submit" variant="contained" disabled={busy || !view.typed.trim()}>Continue</Button>
        </Stack>
        <Typography variant="caption" color="text.secondary">
          Codes look like KQ7M-X4PD and last 10 minutes. If the relay shows a different code now, use that one.
        </Typography>
      </Stack>
    );
  } else if (view.kind === "pending") {
    body = (
      <Stack spacing={2.5}>
        <Box>
          <Typography variant="h5" component="h1" gutterBottom>{TITLE}</Typography>
          <Typography variant="body2" color="text.secondary">A computer is asking to post the contacts you log to Long Lines as spots.</Typography>
        </Box>
        <Paper variant="outlined" sx={{ p: 2 }}>
          <Typography variant="h4" component="p" align="center">
            {/* A bare <code> keeps the browser's monospace font; MUI 9 has no fontFamily prop. */}
            <Box component="code">{view.code}</Box>
          </Typography>
          <Typography variant="caption" color="text.secondary" component="p" align="center">
            Make sure this matches the code in the relay.
          </Typography>
        </Paper>
        <Stack spacing={1.5}>
          <Stack direction="row" spacing={1.5} sx={{ alignItems: "flex-start" }}>
            <CheckIcon color="success" fontSize="small" />
            <Typography variant="body2">
              Post contacts logged as <strong>{profile?.callsign ?? ""}</strong> as spots
            </Typography>
          </Stack>
          <Stack direction="row" spacing={1.5} sx={{ alignItems: "flex-start" }}>
            <CloseIcon color="disabled" fontSize="small" />
            <Typography variant="body2" color="text.secondary">
              Can't read or change your connections, groups, destinations or settings
            </Typography>
          </Stack>
        </Stack>
        <Alert severity="info">Spots from your log are visible to other Long Lines users, like spots from any other source.</Alert>
        {view.error !== null && <Alert severity="error">{view.error}</Alert>}
        <Stack direction="row" spacing={1} sx={{ justifyContent: "flex-end" }}>
          <Button disabled={busy} onClick={() => void answer(view.code, false)}>Deny</Button>
          <Button variant="contained" disabled={busy} onClick={() => void answer(view.code, true)}>Allow</Button>
        </Stack>
        <Typography variant="caption" color="text.secondary">
          You can disconnect this computer any time from <Link component={RouterLink} to="/api-tokens">API tokens</Link>.
        </Typography>
      </Stack>
    );
  } else if (view.kind === "expired") {
    body = (
      <Stack spacing={2.5}>
        <Box>
          <Typography variant="h5" component="h1" gutterBottom>{TITLE}</Typography>
          <Typography variant="body2" color="text.secondary">A computer asked to post the contacts you log to Long Lines as spots.</Typography>
        </Box>
        <Paper variant="outlined" sx={{ p: 2 }}>
          <Typography variant="h4" component="p" align="center" color="text.disabled">
            {/* <s> strikes the code through with the browser's own style. */}
            <Box component="s"><Box component="code">{view.code}</Box></Box>
          </Typography>
        </Paper>
        <Alert severity="warning" icon={<AccessTimeIcon />}>
          <AlertTitle>This code expired</AlertTitle>
          Codes last 10 minutes. In the relay, select Sign in with Long Lines to get a new one.
        </Alert>
      </Stack>
    );
  } else if (view.kind === "approved") {
    body = (
      <Stack spacing={2} sx={{ alignItems: "flex-start" }}>
        <CheckCircleIcon color="success" fontSize="large" />
        <Typography variant="h5" component="h1">Relay connected</Typography>
        <Typography variant="body2" color="text.secondary">
          This computer can now post your logged contacts as spots. You can close this tab and go back to the relay.
        </Typography>
        <Button href={LOGGERS_URL} target="_blank" rel="noopener noreferrer" endIcon={<OpenInNewIcon />}>Set up logging software</Button>
      </Stack>
    );
  } else {
    body = (
      <Stack spacing={2} sx={{ alignItems: "flex-start" }}>
        <CancelIcon color="disabled" fontSize="large" />
        <Typography variant="h5" component="h1">Relay not connected</Typography>
        <Typography variant="body2" color="text.secondary">
          You denied the request, so that computer can't post contacts to Long Lines. You can close this tab.
        </Typography>
        <Typography variant="body2" color="text.secondary">
          Denied by mistake? Select Sign in with Long Lines in the relay to get a new code.
        </Typography>
      </Stack>
    );
  }

  return (
    <Stack sx={{ alignItems: "center", width: "100%" }}>
      <Paper variant="outlined" sx={{ p: 3, width: "100%", maxWidth: 480 }}>{body}</Paper>
    </Stack>
  );
}
