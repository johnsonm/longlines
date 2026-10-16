import { useEffect, useState, type FormEvent } from "react";
import {
  Alert, Box, Button, Card, CardContent, CardHeader, CardMedia, Chip, Divider, Grid, LinearProgress, Link, Paper, Stack, Tab, Tabs,
  TextField, Typography, useMediaQuery, useTheme,
} from "@mui/material";
import { useLocation, useNavigate } from "react-router";
import CheckIcon from "@mui/icons-material/Check";
import FilterAltIcon from "@mui/icons-material/FilterAlt";
import GraphicEqIcon from "@mui/icons-material/GraphicEq";
import GroupsIcon from "@mui/icons-material/Groups";
import InsightsIcon from "@mui/icons-material/Insights";
import KeyIcon from "@mui/icons-material/Key";
import PersonSearchIcon from "@mui/icons-material/PersonSearch";
import SendIcon from "@mui/icons-material/Send";
import SensorsIcon from "@mui/icons-material/Sensors";
import heroUrl from "../assets/landing-hero.jpg";
import { callsignAvailable, signIn, signUp } from "../lib/api";
import { isValidCallsign, normalizeCallsign } from "../lib/callsign";
import { errorText, useApp } from "../app/hooks";

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

const BENEFITS = [
  "Skip the firehose. Hear only about the stations, parks and bands you want.",
  "Never miss a rare one. Matches are sent as they are spotted.",
  "Keep your history. Every spot from every source is stored and searchable by callsign.",
];

const STEPS = [
  {
    icon: <SensorsIcon />,
    title: "Pick a source",
    body: "Choose from activations, skimmers, packet and digital modes. Each source lists exactly what it sends.",
    chips: ["POTA", "SOTA", "DX Cluster", "RBN", "APRS-IS"],
  },
  {
    icon: <FilterAltIcon />,
    title: "Add a filter",
    body: "Match on callsign, band, mode, park, summit or state. Or skip it and pass everything.",
    chips: ["Callsign", "Band", "Park", "State"],
  },
  {
    icon: <SendIcon />,
    title: "Send it anywhere",
    body: "Deliver matches to Discord channels and webhooks. A connection can also have no destination yet.",
    chips: ["Discord", "Webhook"],
  },
];

const REASONS = [
  { icon: <GroupsIcon color="primary" aria-hidden />, title: "Built for clubs", body: "Share a roster as a group and use it in any filter." },
  { icon: <GraphicEqIcon color="primary" aria-hidden />, title: "See who is on now", body: "The band map and profiles are public. No account needed." },
  { icon: <InsightsIcon color="primary" aria-hidden />, title: "Know the numbers", body: "Recent activity across every source, open to everyone." },
  { icon: <KeyIcon color="primary" aria-hidden />, title: "Automate setup", body: "Manage connections, groups and destinations through the API with a scoped token." },
];

interface LocationState {
  from?: string;
  notice?: string;
}

export function SignInPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const theme = useTheme();
  // Autofocus only where the keyboard won't scroll the intro off screen. noSsr so the
  // first render already knows the viewport; autoFocus is only honored on mount.
  const desktop = useMediaQuery(theme.breakpoints.up("md"), { noSsr: true });
  const state = (location.state ?? {}) as LocationState;
  const { signInNotice, setSignInNotice } = useApp();
  const [mode, setMode] = useState<"signin" | "signup">("signin");
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

  const switchMode = (m: "signin" | "signup") => {
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
      void navigate(state.from ?? "/sources", { replace: true });
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
      if (!(await callsignAvailable(callsign))) {
        setError("That callsign is already taken.");
        return;
      }
      await signUp({ callsign, name: su.name.trim(), email: su.email.trim(), password: su.password });
      void navigate("/check-email", { state: { email: su.email.trim() } });
    } catch (err) {
      setError(errorText(err, "Couldn't create your account."));
    } finally {
      setBusy(false);
    }
  };

  const signInCard = (
    <Paper elevation={4}>
      <Tabs value={mode} onChange={(_e, v: "signin" | "signup") => switchMode(v)} variant="fullWidth">
        <Tab value="signin" label="Sign in" />
        <Tab value="signup" label="Create account" />
      </Tabs>
      {busy && <LinearProgress />}
      <Box sx={{ p: 3 }}>
        {info && <Alert severity="success" sx={{ mb: 2 }} onClose={() => setInfo(null)}>{info}</Alert>}
        {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}

        {mode === "signin" && (
          <Box component="form" onSubmit={(e) => void doSignIn(e)} noValidate>
            <Stack spacing={2}>
              <TextField label="Callsign or email" value={ident} onChange={(e) => setIdent(e.target.value)} autoComplete="username" autoFocus={desktop} fullWidth />
              <TextField label="Password" type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="current-password" fullWidth />
              <Button type="submit" variant="contained" size="large" disabled={!ident || !pw || busy} fullWidth>Sign in</Button>
              <Button size="small" onClick={() => void navigate("/reset-password")} sx={{ alignSelf: "center" }}>Forgot your password?</Button>
            </Stack>
          </Box>
        )}

        {mode === "signup" && (
          <Box component="form" onSubmit={(e) => void doSignUp(e)} noValidate>
            <Stack spacing={2}>
              <TextField
                label="Callsign" value={su.callsign} onChange={(e) => setF("callsign", e.target.value.toUpperCase().trim())} onBlur={() => touch("callsign")}
                error={csErr} helperText={csErr ? "Enter a valid amateur callsign, like KK4PWJ." : "You'll use this to sign in."}
                autoComplete="username" autoFocus={desktop} required fullWidth
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
            </Stack>
          </Box>
        )}
      </Box>
    </Paper>
  );

  return (
    <Stack spacing={{ xs: 4, md: 6 }} sx={{ py: { md: 2 } }}>
      <Grid container spacing={6} sx={{ alignItems: "center" }}>
        <Grid size={{ xs: 12, md: 7 }}>
          <Typography variant="overline" color="primary" component="p">For amateur radio operators</Typography>
          <Typography variant={desktop ? "h3" : "h4"} component="h1" sx={{ mt: 0.5, mb: 2 }}>
            Get the spots you want, sent where you want them.
          </Typography>
          <Typography variant="subtitle1" color="text.secondary" sx={{ mb: 2 }}>
            Long Lines connects to every major amateur radio spotting network, including POTA, SOTA and DX Cluster, and more, stores every
            spot, and forwards the ones that match your filters to places like Discord channels and webhooks.
          </Typography>
          <Stack component="ul" sx={{ listStyle: "none", p: 0, mt: 1, mb: 3 }}>
            {BENEFITS.map((b) => (
              <Stack component="li" key={b} direction="row" spacing={2} sx={{ py: 0.75, alignItems: "flex-start" }}>
                <CheckIcon color="success" aria-hidden />
                <Typography variant="body1">{b}</Typography>
              </Stack>
            ))}
          </Stack>
          <Stack direction={{ xs: "column", sm: "row" }} spacing={1} useFlexGap sx={{ flexWrap: "wrap" }}>
            <Button variant="contained" size="large" startIcon={<InsightsIcon />} onClick={() => void navigate("/stats")}>
              View recent activity
            </Button>
            <Button variant="outlined" size="large" startIcon={<PersonSearchIcon />} onClick={() => void navigate("/lookup")}>
              Look up a callsign
            </Button>
          </Stack>
        </Grid>
        <Grid size={{ xs: 12, md: 5 }}>{signInCard}</Grid>
      </Grid>

      <Stack spacing={2}>
        <Box>
          <Typography variant={desktop ? "h5" : "h6"} component="h2">How it works</Typography>
          <Typography variant="body2" color="text.secondary">One source in, zero or more destinations out, with a filter in the middle.</Typography>
        </Box>
        <Grid container spacing={2}>
          {STEPS.map((s, i) => (
            <Grid key={s.title} size={{ xs: 12, md: 4 }}>
              <Card variant="outlined" sx={{ height: "100%" }}>
                <CardContent sx={{ height: "100%", display: "flex", flexDirection: "column", gap: 2 }}>
                  <Stack direction="row" spacing={2} sx={{ alignItems: "center" }}>
                    <Chip
                      aria-hidden color="primary" icon={s.icon}
                      sx={{ width: 40, height: 40, borderRadius: "50%", "& .MuiChip-icon": { m: 0 }, "& .MuiChip-label": { display: "none" } }}
                    />
                    <Typography variant="overline" color="text.secondary">Step {i + 1}</Typography>
                  </Stack>
                  <Typography variant="h6" component="h3">{s.title}</Typography>
                  <Typography variant="body2" color="text.secondary">{s.body}</Typography>
                  <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: "wrap", mt: "auto" }}>
                    {s.chips.map((c) => <Chip key={c} label={c} size="small" variant="outlined" />)}
                  </Stack>
                </CardContent>
              </Card>
            </Grid>
          ))}
        </Grid>
      </Stack>

      <Grid container spacing={2}>
        <Grid size={{ xs: 12, md: 7 }}>
          <Card variant="outlined" sx={{ height: "100%" }}>
            <CardMedia
              component="img"
              image={heroUrl}
              alt="Microwave relay tower with horn antennas, Mojave National Preserve"
              sx={{ height: { xs: 200, md: 320 }, objectFit: "cover", objectPosition: "50% 40%" }}
            />
            <CardContent>
              <Typography variant="caption" color="text.secondary">
                Microwave relay tower, Mojave National Preserve. Photo: Tony Webster,{" "}
                <Link href="https://creativecommons.org/licenses/by-sa/2.0/" target="_blank" rel="noopener" color="inherit">CC BY-SA 2.0</Link>.
              </Typography>
            </CardContent>
          </Card>
        </Grid>
        <Grid size={{ xs: 12, md: 5 }}>
          <Card variant="outlined" sx={{ height: "100%" }}>
            <CardHeader title="Why Long Lines" subheader="Built for operators who chase spots" />
            <CardContent sx={{ pt: 0 }}>
              {REASONS.map((r, i) => (
                <Box key={r.title}>
                  {i > 0 && <Divider />}
                  <Stack direction="row" spacing={2} sx={{ py: 1.5, alignItems: "flex-start" }}>
                    {r.icon}
                    <Box>
                      <Typography variant="subtitle2" component="h3">{r.title}</Typography>
                      <Typography variant="body2" color="text.secondary">{r.body}</Typography>
                    </Box>
                  </Stack>
                </Box>
              ))}
            </CardContent>
          </Card>
        </Grid>
      </Grid>

      <Typography variant="caption" color="text.secondary" component="p" align="center">
        Named for the AT&amp;T Long Lines microwave relay network.
      </Typography>
    </Stack>
  );
}
