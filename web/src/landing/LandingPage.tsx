import type { ReactNode } from "react";
import { Avatar, Box, Button, Card, CardContent, Chip, Grid, Paper, Stack, Typography, useMediaQuery, useTheme } from "@mui/material";
import { Link as RouterLink } from "react-router";
import ChatIcon from "@mui/icons-material/Chat";
import DesktopWindowsIcon from "@mui/icons-material/DesktopWindows";
import NotificationsIcon from "@mui/icons-material/Notifications";
import { Steps } from "../layout/Steps";

// Copy is Brad's "Long Lines landing page" canvas (Desktop board), with BOTA named WWBOTA and
// no Email destination, which Long Lines doesn't have.

const STEPS = [
  {
    title: "Pick a source",
    body: "Choose from activations, skimmers, packet and DX cluster. Each source lists exactly what it sends.",
    chips: ["POTA", "SOTA", "WWFF", "IOTA", "WWBOTA", "DX cluster", "RBN", "APRS-IS"],
  },
  {
    title: "Add a filter",
    body: "Match on callsign, band, mode, park, summit or state. Use a group of callsigns, or a goal that drops what you've already worked.",
    chips: ["Callsign", "Band", "Mode", "Park", "Summit", "State", "Group", "Goal"],
  },
  {
    title: "Send it anywhere",
    body: "Deliver matches to your phone, Discord, a webhook or your logger. For push, Discord and webhooks you choose which spot fields appear, and in what order.",
    chips: ["Push", "Discord", "Webhook", "Local DX cluster"],
  },
];

const GOAL_STEPS = [
  { title: "Set a goal", text: "Pick a goal like Worked All States, or build your own. Add it to a connection as a filter." },
  {
    title: "Relay reads your log",
    text: "Long Lines Relay runs on your computer, on Windows, macOS or Linux. It reads contacts from N1MM, or any logger that sends its UDP format.",
  },
  {
    title: "Spots come back to your logger",
    text: "Relay runs a local DX cluster, so matches show up in any logger that accepts a DX cluster connection.",
  },
];

const MORE = [
  {
    title: "Groups",
    body: "Keep a roster of callsigns for your club and use it in any filter. Update it from your membership system with the API. Each group gets a stats page you can make public in one click.",
  },
  {
    title: "Public stats",
    body: "Stats for every callsign and reference we see. No account needed. See when it was active, how often it was heard, and on which modes.",
  },
];

/** The signed-out site root, in PublicShell. Signed in, the root goes to Home instead. */
export function LandingPage() {
  const theme = useTheme();
  const desktop = useMediaQuery(theme.breakpoints.up("md"));
  return (
    <Stack spacing={{ xs: 6, md: 8 }} sx={{ py: { md: 4 } }}>
      <Grid container spacing={{ xs: 4, md: 8 }} sx={{ alignItems: "center" }}>
        <Grid size={{ xs: 12, md: 7 }}>
          <Stack spacing={3}>
            <Typography variant="overline" color="primary" component="p">For amateur radio operators</Typography>
            <Typography variant={desktop ? "h3" : "h4"} component="h1">Ham radio spots, routed where you want them.</Typography>
            <Typography variant="h6" component="p" color="text.secondary">
              Long Lines sends live spots to your phone, Discord, a webhook or your logging software, filtered to what you care about.
            </Typography>
            <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5}>
              <Button variant="contained" size="large" component={RouterLink} to="/signup">Create account</Button>
              <Button variant="outlined" size="large" component={RouterLink} to="/lookup">Look up a callsign</Button>
            </Stack>
            <Typography variant="body2" color="text.secondary">
              Free. The band map, callsign lookup and reference lookup work without an account.
            </Typography>
          </Stack>
        </Grid>
        <Grid size={{ xs: 12, md: 5 }}>
          <Stack component="figure" spacing={1.5} aria-labelledby="delivery-caption" sx={{ m: 0 }}>
            <Typography id="delivery-caption" component="figcaption" variant="body2" color="text.secondary">One POTA spot, delivered three ways</Typography>
            <Delivery icon={<NotificationsIcon fontSize="small" aria-hidden />} label="Push to your phone">
              <Typography variant="subtitle1">KK4PWJ at US-2799</Typography>
              <Typography variant="body2" color="text.secondary">14062.0 kHz · CW · POTA</Typography>
            </Delivery>
            <Delivery icon={<ChatIcon fontSize="small" aria-hidden />} label="Discord · #pota-spots">
              <Typography variant="body1">KK4PWJ · US-2799 · 14062.0 kHz · CW</Typography>
            </Delivery>
            <Delivery icon={<DesktopWindowsIcon fontSize="small" aria-hidden />} label="Your logger, through the local DX cluster">
              {/* A bare <code> keeps the browser's monospace font; MUI 9 has no fontFamily prop. */}
              <Box component="code" sx={{ overflowWrap: "anywhere" }}>DX de LONGLINES: 14062.0 KK4PWJ POTA US-2799 CW 1842Z</Box>
            </Delivery>
          </Stack>
        </Grid>
      </Grid>

      <Stack spacing={3} component="section" aria-labelledby="how-title">
        <Box>
          <Typography id="how-title" variant={desktop ? "h4" : "h5"} component="h2" gutterBottom>How it works</Typography>
          <Typography variant="body1" color="text.secondary">One source in, zero or more destinations out, with a filter in the middle.</Typography>
        </Box>
        <Grid container spacing={2}>
          {STEPS.map((s, i) => (
            <Grid key={s.title} size={{ xs: 12, md: 4 }}>
              <Card variant="outlined" sx={{ height: "100%" }}>
                <CardContent sx={{ height: "100%", display: "flex", flexDirection: "column", gap: 1.5 }}>
                  <Avatar aria-hidden>{i + 1}</Avatar>
                  <Typography variant="h6" component="h3">{s.title}</Typography>
                  <Typography variant="body1" color="text.secondary">{s.body}</Typography>
                  <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: "wrap", mt: "auto", pt: 0.5 }}>
                    {s.chips.map((c) => <Chip key={c} label={c} variant="outlined" />)}
                  </Stack>
                </CardContent>
              </Card>
            </Grid>
          ))}
        </Grid>
        <Typography variant="body2" color="text.secondary">More sources and destinations are added regularly.</Typography>
      </Stack>

      <Card variant="outlined" component="section" aria-labelledby="goals-title">
        <CardContent sx={{ p: { xs: 2.5, md: 4 } }}>
          <Grid container spacing={{ xs: 3, md: 7 }}>
            <Grid size={{ xs: 12, md: 5 }}>
              <Stack spacing={2}>
                <Typography id="goals-title" variant={desktop ? "h4" : "h5"} component="h2">Goals keep up with your log</Typography>
                <Typography variant="body1" color="text.secondary">
                  Tell Long Lines what you still need, like the states left for Worked All States. As you log contacts, it stops sending you
                  what you've worked.
                </Typography>
                <Typography variant="h6" component="p">Work Georgia, and you stop hearing about Georgia.</Typography>
              </Stack>
            </Grid>
            <Grid size={{ xs: 12, md: 7 }}>
              <Steps steps={GOAL_STEPS} />
            </Grid>
          </Grid>
        </CardContent>
      </Card>

      <Stack spacing={3} component="section" aria-labelledby="more-title">
        <Typography id="more-title" variant={desktop ? "h4" : "h5"} component="h2">Groups and public stats</Typography>
        <Grid container spacing={2}>
          {MORE.map((m) => (
            <Grid key={m.title} size={{ xs: 12, md: 6 }}>
              <Card variant="outlined" sx={{ height: "100%" }}>
                <CardContent>
                  <Typography variant="h6" component="h3" gutterBottom>{m.title}</Typography>
                  <Typography variant="body1" color="text.secondary">{m.body}</Typography>
                </CardContent>
              </Card>
            </Grid>
          ))}
        </Grid>
      </Stack>
    </Stack>
  );
}

/** One way the spot arrives: what it is, then the spot as it shows there. */
function Delivery({ icon, label, children }: { icon: ReactNode; label: string; children: ReactNode }) {
  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      {/* The icon takes the label's color. */}
      <Typography variant="subtitle2" color="text.secondary" sx={{ display: "flex", alignItems: "center", gap: 1, mb: 1 }}>
        {icon}
        {label}
      </Typography>
      {children}
    </Paper>
  );
}
