import { useState } from "react";
import {
  Button, Checkbox, Dialog, DialogActions, DialogContent, DialogTitle, FormControlLabel, Stack, Typography,
} from "@mui/material";

interface Props {
  initialShow: boolean;
  onKeepPrivate: () => void;
  onMakePublic: (showCallsigns: boolean) => void;
}

/**
 * Make the statistics page public? Shown before any Public switch turns on,
 * in the New group dialog and the Settings tab. The first bullet follows the
 * checkbox (spec, decision 13).
 */
export function PublicConfirmDialog({ initialShow, onKeepPrivate, onMakePublic }: Props) {
  const [show, setShow] = useState(initialShow);
  return (
    <Dialog open onClose={onKeepPrivate} fullWidth maxWidth="sm">
      <DialogTitle>Make the statistics page public?</DialogTitle>
      <DialogContent>
        <Stack spacing={2}>
          <Typography variant="body2">Anyone with the link will be able to see, without signing in:</Typography>
          <Typography component="ul" variant="body2" sx={{ m: 0, pl: 2.5 }}>
            <li>
              {show
                ? "The callsigns of the most active members, and who activated each place"
                : "Club totals only, without callsigns"}
            </li>
            <li>Club totals, charts and the year heat map</li>
            <li>The parks and summits members activated</li>
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Your settings, the member list and your connections are never shown. Members do not get a notice, so tell them first.
          </Typography>
          <FormControlLabel
            control={<Checkbox checked={show} onChange={(e) => setShow(e.target.checked)} />}
            label="Show each member's callsign on the public page"
          />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onKeepPrivate}>Keep private</Button>
        <Button variant="contained" onClick={() => onMakePublic(show)}>Make public</Button>
      </DialogActions>
    </Dialog>
  );
}
