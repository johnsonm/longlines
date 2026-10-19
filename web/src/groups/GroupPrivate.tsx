import { Box, Button, Card, CardContent, Stack, Typography } from "@mui/material";
import KeyIcon from "@mui/icons-material/Key";
import { Link as RouterLink } from "react-router";
import { useApp } from "../app/hooks";

/** /g/<code> for an unknown code or a private group: both read the same, so a code's existence never shows. */
export function GroupPrivate() {
  const { session } = useApp();
  return (
    <Box sx={{ display: "flex", justifyContent: "center", mt: { xs: 4, sm: 12 } }}>
      <Card variant="outlined" sx={{ maxWidth: 520, width: "100%" }}>
        <CardContent sx={{ px: 4, py: 5 }}>
          <Stack spacing={2} sx={{ alignItems: "center", textAlign: "center" }}>
            <KeyIcon color="action" fontSize="large" />
            <Typography variant="h5" component="h1">This page is private</Typography>
            <Typography variant="body2" color="text.secondary">
              The statistics for this group are not public. If you own the group, sign in to see them.
            </Typography>
            {/* An owner lands on their groups: this link stays private to them too (spec, decision 11). */}
            {!session && <Button variant="contained" component={RouterLink} to="/signin" state={{ from: "/groups" }}>Sign in</Button>}
          </Stack>
        </CardContent>
      </Card>
    </Box>
  );
}
