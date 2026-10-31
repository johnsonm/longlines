import {
  Divider, List, ListItem, ListItemText, Stack, Table, TableBody, TableCell, TableContainer, TableHead,
  TableRow, Typography, useMediaQuery, useTheme,
} from "@mui/material";
import { Fragment } from "react";
import type { RecentSpot } from "../lib/api";
import { formatSpotTime, type TimePrefs } from "../lib/time";
import { sourceName } from "./sources";
import { spotKhz, spotReference, spotTuning } from "./spots";

export function SpotsTable({ spots, dense, prefs, maxHeight = 480 }: { spots: RecentSpot[]; dense?: boolean; prefs: TimePrefs; maxHeight?: number }) {
  const theme = useTheme();
  const mobile = useMediaQuery(theme.breakpoints.down("sm"));
  if (!spots.length) return <Typography color="text.secondary" sx={{ p: 2 }}>No spots match these filters yet.</Typography>;
  if (mobile) {
    return (
      <List dense disablePadding sx={{ maxHeight, overflowY: "auto" }}>
        {spots.map((s, i) => (
          <Fragment key={s.id ?? i}>
            {i > 0 && <Divider component="li" />}
            <ListItem>
              <ListItemText
                primary={
                  <Stack direction="row" spacing={1} sx={{ justifyContent: "space-between" }}>
                    <Typography component="span" variant="subtitle2">{s.callsign}</Typography>
                    <Typography component="span" variant="body2">{spotTuning(s)}</Typography>
                  </Stack>
                }
                secondary={
                  <Stack direction="row" spacing={1} component="span" sx={{ justifyContent: "space-between" }}>
                    <Typography component="span" variant="caption">{spotReference(s)} · {sourceName(s.source ?? "")}</Typography>
                    <Typography component="span" variant="caption">{s.spot_time ? formatSpotTime(s.spot_time, prefs) : ""}</Typography>
                  </Stack>
                }
                slotProps={{ secondary: { component: "div" } }}
              />
            </ListItem>
          </Fragment>
        ))}
      </List>
    );
  }
  return (
    <TableContainer sx={{ maxHeight, overflow: "auto" }}>
      <Table stickyHeader size={dense ? "small" : "medium"}>
        <TableHead>
          <TableRow>
            <TableCell>{prefs.utcTimes ? "Time (UTC)" : "Time (local)"}</TableCell>
            <TableCell>Callsign</TableCell>
            <TableCell align="right">kHz</TableCell>
            <TableCell>Band</TableCell>
            <TableCell>Mode</TableCell>
            <TableCell>Reference</TableCell>
            <TableCell>Source</TableCell>
            <TableCell>Spotter</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {spots.map((s, i) => (
            <TableRow key={s.id ?? i} hover>
              <TableCell>{s.spot_time ? formatSpotTime(s.spot_time, prefs) : ""}</TableCell>
              <TableCell><Typography variant="subtitle2">{s.callsign}</Typography></TableCell>
              <TableCell align="right">{spotKhz(s) ?? "–"}</TableCell>
              <TableCell>{s.band}</TableCell>
              <TableCell>{(s.mode ?? "").toUpperCase()}</TableCell>
              <TableCell>{spotReference(s)}</TableCell>
              <TableCell>{sourceName(s.source ?? "")}</TableCell>
              <TableCell>{s.spotter}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  );
}
