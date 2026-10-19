import { useState } from "react";
import { Box, Button, Card, Dialog, DialogActions, DialogContent, DialogTitle, FormControlLabel, Radio, RadioGroup, Stack, Typography } from "@mui/material";
import { styled } from "@mui/material/styles";
import { useNavigate } from "react-router";
import type { DestinationType } from "../lib/api";
import { DEST_TYPES } from "./types";

/** An outlined card that takes the primary border while its radio is selected. */
const TypeCard = styled(Card, { shouldForwardProp: (prop) => prop !== "selected" })<{ selected: boolean }>(({ theme, selected }) => ({
  borderColor: selected ? theme.palette.primary.main : undefined,
  boxShadow: selected ? `inset 0 0 0 1px ${theme.palette.primary.main}` : undefined,
}));

/**
 * Add destination: pick a type (page 5). Continue hands off to that type's
 * full-page editor at /destinations/new?type={type}; every type has settings
 * beyond a URL (webhook spec, decision 9).
 */
export function DestinationDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const [type, setType] = useState<DestinationType>("discord");

  const close = () => {
    setType("discord");
    onClose();
  };
  const next = () => {
    close();
    void navigate(`/destinations/new?type=${type}`);
  };

  return (
    <Dialog open={open} onClose={close} fullWidth maxWidth="sm">
      <DialogTitle>Add destination</DialogTitle>
      <DialogContent dividers>
        <Typography color="text.secondary" sx={{ mb: 2 }}>
          Pick where matching spots should go. You can add as many of each type as you like, for example one push destination per source or
          per device.
        </Typography>
        <RadioGroup aria-label="Destination type" value={type} onChange={(e) => setType(e.target.value as DestinationType)}>
          <Stack spacing={1.5}>
            {DEST_TYPES.map((t) => {
              const selected = type === t.id;
              const Icon = t.icon;
              return (
                <TypeCard key={t.id} variant="outlined" selected={selected}>
                  <FormControlLabel
                    value={t.id} control={<Radio />}
                    sx={{ m: 0, px: 1, py: 1.5, width: "100%", alignItems: "center" }}
                    slotProps={{ typography: { component: "div", sx: { flexGrow: 1, minWidth: 0 } } }}
                    label={
                      <Stack direction="row" spacing={1.5} sx={{ alignItems: "center" }}>
                        <Icon color={selected ? "primary" : "action"} />
                        <Box>
                          <Typography>{t.label}</Typography>
                          <Typography variant="body2" color="text.secondary">{t.help}</Typography>
                        </Box>
                      </Stack>
                    }
                  />
                </TypeCard>
              );
            })}
          </Stack>
        </RadioGroup>
      </DialogContent>
      <DialogActions>
        <Button onClick={close}>Cancel</Button>
        <Button variant="contained" onClick={next}>Continue</Button>
      </DialogActions>
    </Dialog>
  );
}
