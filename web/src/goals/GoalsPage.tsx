import { useCallback, useEffect, useState } from "react";
import {
  Box, Button, Card, CardActionArea, CardContent, Chip, Grid, LinearProgress, Paper, Stack, Typography, useMediaQuery, type Theme,
} from "@mui/material";
import AddIcon from "@mui/icons-material/Add";
import ChecklistIcon from "@mui/icons-material/Checklist";
import { Link as RouterLink } from "react-router";
import { PageTitle } from "../layout/PageTitle";
import { listGoals } from "../lib/api";
import { errorText, useNotify } from "../app/hooks";
import { cardMeta, isFinished, percent, usageLine, workedLine } from "./model";
import type { GoalCard } from "./types";

const SUBTITLE = "Tell Long Lines what you still need. Connections stop alerting for anything you've worked.";

/** /goals: a card per active list, then the Finished ones (complete or ended), or the empty state. */
export function GoalsPage() {
  const notify = useNotify();
  const phone = useMediaQuery((t: Theme) => t.breakpoints.down("sm"));
  const [lists, setLists] = useState<GoalCard[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      setLists(await listGoals());
    } catch (err) {
      notify(errorText(err, "Couldn't load your goals."));
    } finally {
      setLoading(false);
    }
  }, [notify]);

  useEffect(() => {
    void load();
  }, [load]);

  const empty = !loading && lists.length === 0;
  const active = lists.filter((l) => !isFinished(l.status));
  const finished = lists.filter((l) => isFinished(l.status));
  const add = (
    <Button variant="contained" startIcon={<AddIcon />} component={RouterLink} to="/goals/new" fullWidth={phone} sx={{ flexShrink: 0 }}>
      Add goal
    </Button>
  );

  return (
    <Stack spacing={3}>
      <Stack direction={{ xs: "column", sm: "row" }} spacing={2} sx={{ justifyContent: "space-between", alignItems: { sm: "flex-end" } }}>
        <Box>
          <PageTitle>Goals</PageTitle>
          <Typography color="text.secondary">{SUBTITLE}</Typography>
        </Box>
        {!empty && add}
      </Stack>
      {loading && <LinearProgress />}
      {empty && (
        <Paper variant="outlined" sx={{ p: 4, textAlign: "center" }}>
          <ChecklistIcon color="action" fontSize="large" />
          <Typography variant="h6" component="h2" gutterBottom>No goals yet</Typography>
          <Typography color="text.secondary" sx={{ mb: 2, maxWidth: 560, mx: "auto" }}>
            A goal is what you're still chasing: states, parks, bands. Add one to a connection and it stops alerting for anything you've already worked.
          </Typography>
          {add}
        </Paper>
      )}
      {active.length > 0 && <CardGrid lists={active} />}
      {finished.length > 0 && (
        <Stack spacing={2}>
          <Typography variant="overline" color="text.secondary" component="h2">{`Finished · ${finished.length}`}</Typography>
          <CardGrid lists={finished} />
          <Typography variant="body2" color="text.secondary">
            Finished goals stop counting contacts. Their rule is off on any connection that still has it. Delete one once no connection uses it.
          </Typography>
        </Stack>
      )}
    </Stack>
  );
}

function CardGrid({ lists }: { lists: GoalCard[] }) {
  return (
    <Grid container spacing={2}>
      {lists.map((l) => (
        <Grid size={{ xs: 12, md: 6 }} key={l.id}>
          <ListCard list={l} />
        </Grid>
      ))}
    </Grid>
  );
}

function ListCard({ list: l }: { list: GoalCard }) {
  return (
    <Card variant="outlined" sx={{ height: "100%" }}>
      <CardActionArea component={RouterLink} to={`/goals/${l.id}`} sx={{ height: "100%" }}>
        <CardContent>
          <Stack direction="row" spacing={2} sx={{ justifyContent: "space-between", alignItems: "flex-start" }}>
            <Typography variant="h6" component="h2" sx={{ overflowWrap: "anywhere", minWidth: 0 }}>{l.name}</Typography>
            {l.status === "complete" && <Chip size="small" color="success" label="Complete" />}
            {l.status === "ended" && <Chip size="small" variant="outlined" label="Ended" />}
          </Stack>
          <Typography variant="body2" color="text.secondary">{cardMeta(l)}</Typography>
          <Typography sx={{ mt: 2 }}>{workedLine(l.worked, l.total)}</Typography>
          <LinearProgress
            variant="determinate" value={percent(l.worked, l.total)} color={l.status === "complete" ? "success" : "primary"}
            aria-label={`${l.name} progress`} sx={{ my: 1 }}
          />
          <Typography variant="body2" color="text.secondary">{usageLine(l)}</Typography>
        </CardContent>
      </CardActionArea>
    </Card>
  );
}
