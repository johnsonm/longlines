import { Box, Chip, Stack, Typography } from "@mui/material";
import { Link } from "react-router";
import { PageTitle } from "../layout/PageTitle";
import { useStats } from "../stats/useStats";
import { lookupPath } from "./format";
import { LookupForm } from "./LookupForm";

export function LookupPage() {
  // The Stats snapshot is cached for the hour, so this costs no request after a visit to Stats.
  const { stats } = useStats();
  const busy = stats?.payload.topActivators ?? [];
  return (
    <Stack spacing={3} useFlexGap>
      <Box>
        <PageTitle>Callsign lookup</PageTitle>
        <Typography color="text.secondary">
          See what Long Lines has heard from any station: license details from the FCC, plus every spot since Long Lines started.
          Every profile has its own link you can share.
        </Typography>
      </Box>
      <LookupForm autoFocus />
      {busy.length > 0 && (
        <Box>
          <Typography variant="subtitle2" gutterBottom>Busy this week</Typography>
          <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: "wrap" }}>
            {busy.map((a) => (
              <Chip key={a.callsign} label={a.callsign} component={Link} to={lookupPath(a.base ?? a.callsign) ?? "/lookup"} clickable />
            ))}
          </Stack>
        </Box>
      )}
    </Stack>
  );
}
