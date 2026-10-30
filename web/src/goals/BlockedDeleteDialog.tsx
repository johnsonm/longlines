import {
  Box, Button, Dialog, DialogActions, DialogContent, DialogContentText, DialogTitle, Divider, Stack, Typography,
} from "@mui/material";
import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import { blockedDeleteText, connectionDetail } from "./model";
import type { GoalUsedBy } from "./types";

/** "Can't delete {name} yet": the connections that still use the list, each with Open (a new tab), and Close only. */
export function BlockedDeleteDialog({ name, usedBy, onClose }: { name: string; usedBy: GoalUsedBy[]; onClose: () => void }) {
  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle sx={{ overflowWrap: "anywhere" }}>Can't delete {name} yet</DialogTitle>
      <DialogContent>
        <DialogContentText>{blockedDeleteText(usedBy.length)}</DialogContentText>
        <Stack divider={<Divider />} sx={{ mt: 2 }}>
          {usedBy.map((c) => (
            <Stack key={c.id} direction="row" spacing={2} sx={{ alignItems: "center", justifyContent: "space-between", py: 1.5 }}>
              <Box sx={{ minWidth: 0 }}>
                <Typography sx={{ overflowWrap: "anywhere" }}>{c.name}</Typography>
                <Typography variant="body2" color="text.secondary">{connectionDetail(c)}</Typography>
              </Box>
              <Button
                href={`/connections/${c.id}`} target="_blank" rel="noopener noreferrer" endIcon={<OpenInNewIcon />}
                aria-label={`Open ${c.name}`} sx={{ flexShrink: 0 }}
              >
                Open
              </Button>
            </Stack>
          ))}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}
