import type { ReactNode } from "react";
import { AppBar, Box, Button, Container, IconButton, Toolbar, Typography, useMediaQuery, useTheme } from "@mui/material";
import GraphicEqIcon from "@mui/icons-material/GraphicEq";
import InsightsIcon from "@mui/icons-material/Insights";
import LoginIcon from "@mui/icons-material/Login";
import PersonSearchIcon from "@mui/icons-material/PersonSearch";
import { useLocation, useNavigate } from "react-router";

/** The signed-out frame for pages anyone can view: AppShell's bar and content area without the drawer or account menu. */
export function PublicShell({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const location = useLocation();
  const theme = useTheme();
  // Below md the bar's links are icons only.
  const mobile = useMediaQuery(theme.breakpoints.down("md"));
  const links = [
    { label: "Band map", icon: <GraphicEqIcon />, go: () => void navigate("/band-map") },
    { label: "Stats", icon: <InsightsIcon />, go: () => void navigate("/stats") },
    { label: "Lookup", icon: <PersonSearchIcon />, go: () => void navigate("/lookup") },
    { label: "Sign in", icon: <LoginIcon />, go: () => void navigate("/signin", { state: location.pathname === "/signin" ? location.state : { from: location.pathname } }) },
  ];
  return (
    <Box>
      <AppBar position="fixed" sx={{ pt: "env(safe-area-inset-top, 0px)" }}>
        <Toolbar>
          <Typography variant="h6" sx={{ flexGrow: 1 }}>Long Lines</Typography>
          {links.map((l) =>
            mobile
              ? <IconButton key={l.label} color="inherit" onClick={l.go} aria-label={l.label}>{l.icon}</IconButton>
              : <Button key={l.label} color="inherit" onClick={l.go}>{l.label}</Button>
          )}
        </Toolbar>
      </AppBar>
      <Box component="main">
        <Toolbar />
        <Container maxWidth="lg" sx={{ py: { xs: 2, sm: 4 }, px: { xs: 1.5, sm: 3 } }}>
          {children}
        </Container>
      </Box>
    </Box>
  );
}
