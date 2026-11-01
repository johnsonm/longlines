import { useState } from "react";
import { Box, Button, Card, CardActions, CardHeader, CardContent, Link, List, ListItem, ListItemText, Typography } from "@mui/material";
// MUI X Data Grid is the MIT community package, fixed and read-only as on the callsign profile.
import { DataGrid, type GridColDef, type GridRenderCellParams } from "@mui/x-data-grid";
import { Link as RouterLink } from "react-router";
import { lookupPath } from "../profile/format";
import { fmt } from "../stats/format";
import { GRID } from "../stats/parts";
import { EMPTY, khzLabel, modeLabel, referencesLabel, sourceLabel, spotPhoneDetail, spotPlace, SPOTS_SHOWN, utcTime } from "./model";
import type { ActivationSpot } from "./types";

/** A spotter as spotted, linked to its profile by the base call SQL gave; plain without one. */
export function SpotterLink({ spot }: { spot: Pick<ActivationSpot, "spotter" | "spotterBase"> }) {
  if (!spot.spotter) return <>{EMPTY}</>;
  const path = spot.spotterBase ? lookupPath(spot.spotterBase) : null;
  if (!path) return <>{spot.spotter}</>;
  return <Link component={RouterLink} to={path} underline="hover">{spot.spotter}</Link>;
}

interface SpotRow {
  id: number;
  spot: ActivationSpot;
  time: string;
  source: string;
  khz: string;
  mode: string;
  reference: string;
}

const COLUMNS: GridColDef[] = [
  { field: "time", headerName: "Time (UTC)", width: 100, sortable: false },
  { field: "source", headerName: "Source", width: 110, sortable: false },
  {
    field: "heardBy", headerName: "Heard by", flex: 1, minWidth: 180, sortable: false,
    renderCell: ({ row }: GridRenderCellParams<SpotRow>) => {
      const place = spotPlace(row.spot);
      return (
        <>
          <SpotterLink spot={row.spot} />
          {place && <Typography component="span" variant="body2" color="text.secondary">{` · ${place}`}</Typography>}
        </>
      );
    },
  },
  { field: "khz", headerName: "kHz", width: 100, align: "right", headerAlign: "right", sortable: false },
  { field: "mode", headerName: "Mode", width: 80, sortable: false },
  { field: "reference", headerName: "Reference", flex: 1, minWidth: 140, sortable: false },
];

function rowOf(spot: ActivationSpot, id: number): SpotRow {
  return {
    id,
    spot,
    time: utcTime(spot.time),
    source: sourceLabel(spot.source),
    khz: spot.frequencyKhz === null ? EMPTY : khzLabel(spot.frequencyKhz),
    mode: spot.mode ? modeLabel(spot.mode) : EMPTY,
    reference: spot.references ? referencesLabel(spot.references) : EMPTY,
  };
}

/** A phone row: "18:12 · POTA · KK4PWJ self-spot" over "14,285 kHz · SSB · US-2730". */
function PhoneRows({ spots }: { spots: ActivationSpot[] }) {
  return (
    <List dense disablePadding>
      {spots.map((s, i) => (
        <ListItem key={i} disableGutters divider={i < spots.length - 1}>
          <ListItemText
            primary={
              <>
                {`${utcTime(s.time)} · ${sourceLabel(s.source)} · `}
                <SpotterLink spot={s} />
                {s.selfSpot && " self-spot"}
              </>
            }
            secondary={spotPhoneDetail(s)}
            slotProps={{ primary: { variant: "subtitle2" } }}
          />
        </ListItem>
      ))}
    </List>
  );
}

/** "Spots": every spot that made up the activation, time ascending; the first few until "Show all N spots". */
export function ActivationSpots({ spots, mobile }: { spots: ActivationSpot[]; mobile: boolean }) {
  const [all, setAll] = useState(false);
  const shown = all ? spots : spots.slice(0, SPOTS_SHOWN);
  return (
    <Card variant="outlined">
      <CardHeader title="Spots" slotProps={{ title: { variant: "h6" } }} />
      <CardContent sx={{ pt: 0 }}>
        {mobile
          ? <PhoneRows spots={shown} />
          : (
            <Box sx={{ minWidth: 0 }}>
              <DataGrid {...GRID} rows={shown.map(rowOf)} columns={COLUMNS} />
            </Box>
          )}
      </CardContent>
      {!all && spots.length > SPOTS_SHOWN && (
        <CardActions>
          <Button onClick={() => setAll(true)}>{`Show all ${fmt(spots.length)} spots`}</Button>
        </CardActions>
      )}
    </Card>
  );
}
