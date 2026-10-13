import { useState, type FormEvent } from "react";
import { Box, Button, Stack, TextField, useMediaQuery, useTheme } from "@mui/material";
import { useNavigate } from "react-router";
import { lookupPath } from "./format";

/** The lookup page's search box, also shown under an invalid callsign. */
export function LookupForm({ initial = "", autoFocus = false }: { initial?: string; autoFocus?: boolean }) {
  const navigate = useNavigate();
  const theme = useTheme();
  // Autofocus on desktop only, so a phone keyboard doesn't cover the page. noSsr so the first render knows the viewport.
  const desktop = useMediaQuery(theme.breakpoints.up("md"), { noSsr: true });
  const [value, setValue] = useState(initial);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const path = lookupPath(value);
    if (path) void navigate(path);
  };

  return (
    <Box component="form" onSubmit={submit} noValidate sx={{ maxWidth: 480 }}>
      <Stack direction="row" spacing={1}>
        <TextField
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Callsign, like KK4PWJ"
          autoFocus={autoFocus && desktop}
          size="small"
          fullWidth
          slotProps={{ htmlInput: { "aria-label": "Callsign", autoCapitalize: "characters", autoCorrect: "off", spellCheck: false } }}
        />
        <Button type="submit" variant="contained" sx={{ flexShrink: 0 }}>Look up</Button>
      </Stack>
    </Box>
  );
}
