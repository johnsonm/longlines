import { Fragment, useState } from "react";
import {
  Alert, Box, Button, Card, CardActions, CardContent, CardHeader, Chip, Grid, LinearProgress, List, ListItemButton, ListItemText, ListSubheader,
  Stack, Table, TableBody, TableCell, TableHead, TableRow, Typography, useMediaQuery, useTheme,
} from "@mui/material";
import { Link as RouterLink } from "react-router";
import { errorText } from "../app/hooks";
import { fmt } from "../stats/format";
import { Kpi } from "../stats/parts";
import {
  bandsLabel, cardNames, cardNote, chips, dayHeading, dayNote, duration, EMPTY, emptyMessage, ESTIMATE_ALERT, groupByDay, heardIn, modesLabel,
  mostActivatedDetail, onAirLabel, phoneDetail, phoneWindow, RECENT_SHOWN, referencesCaption, referencesLabel, timeWindow, type ActivationDay,
} from "./model";
import { activationPath } from "./paths";
import type { ActivationCard, CallsignActivations } from "./types";
import { useCallsignActivations } from "./useActivations";

/**
 * The callsign profile's Spotted activations tab. It asks for the list only when it is mounted,
 * which is only while the tab is selected, and only once per visit.
 */
export function ActivationsTab({ callsign }: { callsign: string }) {
  const { data, notFound, error, loading } = useCallsignActivations(callsign);
  return (
    <Stack spacing={3} useFlexGap>
      <Alert severity="info">{ESTIMATE_ALERT}</Alert>
      {loading && <LinearProgress />}
      {!loading && notFound && <Empty callsign={callsign} />}
      {!loading && !notFound && !data && <Alert severity="error">{errorText(error, "Couldn't load spotted activations.")}</Alert>}
      {data && (data.recent.length === 0 ? <Empty callsign={data.callsign} /> : <Activations list={data} />)}
    </Stack>
  );
}

function Empty({ callsign }: { callsign: string }) {
  return (
    <Card variant="outlined">
      <CardContent>
        <Typography color="text.secondary">{emptyMessage(callsign)}</Typography>
      </CardContent>
    </Card>
  );
}

function Activations({ list }: { list: CallsignActivations }) {
  const theme = useTheme();
  const mobile = useMediaQuery(theme.breakpoints.down("sm"));
  const [all, setAll] = useState(false);
  const { summary } = list;
  const most = summary.mostActivated;
  const days = groupByDay(all ? list.recent : list.recent.slice(0, RECENT_SHOWN));
  // A day's note counts the whole day, even when the first rows cut it short.
  const notes = new Map(groupByDay(list.recent).map((d) => [d.day, dayNote(d.cards)]));

  return (
    <>
      <Grid container spacing={2}>
        <Grid size={{ xs: 6, md: 3 }}>
          <Kpi label="Spotted activations" value={fmt(summary.activations)} detail="Past 12 months" />
        </Grid>
        <Grid size={{ xs: 6, md: 3 }}>
          <Kpi label="References" value={fmt(summary.references.total)} detail={referencesCaption(summary.references)} />
        </Grid>
        <Grid size={{ xs: 6, md: 3 }}>
          <Kpi
            label="Time on air"
            value={onAirLabel(summary.onAirSeconds)}
            detail={mobile ? "First to last spot" : "First spot to last spot, each activation"}
          />
        </Grid>
        <Grid size={{ xs: 6, md: 3 }}>
          <Kpi label="Most activated" value={most ? most.reference : EMPTY} small={mobile} detail={most ? mostActivatedDetail(most, mobile) : ""} />
        </Grid>
      </Grid>

      <Card variant="outlined">
        <CardHeader
          title="Recent"
          slotProps={{ title: { variant: "h6" } }}
          action={<Typography variant="caption" color="text.secondary">Time (UTC)</Typography>}
        />
        {mobile ? <PhoneList days={days} notes={notes} /> : <DesktopTable days={days} notes={notes} />}
        {!all && list.recent.length > RECENT_SHOWN && (
          <CardActions>
            <Button onClick={() => setAll(true)}>{`Show all ${fmt(list.recent.length)}`}</Button>
          </CardActions>
        )}
      </Card>
    </>
  );
}

/** A day heading's words: "Sat 25 Oct 2026" and, for a busy day, " · 3 parks in one day". */
function DayLabel({ day, note }: { day: ActivationDay; note: string | null }) {
  return (
    <>
      <Typography component="span" variant="subtitle2">{dayHeading(day.day)}</Typography>
      {note && <Typography component="span" variant="body2" color="text.secondary">{` · ${note}`}</Typography>}
    </>
  );
}

function Chips({ card }: { card: ActivationCard }) {
  return chips(card).map((label) => <Chip key={label} size="small" label={label} />);
}

/** Two lines in one cell: the figure over a caption. */
function TwoLines({ top, bottom }: { top: string; bottom: string | null }) {
  return (
    <>
      <Typography variant="body2">{top}</Typography>
      {bottom && <Typography variant="caption" color="text.secondary">{bottom}</Typography>}
    </>
  );
}

/** Each day's note ("3 parks in one day"), keyed by day. */
type DayNotes = Map<string, string | null>;

function DesktopTable({ days, notes }: { days: ActivationDay[]; notes: DayNotes }) {
  return (
    <Box sx={{ overflowX: "auto" }}>
      <Table size="small">
        <TableHead>
          <TableRow>
            <TableCell>Reference</TableCell>
            <TableCell>Time on air</TableCell>
            <TableCell>Bands · modes</TableCell>
            <TableCell align="right">Spots</TableCell>
            <TableCell>Heard in</TableCell>
            {/* The canvas hides this header visually; screen readers read "Open". */}
            <TableCell aria-label="Open" />
          </TableRow>
        </TableHead>
        <TableBody>
          {days.map((day) => (
            <Fragment key={day.day}>
              <TableRow selected>
                <TableCell colSpan={6}><DayLabel day={day} note={notes.get(day.day) ?? null} /></TableCell>
              </TableRow>
              {day.cards.map((card) => {
                const note = cardNote(card);
                const names = cardNames(card);
                return (
                  <TableRow key={card.id} hover>
                    <TableCell>
                      <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: "wrap", alignItems: "center" }}>
                        <Typography variant="subtitle2">{referencesLabel(card.references)}</Typography>
                        <Chips card={card} />
                      </Stack>
                      {names && <Typography variant="caption" color="text.secondary" component="div">{names}</Typography>}
                      {note && <Typography variant="caption" color="text.secondary" component="div">{note}</Typography>}
                    </TableCell>
                    <TableCell><TwoLines top={timeWindow(card)} bottom={duration(card.durationSeconds) ?? EMPTY} /></TableCell>
                    <TableCell><TwoLines top={bandsLabel(card.bands) || EMPTY} bottom={modesLabel(card.modes) || null} /></TableCell>
                    <TableCell align="right">{fmt(card.spotCount)}</TableCell>
                    <TableCell>{heardIn(card.states, card.countries) ?? EMPTY}</TableCell>
                    <TableCell align="right">
                      <Button component={RouterLink} to={activationPath(card.id)} aria-label={`View ${referencesLabel(card.references)}, ${dayHeading(card.day)} ${timeWindow(card)}`}>
                        View
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
            </Fragment>
          ))}
        </TableBody>
      </Table>
    </Box>
  );
}

function PhoneList({ days, notes }: { days: ActivationDay[]; notes: DayNotes }) {
  return (
    <List disablePadding>
      {days.map((day) => (
        <Fragment key={day.day}>
          <ListSubheader disableSticky>
            <DayLabel day={day} note={notes.get(day.day) ?? null} />
          </ListSubheader>
          {day.cards.map((card) => {
            const names = cardNames(card);
            return (
              <ListItemButton key={card.id} component={RouterLink} to={activationPath(card.id)} divider>
                <ListItemText
                  disableTypography
                  primary={
                    <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: "wrap", alignItems: "center" }}>
                      <Typography variant="subtitle2">{referencesLabel(card.references)}</Typography>
                      <Chips card={card} />
                    </Stack>
                  }
                  secondary={
                    <>
                      {names && <Typography variant="body2" color="text.secondary">{names}</Typography>}
                      <Typography variant="body2">{phoneWindow(card)}</Typography>
                      <Typography variant="body2" color="text.secondary">{phoneDetail(card)}</Typography>
                    </>
                  }
                />
              </ListItemButton>
            );
          })}
        </Fragment>
      ))}
    </List>
  );
}
