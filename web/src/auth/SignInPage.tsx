import { useEffect, useState, type FormEvent } from "react";
import { Alert, Box, Button, Divider, Stack, Tab, Tabs, TextField, useMediaQuery, useTheme } from "@mui/material";
import { useLocation, useNavigate } from "react-router";
import GoogleIcon from "@mui/icons-material/Google";
import { signIn, signInWithGoogle, signUp } from "../lib/api";
import { isValidCallsign, normalizeCallsign } from "../lib/callsign";
import { AuthFrame } from "./AuthFrame";
import { clearReturnPath, saveReturnPath } from "./returnPath";
import { errorText, useApp } from "../app/hooks";

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

interface LocationState {
  from?: string;
  notice?: string;
}

type Mode = "signin" | "signup";

/**
 * Sign in and Create account, on a page of their own with no nav (/signin and /signup, which
 * opens on Create account). Signed in, the app's own shell takes over.
 */
export function SignInPage({ initialMode }: { initialMode: Mode }) {
  const navigate = useNavigate();
  const location = useLocation();
  const theme = useTheme();
  // Autofocus only where a phone's keyboard won't cover the form. noSsr so the
  // first render already knows the viewport; autoFocus is only honored on mount.
  const desktop = useMediaQuery(theme.breakpoints.up("md"), { noSsr: true });
  const state = (location.state ?? {}) as LocationState;
  const { signInNotice, setSignInNotice } = useApp();
  const [mode, setMode] = useState<Mode>(initialMode);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(state.notice ?? signInNotice ?? null);
  useEffect(() => {
    if (signInNotice) setSignInNotice(null); // consumed into local state above
  }, [signInNotice, setSignInNotice]);
  const [busy, setBusy] = useState(false);

  const [ident, setIdent] = useState("");
  const [pw, setPw] = useState("");

  const [su, setSu] = useState({ callsign: "", name: "", email: "", password: "", confirm: "" });
  const setF = (k: keyof typeof su, v: string) => setSu((x) => ({ ...x, [k]: v }));
  const [touched, setTouched] = useState<Partial<Record<keyof typeof su, boolean>>>({});
  const touch = (k: keyof typeof su) => setTouched((t) => ({ ...t, [k]: true }));

  const switchMode = (m: Mode) => {
    setMode(m);
    setError(null);
    setInfo(null);
  };

  const doSignIn = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await signIn(ident, pw);
      clearReturnPath(); // from a Google attempt abandoned on Google's page; state.from goes there now
      void navigate(state.from ?? "/home", { replace: true });
    } catch (err) {
      setError(errorText(err, "Couldn't sign in."));
    } finally {
      setBusy(false);
    }
  };

  const csErr = !!touched.callsign && !isValidCallsign(su.callsign);
  const emErr = !!touched.email && !EMAIL_RE.test(su.email);
  const pwErr = !!touched.password && su.password.length < 8;
  const cfErr = !!touched.confirm && su.confirm !== su.password;
  const signupOk = isValidCallsign(su.callsign) && EMAIL_RE.test(su.email) && su.password.length >= 8 && su.confirm === su.password;

  const doSignUp = async (e: FormEvent) => {
    e.preventDefault();
    setTouched({ callsign: true, email: true, password: true, confirm: true });
    if (!signupOk) return;
    setBusy(true);
    setError(null);
    const callsign = normalizeCallsign(su.callsign);
    try {
      await signUp({ callsign, name: su.name.trim(), email: su.email.trim(), password: su.password });
      void navigate("/check-email", { state: { email: su.email.trim() } });
    } catch (err) {
      setError(errorText(err, "Couldn't create your account."));
    } finally {
      setBusy(false);
    }
  };

  // Leaves the page for Google's sign-in, so busy stays on until the browser goes. Router state
  // doesn't survive the trip, so `from` waits in sessionStorage for the site root (App's ToHome).
  const doGoogle = async () => {
    setBusy(true);
    setError(null);
    saveReturnPath(state.from);
    try {
      await signInWithGoogle();
    } catch (err) {
      clearReturnPath();
      setError(errorText(err, "Couldn't sign in with Google."));
      setBusy(false);
    }
  };

  // A Google account that is new here signs up: it picks its callsign on the next screen.
  const google = (
    <>
      <Divider>or</Divider>
      <Button variant="outlined" size="large" startIcon={<GoogleIcon />} onClick={() => void doGoogle()} disabled={busy} fullWidth>
        {mode === "signin" ? "Sign in with Google" : "Sign up with Google"}
      </Button>
    </>
  );

  const tabs = (
    <Tabs value={mode} onChange={(_e, v: Mode) => switchMode(v)} variant="fullWidth">
      <Tab value="signin" label="Sign in" />
      <Tab value="signup" label="Create account" />
    </Tabs>
  );

  return (
    <AuthFrame busy={busy} tabs={tabs}>
      <Box sx={{ p: 3 }}>
        {info && <Alert severity="success" sx={{ mb: 2 }} onClose={() => setInfo(null)}>{info}</Alert>}
        {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}

        {mode === "signin" && (
          <Box component="form" onSubmit={(e) => void doSignIn(e)} noValidate>
            <Stack spacing={2}>
              <TextField label="Email" type="email" value={ident} onChange={(e) => setIdent(e.target.value)} autoComplete="username" autoFocus={desktop} fullWidth />
              <TextField label="Password" type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="current-password" fullWidth />
              <Button type="submit" variant="contained" size="large" disabled={!ident || !pw || busy} fullWidth>Sign in</Button>
              <Button size="small" onClick={() => void navigate("/reset-password")} sx={{ alignSelf: "center" }}>Forgot your password?</Button>
              {google}
            </Stack>
          </Box>
        )}

        {mode === "signup" && (
          <Box component="form" onSubmit={(e) => void doSignUp(e)} noValidate>
            <Stack spacing={2}>
              <TextField
                label="Callsign" value={su.callsign} onChange={(e) => setF("callsign", e.target.value.toUpperCase().trim())} onBlur={() => touch("callsign")}
                error={csErr} helperText={csErr ? "Enter a valid amateur callsign, like KK4PWJ." : "Your amateur callsign, like KK4PWJ."}
                autoComplete="off" autoFocus={desktop} required fullWidth
              />
              <TextField label="Name" value={su.name} onChange={(e) => setF("name", e.target.value)} autoComplete="name" helperText="Optional" fullWidth />
              <TextField
                label="Email" type="email" value={su.email} onChange={(e) => setF("email", e.target.value)} onBlur={() => touch("email")}
                error={emErr} helperText={emErr ? "Enter a valid email address." : "For password resets. We don't send newsletters."}
                autoComplete="email" required fullWidth
              />
              <TextField
                label="Password" type="password" value={su.password} onChange={(e) => setF("password", e.target.value)} onBlur={() => touch("password")}
                error={pwErr} helperText={pwErr ? "Use at least 8 characters." : "At least 8 characters."} autoComplete="new-password" required fullWidth
              />
              <TextField
                label="Confirm password" type="password" value={su.confirm} onChange={(e) => setF("confirm", e.target.value)} onBlur={() => touch("confirm")}
                error={cfErr} helperText={cfErr ? "Passwords don't match." : " "} autoComplete="new-password" required fullWidth
              />
              <Button type="submit" variant="contained" size="large" disabled={busy} fullWidth>Create account</Button>
              {google}
            </Stack>
          </Box>
        )}
      </Box>
    </AuthFrame>
  );
}
