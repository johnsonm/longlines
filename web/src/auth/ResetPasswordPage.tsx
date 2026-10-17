import { useState, type FormEvent } from "react";
import { Box, Button, Stack, TextField, Typography } from "@mui/material";
import { useNavigate } from "react-router";
import { AuthFrame } from "./AuthFrame";
import { requestPasswordReset } from "../lib/api";

export function ResetPasswordPage() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await requestPasswordReset(email.trim());
    } catch {
      // The outcome is deliberately the same message either way.
    } finally {
      setBusy(false);
    }
    void navigate("/signin", { state: { notice: `If an account uses ${email.trim()}, a reset link is on its way.` } });
  };

  return (
    <AuthFrame busy={busy}>
      <Box component="form" onSubmit={(e) => void submit(e)} noValidate sx={{ p: 3 }}>
        <Typography variant="h6" gutterBottom>Reset your password</Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Enter the email on your account and we'll send a link to set a new password.
        </Typography>
        <Stack spacing={2}>
          <TextField label="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" autoFocus fullWidth />
          <Button type="submit" variant="contained" disabled={!email || busy} fullWidth>Send reset link</Button>
          <Button size="small" onClick={() => void navigate("/signin")}>Back to sign in</Button>
        </Stack>
      </Box>
    </AuthFrame>
  );
}
