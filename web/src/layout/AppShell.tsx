import { useState, useSyncExternalStore, type ReactNode } from "react";
import {
  AppBar, Avatar, Badge, Box, Button, Container, Divider, Drawer, IconButton, List,
  ListItemButton, ListItemIcon, ListItemText, Menu, MenuItem, Toolbar, Typography, useMediaQuery, useTheme,
} from "@mui/material";
import MenuIcon from "@mui/icons-material/Menu";
import HomeIcon from "@mui/icons-material/Home";
import SensorsIcon from "@mui/icons-material/Sensors";
import GraphicEqIcon from "@mui/icons-material/GraphicEq";
import FilterListIcon from "@mui/icons-material/FilterList";
import GroupsIcon from "@mui/icons-material/Groups";
import ChecklistIcon from "@mui/icons-material/Checklist";
import SendIcon from "@mui/icons-material/Send";
import InsightsIcon from "@mui/icons-material/Insights";
import MonitorHeartIcon from "@mui/icons-material/MonitorHeart";
import PersonSearchIcon from "@mui/icons-material/PersonSearch";
import TravelExploreIcon from "@mui/icons-material/TravelExplore";
import KeyIcon from "@mui/icons-material/Key";
import MenuBookIcon from "@mui/icons-material/MenuBook";
import { useLocation, useNavigate } from "react-router";
import { useApp } from "../app/hooks";
import { signOut } from "../lib/api";
import { installState, promptInstall, subscribeInstall } from "../pwa/install";
import { pushCleanup } from "../pwa/push";
import { Footer } from "./Footer";
import { InstallDialog } from "./InstallDialog";
import { DOCS_URL, navSection } from "./nav";
import { ThemeSwitch } from "./ThemeSwitch";

const NAV = [
  { id: "home", label: "Home", icon: <HomeIcon /> },
  { id: "sources", label: "Sources", icon: <SensorsIcon /> },
  { id: "connections", label: "Connections", icon: <FilterListIcon /> },
  { id: "destinations", label: "Destinations", icon: <SendIcon /> },
  { id: "groups", label: "Groups", icon: <GroupsIcon /> },
  { id: "goals", label: "Goals", icon: <ChecklistIcon /> },
  { id: "band-map", label: "Band map", icon: <GraphicEqIcon /> },
  { id: "lookup", label: "Callsign lookup", icon: <PersonSearchIcon /> },
  // Its id is the section, so /ref and every /ref/<program>/<reference> page highlight it.
  { id: "ref", label: "Reference lookup", icon: <TravelExploreIcon /> },
  { id: "stats", label: "Stats", icon: <InsightsIcon /> },
  { id: "health", label: "Health", icon: <MonitorHeartIcon /> },
  { id: "api-tokens", label: "API tokens", icon: <KeyIcon /> },
];
const DRAWER = 232;

/** The signed-in frame: the left nav and the account menu. Signed out, public pages sit in PublicShell. */
export function AppShell({ children, destinationsFailing = false }: { children: ReactNode; destinationsFailing?: boolean }) {
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
  const page = navSection(location.pathname);
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

  // This browser's push device goes with the session (pushCleanup is best effort). Signed out, the
  // visitor lands on the landing page, after RequireAuth's own redirect to sign in, which this replaces.
  const handleSignOut = async () => {
    setMenuEl(null);
    try {
      await signOut("local", pushCleanup);
      void navigate("/", { replace: true });
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
        <ListItemButton component="a" href={DOCS_URL} target="_blank" rel="noopener noreferrer" onClick={() => setNavOpen(false)}>
          <ListItemIcon><MenuBookIcon /></ListItemIcon>
          <ListItemText primary="Docs" />
        </ListItemButton>
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
