import { useState, type FormEvent } from "react";
import { Alert, Box, Button, Stack, TextField, Typography } from "@mui/material";
import { useNavigate } from "react-router";
import { AuthFrame } from "./AuthFrame";
import { updatePassword } from "../lib/api";
import { errorText, useApp } from "../app/hooks";

export function SetPasswordPage() {
  const navigate = useNavigate();
  const { session, sessionLoading, notify } = useApp();
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const short = next.length > 0 && next.length < 8;
  const mismatch = confirm.length > 0 && confirm !== next;
  const ok = next.length >= 8 && confirm === next;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      await updatePassword(next);
      notify("Password changed");
      void navigate("/home", { replace: true });
    } catch (err) {
      setError(errorText(err, "Couldn't change your password."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthFrame busy={busy || sessionLoading}>
      <Box component="form" onSubmit={(e) => void submit(e)} noValidate sx={{ p: 3 }}>
        <Typography variant="h6" gutterBottom>Set a new password</Typography>
        {!sessionLoading && !session && (
          <Alert severity="warning" sx={{ mb: 2 }}>
            This link has expired or was already used. Request a new one from the sign-in page.
          </Alert>
        )}
        {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
        <Stack spacing={2}>
          <TextField
            label="New password" type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password"
            error={short} helperText={short ? "Use at least 8 characters." : "At least 8 characters."} autoFocus fullWidth
          />
          <TextField
            label="Confirm new password" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password"
            error={mismatch} helperText={mismatch ? "Passwords don't match." : " "} fullWidth
          />
          <Button type="submit" variant="contained" disabled={!ok || busy || !session} fullWidth>Set password</Button>
          <Button size="small" onClick={() => void navigate("/signin")}>Back to sign in</Button>
        </Stack>
      </Box>
    </AuthFrame>
  );
}
