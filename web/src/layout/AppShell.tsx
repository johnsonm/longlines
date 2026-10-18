import { useState, useSyncExternalStore, type FormEvent, type ReactNode } from "react";
import {
  AppBar, Avatar, Badge, Box, Button, Container, Divider, Drawer, IconButton, InputBase, List,
  ListItemButton, ListItemIcon, ListItemText, Menu, MenuItem, Paper, ToggleButton, ToggleButtonGroup, Toolbar, Tooltip, Typography,
  useColorScheme, useMediaQuery, useTheme,
} from "@mui/material";
import MenuIcon from "@mui/icons-material/Menu";
import SensorsIcon from "@mui/icons-material/Sensors";
import GraphicEqIcon from "@mui/icons-material/GraphicEq";
import FilterListIcon from "@mui/icons-material/FilterList";
import GroupsIcon from "@mui/icons-material/Groups";
import SendIcon from "@mui/icons-material/Send";
import InsightsIcon from "@mui/icons-material/Insights";
import PersonSearchIcon from "@mui/icons-material/PersonSearch";
import KeyIcon from "@mui/icons-material/Key";
import SearchIcon from "@mui/icons-material/Search";
import LightModeIcon from "@mui/icons-material/LightMode";
import DarkModeIcon from "@mui/icons-material/DarkMode";
import SettingsBrightnessIcon from "@mui/icons-material/SettingsBrightness";
import { useLocation, useNavigate } from "react-router";
import { useApp } from "../app/hooks";
import { signOut } from "../lib/api";
import { INVALID_CALLSIGN, lookupPath } from "../profile/format";
import { installState, promptInstall, subscribeInstall } from "../pwa/install";
import { pushCleanup } from "../pwa/push";
import { Footer } from "./Footer";
import { InstallDialog } from "./InstallDialog";

const NAV = [
  { id: "sources", label: "Sources", icon: <SensorsIcon /> },
  { id: "connections", label: "Connections", icon: <FilterListIcon /> },
  { id: "destinations", label: "Destinations", icon: <SendIcon /> },
  { id: "groups", label: "Groups", icon: <GroupsIcon /> },
  { id: "band-map", label: "Band map", icon: <GraphicEqIcon /> },
  { id: "lookup", label: "Callsign lookup", icon: <PersonSearchIcon /> },
  { id: "stats", label: "Stats", icon: <InsightsIcon /> },
  { id: "api-tokens", label: "API tokens", icon: <KeyIcon /> },
];
const DRAWER = 232;

export function AppShell({ children, destinationsFailing }: { children: ReactNode; destinationsFailing: boolean }) {
  const theme = useTheme();
  const mobile = useMediaQuery(theme.breakpoints.down("md"));
  const navigate = useNavigate();
  const location = useLocation();
  const { profile, session, notify } = useApp();
  const [navOpen, setNavOpen] = useState(false);
  const [menuEl, setMenuEl] = useState<HTMLElement | null>(null);
  const [installOpen, setInstallOpen] = useState(false);
  // Chrome's captured prompt, or Safari's steps; `none` once installed.
  const install = useSyncExternalStore(subscribeInstall, installState);
  const section = location.pathname.replace(/^\//, "").split("/")[0] ?? "";
  // A profile belongs to Callsign lookup in the nav.
  const page = section === "call" ? "lookup" : section;
  const callsign = profile?.callsign ?? "";
  const initials = callsign.slice(0, 2) || "?";

  const go = (path: string) => {
    setMenuEl(null);
    setNavOpen(false);
    void navigate(`/${path}`);
  };

  const handleInstall = () => {
    setMenuEl(null);
    if (install === "ios") setInstallOpen(true);
    else void promptInstall();
  };

  // This browser's push device goes with the session (pushCleanup is best effort).
  const handleSignOut = async () => {
    setMenuEl(null);
    try {
      await signOut("local", pushCleanup);
    } catch {
      notify("Couldn't sign out. Try again.");
    }
  };

  const nav = (
    <Box>
      <Toolbar />
      <List>
        {NAV.map((n) => (
          <ListItemButton key={n.id} selected={page === n.id} onClick={() => go(n.id)}>
            <ListItemIcon>
              {n.id === "destinations"
                ? <Badge color="error" variant="dot" invisible={!destinationsFailing}>{n.icon}</Badge>
                : n.icon}
            </ListItemIcon>
            <ListItemText primary={n.label} />
          </ListItemButton>
        ))}
      </List>
    </Box>
  );

  return (
    <Box sx={{ display: "flex" }}>
      <AppBar position="fixed" sx={{ zIndex: (t) => t.zIndex.drawer + 1, pt: "env(safe-area-inset-top, 0px)" }}>
        <Toolbar>
          {mobile && (
            <IconButton color="inherit" edge="start" onClick={() => setNavOpen(true)} sx={{ mr: 1 }} aria-label="Open navigation">
              <MenuIcon />
            </IconButton>
          )}
          <Typography variant="h6" sx={{ flexGrow: 1 }}>Long Lines</Typography>
          {mobile
            ? (
              <IconButton color="inherit" onClick={() => go("lookup")} aria-label="Callsign lookup">
                <SearchIcon />
              </IconButton>
            )
            : <BarSearch />}
          <IconButton color="inherit" onClick={(e) => setMenuEl(e.currentTarget)} aria-label="Account menu" sx={{ display: { xs: "inline-flex", sm: "none" } }}>
            <Avatar sx={{ width: 32, height: 32 }}>{initials}</Avatar>
          </IconButton>
          <Button
            color="inherit"
            onClick={(e) => setMenuEl(e.currentTarget)}
            startIcon={<Avatar sx={{ width: 28, height: 28 }}>{initials}</Avatar>}
            aria-label="Account menu"
            sx={{ display: { xs: "none", sm: "inline-flex" } }}
          >
            {callsign}
          </Button>
          <Menu
            anchorEl={menuEl}
            open={!!menuEl}
            onClose={() => setMenuEl(null)}
            anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
            transformOrigin={{ vertical: "top", horizontal: "right" }}
          >
            <Box sx={{ px: 2, py: 1 }}>
              <Typography variant="subtitle2">{profile?.name || callsign}</Typography>
              <Typography variant="body2" color="text.secondary">{session?.user.email}</Typography>
            </Box>
            <Divider />
            <ThemeSwitch />
            <Divider />
            <MenuItem onClick={() => go("account")}>Account</MenuItem>
            {install !== "none" && <MenuItem onClick={handleInstall}>Install app</MenuItem>}
            <MenuItem onClick={() => void handleSignOut()}>Sign out</MenuItem>
          </Menu>
          <InstallDialog open={installOpen} onClose={() => setInstallOpen(false)} />
        </Toolbar>
      </AppBar>
      <Drawer
        variant={mobile ? "temporary" : "permanent"}
        open={mobile ? navOpen : true}
        onClose={() => setNavOpen(false)}
        sx={{ width: DRAWER, flexShrink: 0, "& .MuiDrawer-paper": { width: DRAWER, boxSizing: "border-box" } }}
      >
        {nav}
      </Drawer>
      <Box component="main" sx={{ flexGrow: 1, minWidth: 0, display: "flex", flexDirection: "column", minHeight: "100dvh" }}>
        <Toolbar />
        <Container maxWidth="lg" sx={{ flexGrow: 1, py: { xs: 2, sm: 4 }, px: { xs: 1.5, sm: 3 } }}>
          {children}
        </Container>
        <Footer />
      </Box>
    </Box>
  );
}

const MODES = [
  { mode: "light", label: "Light", icon: <LightModeIcon fontSize="small" /> },
  { mode: "system", label: "Automatic", icon: <SettingsBrightnessIcon fontSize="small" /> },
  { mode: "dark", label: "Dark", icon: <DarkModeIcon fontSize="small" /> },
] as const;

/** Light, automatic (follows the device) or dark; MUI stores the choice per browser. */
function ThemeSwitch() {
  const { mode, setMode } = useColorScheme();
  return (
    <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 2, px: 2, py: 1 }}>
      <Typography variant="body2">Theme</Typography>
      <ToggleButtonGroup
        size="small"
        exclusive
        value={mode ?? "system"}
        onChange={(_, next: (typeof MODES)[number]["mode"] | null) => next && setMode(next)}
        aria-label="Theme"
      >
        {MODES.map((m) => (
          <ToggleButton key={m.mode} value={m.mode} aria-label={m.label} title={m.label}>
            {m.icon}
          </ToggleButton>
        ))}
      </ToggleButtonGroup>
    </Box>
  );
}

/** The app bar's callsign search from md up; Paper gives it the theme's surface color on the colored bar. */
function BarSearch() {
  const navigate = useNavigate();
  const [value, setValue] = useState("");
  const [invalid, setInvalid] = useState(false);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const path = lookupPath(value);
    // Blank input does nothing; anything else lookupPath refuses (a "." or ".." segment) isn't a callsign.
    if (!path) {
      setInvalid(value.trim() !== "");
      return;
    }
    setValue("");
    void navigate(path);
  };
  return (
    <Tooltip open={invalid} title={INVALID_CALLSIGN} disableHoverListener disableFocusListener disableTouchListener>
      <Paper component="form" role="search" onSubmit={submit} elevation={0} sx={{ display: "flex", alignItems: "center", width: 260, mr: 2, pl: 1.5 }}>
        <InputBase
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setInvalid(false);
          }}
          error={invalid}
          placeholder="Callsign, like KK4PWJ"
          sx={{ flex: 1 }}
          slotProps={{ input: { "aria-label": "Look up a callsign", autoCapitalize: "characters", autoCorrect: "off", spellCheck: false } }}
        />
        <IconButton type="submit" size="small" aria-label="Look up">
          <SearchIcon />
        </IconButton>
      </Paper>
    </Tooltip>
  );
}
