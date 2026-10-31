import { useState, type ReactNode } from "react";
import {
  AppBar, Box, Button, Container, Drawer, IconButton, Link, List, ListItemButton, ListItemText, Tab, Tabs, Toolbar,
  useMediaQuery, useTheme,
} from "@mui/material";
import MenuIcon from "@mui/icons-material/Menu";
import { Link as RouterLink, useLocation } from "react-router";
import { Footer } from "./Footer";
import { DOCS_URL, navSection } from "./nav";
import { ThemeMenu } from "./ThemeSwitch";

// The public pages, in the order of Brad's landing page canvas. Ids are sections (see navSection).
const PAGES = [
  { id: "band-map", label: "Band map" },
  { id: "lookup", label: "Callsign lookup" },
  { id: "ref", label: "Reference lookup" },
  { id: "stats", label: "Stats" },
];

/**
 * The signed-out frame: a top nav of the public pages and a Sign in button, as on the landing
 * page. Signed in, the same pages sit in AppShell's left nav instead. Below lg the pages move
 * into a drawer, since the five tabs, the theme and Sign in need about 930px.
 */
export function PublicShell({ children }: { children: ReactNode }) {
  const theme = useTheme();
  const compact = useMediaQuery(theme.breakpoints.down("lg"));
  const location = useLocation();
  const [navOpen, setNavOpen] = useState(false);
  const page = navSection(location.pathname);
  const current = PAGES.some((p) => p.id === page) ? page : false;
  // Signing in comes back to this page, query and hash included, as RequireAuth's redirect does.
  // From the landing page there is nothing to come back to: sign in goes on to Home.
  const from = location.pathname === "/" ? undefined : location.pathname + location.search + location.hash;

  return (
    <Box sx={{ display: "flex", flexDirection: "column", minHeight: "100dvh" }}>
      <AppBar position="sticky" sx={{ pt: "env(safe-area-inset-top, 0px)" }}>
        <Toolbar sx={{ gap: 1 }}>
          {compact && (
            <IconButton color="inherit" edge="start" onClick={() => setNavOpen(true)} aria-label="Open navigation">
              <MenuIcon />
            </IconButton>
          )}
          <Link component={RouterLink} to="/" variant="h6" color="inherit" underline="none" sx={{ flexGrow: compact ? 1 : 0 }}>
            Long Lines
          </Link>
          {!compact && (
            <Box component="nav" aria-label="Public pages" sx={{ ml: "auto" }}>
              <Tabs value={current} textColor="inherit" indicatorColor="secondary" aria-label="Public pages" sx={{ minHeight: 64 }}>
                {PAGES.map((p) => (
                  <Tab
                    key={p.id} value={p.id} label={p.label} component={RouterLink} to={`/${p.id}`}
                    aria-current={current === p.id ? "page" : undefined} sx={{ minHeight: 64 }}
                  />
                ))}
                <Tab value="docs" label="Docs" component="a" href={DOCS_URL} target="_blank" rel="noopener noreferrer" sx={{ minHeight: 64 }} />
              </Tabs>
            </Box>
          )}
          <ThemeMenu />
          <Button color="inherit" variant="outlined" component={RouterLink} to="/signin" state={from ? { from } : undefined}>
            Sign in
          </Button>
        </Toolbar>
      </AppBar>
      {compact && (
        <Drawer open={navOpen} onClose={() => setNavOpen(false)}>
          <List component="nav" aria-label="Public pages" sx={{ width: 232 }}>
            {PAGES.map((p) => (
              <ListItemButton
                key={p.id} component={RouterLink} to={`/${p.id}`} selected={current === p.id}
                aria-current={current === p.id ? "page" : undefined} onClick={() => setNavOpen(false)}
              >
                <ListItemText primary={p.label} />
              </ListItemButton>
            ))}
            <ListItemButton component="a" href={DOCS_URL} target="_blank" rel="noopener noreferrer" onClick={() => setNavOpen(false)}>
              <ListItemText primary="Docs" />
            </ListItemButton>
          </List>
        </Drawer>
      )}
      <Container component="main" maxWidth="lg" sx={{ flexGrow: 1, py: { xs: 2, sm: 4 }, px: { xs: 1.5, sm: 3 } }}>
        {children}
      </Container>
      <Footer />
    </Box>
  );
}
