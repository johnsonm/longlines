import { useState, type FormEvent } from "react";
import { Alert, Box, Button, Stack, TextField, Typography } from "@mui/material";
import { AuthFrame } from "./AuthFrame";
import { completeProfile, signOut } from "../lib/api";
import { isValidCallsign, normalizeCallsign } from "../lib/callsign";
import { pushCleanup } from "../pwa/push";
import { errorText, useApp } from "../app/hooks";

/** Google's display name, when the account has one, to start the Name field. */
function googleName(metadata: Record<string, unknown> | undefined): string {
  const name = metadata?.full_name ?? metadata?.name;
  return typeof name === "string" ? name : "";
}

/**
 * The first screen of an account made with Google: Google gives no callsign,
 * so nothing else opens until the account has one. RequireAuth shows it while
 * the profile is missing.
 */
export function CompleteProfilePage() {
  const { session, refreshProfile, notify } = useApp();
  const [callsign, setCallsign] = useState("");
  const [name, setName] = useState(() => googleName(session?.user.user_metadata));
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const csErr = touched && !isValidCallsign(callsign);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (!isValidCallsign(callsign)) return;
    setBusy(true);
    setError(null);
    try {
      await completeProfile(normalizeCallsign(callsign), name.trim());
      await refreshProfile();
    } catch (err) {
      setError(errorText(err, "Couldn't finish creating your account."));
      setBusy(false);
    }
  };

  const leave = () => void signOut("local", pushCleanup).catch(() => notify("Couldn't sign out. Try again."));

  return (
    <AuthFrame busy={busy}>
      <Box component="form" onSubmit={(e) => void submit(e)} noValidate sx={{ p: 3 }}>
        <Stack spacing={2}>
          <Typography variant="h6" component="h1">Finish creating your account</Typography>
          <Typography variant="body2" color="text.secondary">
            {session?.user.email ? `Signed in with Google as ${session.user.email}. ` : "Signed in with Google. "}
            Add your callsign to finish.
          </Typography>
          {error && <Alert severity="error">{error}</Alert>}
          <TextField
            label="Callsign" value={callsign} onChange={(e) => setCallsign(e.target.value.toUpperCase().trim())} onBlur={() => setTouched(true)}
            error={csErr} helperText={csErr ? "Enter a valid amateur callsign, like KK4PWJ." : "Your amateur callsign, like KK4PWJ."}
            autoComplete="username" autoFocus required fullWidth
          />
          <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" helperText="Optional" fullWidth />
          <Button type="submit" variant="contained" size="large" disabled={busy} fullWidth>Create account</Button>
          <Button size="small" onClick={leave} disabled={busy} sx={{ alignSelf: "center" }}>Use a different account</Button>
        </Stack>
      </Box>
    </AuthFrame>
  );
}
