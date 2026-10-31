import { useState } from "react";
import { Box, IconButton, Menu, ToggleButton, ToggleButtonGroup, Typography, useColorScheme } from "@mui/material";
import LightModeIcon from "@mui/icons-material/LightMode";
import DarkModeIcon from "@mui/icons-material/DarkMode";
import SettingsBrightnessIcon from "@mui/icons-material/SettingsBrightness";

const MODES = [
  { mode: "light", label: "Light", icon: <LightModeIcon fontSize="small" /> },
  { mode: "system", label: "Automatic", icon: <SettingsBrightnessIcon fontSize="small" /> },
  { mode: "dark", label: "Dark", icon: <DarkModeIcon fontSize="small" /> },
] as const;

/** Signed out there is no account menu, so the Theme switch gets its own small menu. */
export function ThemeMenu() {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const { mode } = useColorScheme();
  const current = MODES.find((m) => m.mode === mode) ?? MODES[1];
  return (
    <>
      <IconButton color="inherit" onClick={(e) => setAnchor(e.currentTarget)} aria-label="Theme">
        {current.icon}
      </IconButton>
      <Menu
        anchorEl={anchor}
        open={!!anchor}
        onClose={() => setAnchor(null)}
        anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
        transformOrigin={{ vertical: "top", horizontal: "right" }}
      >
        <ThemeSwitch />
      </Menu>
    </>
  );
}

/** Light, automatic (follows the device) or dark; MUI stores the choice per browser. */
export function ThemeSwitch() {
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
