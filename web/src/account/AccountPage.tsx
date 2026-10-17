import { useState } from "react";
import {
  Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, Divider, FormControl, FormControlLabel, InputLabel, MenuItem, Paper,
  Select, Stack, Switch, TextField, Typography,
} from "@mui/material";
import { useNavigate } from "react-router";
import { PageTitle } from "../layout/PageTitle";
import { deleteAccount, signOut, updateEmail, updateProfile, type Profile } from "../lib/api";
import { isValidCallsign, normalizeCallsign } from "../lib/callsign";
import { formatDate } from "../lib/time";
import { errorText, useApp } from "../app/hooks";
import { pushCleanup } from "../pwa/push";
import { ChangePassword } from "./ChangePassword";

const TIMEZONES = ["UTC", "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles", "Europe/London", "Europe/Berlin", "Asia/Tokyo"];

interface Draft {
  callsign: string;
  name: string;
  email: string;
  timezone: string;
  utcTimes: boolean;
}

function draftOf(profile: Profile, email: string): Draft {
  return { callsign: profile.callsign, name: profile.name, email, timezone: profile.timezone, utcTimes: profile.utc_times };
}

export function AccountPage({ profile }: { profile: Profile }) {
  const navigate = useNavigate();
  const { session, refreshProfile, notify, setSignInNotice } = useApp();
  const email = session?.user.email ?? "";
  const [saved, setSaved] = useState<Draft>(() => draftOf(profile, email));
  const [draft, setDraft] = useState<Draft>(saved);
  const [busy, setBusy] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  // When the profile or email changes underneath us (after a save), adopt it as the new baseline.
  const [seen, setSeen] = useState({ profile, email });
  if (seen.profile !== profile || seen.email !== email) {
    const d = draftOf(profile, email);
    setSeen({ profile, email });
    setSaved(d);
    setDraft(d);
  }

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const callsignValid = isValidCallsign(draft.callsign);
  const timezones = TIMEZONES.includes(draft.timezone) ? TIMEZONES : [draft.timezone, ...TIMEZONES];

  const save = async () => {
    setBusy(true);
    try {
      await updateProfile(profile.id, {
        callsign: normalizeCallsign(draft.callsign), name: draft.name.trim(), timezone: draft.timezone, utc_times: draft.utcTimes,
      });
      const emailChanged = draft.email.trim() !== saved.email;
      let emailError: unknown = null;
      if (emailChanged) {
        try {
          await updateEmail(draft.email.trim());
        } catch (err) {
          emailError = err ?? new Error("");
        }
      }
      // The profile saved either way, so show it even when the email change failed.
      await refreshProfile();
      if (emailError) {
        const reason = errorText(emailError, "");
        notify(`Saved your profile, but your email didn't change.${reason ? ` ${reason}` : ""}`);
      } else {
        notify(emailChanged ? `Saved. Check ${draft.email.trim()} to confirm the change.` : "Saved changes");
      }
    } catch (err) {
      notify(errorText(err, "Couldn't save your changes."));
    } finally {
      setBusy(false);
    }
  };

  const signOutOthers = async () => {
    try {
      await signOut("others");
      notify("Signed out of all other devices");
    } catch (err) {
      notify(errorText(err, "Couldn't sign out other devices."));
    }
  };

  const remove = async () => {
    setConfirmOpen(false);
    setConfirmText("");
    setBusy(true);
    try {
      await deleteAccount();
      // The notice lives in app state: signing out redirects to /signin on its own,
      // and that redirect would overwrite anything passed in navigation state.
      setSignInNotice("Your account was deleted. You can create a new one any time.");
      await signOut("local", pushCleanup).catch(() => undefined);
      void navigate("/signin", { replace: true });
    } catch (err) {
      notify(errorText(err, "Couldn't delete your account."));
      setBusy(false);
    }
  };

  return (
    <Stack spacing={3} sx={{ maxWidth: 640, width: "100%" }}>
      <Box>
        <PageTitle>Account</PageTitle>
        <Typography color="text.secondary">Your callsign and how we reach you.</Typography>
      </Box>

      <Paper variant="outlined" sx={{ p: 3 }}>
        <Typography variant="h6" gutterBottom>Profile</Typography>
        <Stack spacing={2.5} sx={{ mt: 2 }}>
          <TextField
            label="Callsign" value={draft.callsign} onChange={(e) => set("callsign", e.target.value.toUpperCase().trim())}
            error={!callsignValid} helperText={callsignValid ? "Shown on your connections and in group rosters." : "Enter a valid amateur callsign, like KK4PWJ."} fullWidth
          />
          <TextField label="Name" value={draft.name} onChange={(e) => set("name", e.target.value)} fullWidth />
          <TextField
            label="Email" type="email" value={draft.email} onChange={(e) => set("email", e.target.value)}
            helperText="Used to sign in. Changing it sends a confirmation link to the new address." fullWidth
          />
          <FormControl fullWidth>
            <InputLabel id="tz">Time zone</InputLabel>
            <Select labelId="tz" label="Time zone" value={draft.timezone} onChange={(e) => set("timezone", e.target.value)}>
              {timezones.map((z) => <MenuItem key={z} value={z}>{z}</MenuItem>)}
            </Select>
          </FormControl>
          <FormControlLabel control={<Switch checked={draft.utcTimes} onChange={(e) => set("utcTimes", e.target.checked)} />} label="Show spot times in UTC" />
        </Stack>
        <Stack direction="row" spacing={1} sx={{ justifyContent: "flex-end", mt: 3 }}>
          <Button disabled={!dirty || busy} onClick={() => setDraft(saved)}>Discard</Button>
          <Button variant="contained" disabled={!dirty || !callsignValid || busy} onClick={() => void save()}>Save changes</Button>
        </Stack>
      </Paper>

      <Paper variant="outlined" sx={{ p: 3 }}>
        <Typography variant="h6" gutterBottom>Password</Typography>
        <ChangePassword email={email} />
        <Divider sx={{ my: 3 }} />
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          You last signed in on {formatDate(session?.user.last_sign_in_at)}.
        </Typography>
        <Stack direction={{ xs: "column", sm: "row" }} spacing={1}>
          <Button variant="outlined" onClick={() => void signOutOthers()}>Sign out other devices</Button>
          <Button variant="outlined" onClick={() => void signOut("local", pushCleanup).catch(() => notify("Couldn't sign out."))}>Sign out</Button>
        </Stack>
      </Paper>

      <Paper variant="outlined" sx={{ p: 3 }}>
        <Typography variant="h6" color="error" gutterBottom>Delete account</Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Removes your connections and destinations immediately. Spots already delivered are not recalled.
        </Typography>
        <Button variant="outlined" color="error" onClick={() => setConfirmOpen(true)} disabled={busy}>Delete account</Button>
      </Paper>

      <Dialog open={confirmOpen} onClose={() => { setConfirmOpen(false); setConfirmText(""); }} fullWidth maxWidth="xs">
        <DialogTitle>Delete your account?</DialogTitle>
        <DialogContent>
          <Typography variant="body2" sx={{ mb: 2 }}>
            This can't be undone. Type <Typography component="span" variant="subtitle2">{profile.callsign}</Typography> to confirm.
          </Typography>
          <TextField autoFocus fullWidth value={confirmText} onChange={(e) => setConfirmText(e.target.value.toUpperCase())} placeholder={profile.callsign} />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => { setConfirmOpen(false); setConfirmText(""); }}>Cancel</Button>
          <Button color="error" variant="contained" disabled={confirmText !== profile.callsign} onClick={() => void remove()}>Delete account</Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}
