import { useCallback, useEffect, useState } from "react";
import {
  Box, Button, Card, CardActionArea, CardActions, CardContent, Chip, Divider, Grid, LinearProgress, Paper, Stack, Typography,
  useMediaQuery, type Theme,
} from "@mui/material";
import { SparkLineChart } from "@mui/x-charts/SparkLineChart";
import AddIcon from "@mui/icons-material/Add";
import BarChartIcon from "@mui/icons-material/BarChart";
import EditIcon from "@mui/icons-material/Edit";
import NotificationsActiveIcon from "@mui/icons-material/NotificationsActive";
import { Link as RouterLink, useNavigate } from "react-router";
import { PageTitle } from "../layout/PageTitle";
import { listGroups, listGroupSummaries } from "../lib/api";
import { errorText, useNotify } from "../app/hooks";
import { plural } from "../profile/format";
import { NewGroupDialog } from "./NewGroupDialog";
import { groupMeta, onAirLine } from "./stats/model";
import type { GroupSummary } from "./stats/types";
import type { CallsignGroup } from "./types";
import { useGetAlerts } from "./useGetAlerts";

/** The landing page (canvas page 10): one card per group with its last 30 days, built in SQL. */
export function GroupsPage() {
  const notify = useNotify();
  const navigate = useNavigate();
  const mobile = useMediaQuery((t: Theme) => t.breakpoints.down("sm"));
  const alerts = useGetAlerts();
  const [groups, setGroups] = useState<CallsignGroup[]>([]);
  const [summaries, setSummaries] = useState<Map<string, GroupSummary>>(new Map());
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    try {
      const [g, s] = await Promise.all([listGroups(), listGroupSummaries()]);
      setGroups(g);
      setSummaries(new Map(s.map((x) => [x.id, x])));
    } catch (err) {
      notify(errorText(err, "Couldn't load your groups."));
    } finally {
      setLoading(false);
    }
  }, [notify]);

  useEffect(() => {
    void load();
  }, [load]);

  const onCreated = (id: string, name: string) => {
    setCreating(false);
    notify(`Created ${name}`);
    void navigate(`/groups/${id}`);
  };

  return (
    <Stack spacing={3}>
      <Stack direction={{ xs: "column", sm: "row" }} spacing={2} sx={{ justifyContent: "space-between", alignItems: { sm: "flex-end" } }}>
        <Box>
          <PageTitle>Groups</PageTitle>
          <Typography color="text.secondary">
            {mobile
              ? "A group is a named list of callsigns, like a club roster. See how the group is doing and share its statistics."
              : "A group is a named list of callsigns, like a club roster. See how the group is doing, share its statistics, and use it in connection rules."}
          </Typography>
        </Box>
        <Button variant="contained" startIcon={<AddIcon />} onClick={() => setCreating(true)} fullWidth={mobile} sx={{ flexShrink: 0 }}>
          New group
        </Button>
      </Stack>
      {loading && <LinearProgress />}
      {!loading && groups.length === 0
        ? (
          <Paper variant="outlined" sx={{ p: 4, textAlign: "center" }}>
            <Typography gutterBottom>No groups yet.</Typography>
            <Button onClick={() => setCreating(true)}>Create your first group</Button>
          </Paper>
        )
        : (
          <Grid container spacing={2}>
            {groups.map((g) => (
              <Grid size={{ xs: 12, md: 6 }} key={g.id}>
                <GroupCard group={g} summary={summaries.get(g.id)} busy={alerts.busyId === g.id} onAlerts={() => alerts.start(g.id)} />
              </Grid>
            ))}
          </Grid>
        )}
      {alerts.dialog}
      {creating && <NewGroupDialog onClose={() => setCreating(false)} onCreated={onCreated} />}
    </Stack>
  );
}

interface CardProps {
  group: CallsignGroup;
  summary: GroupSummary | undefined;
  busy: boolean;
  onAlerts: () => void;
}

function GroupCard({ group: g, summary, busy, onAlerts }: CardProps) {
  const isPublic = summary?.public ?? false;
  const daily = summary?.daily ?? null;
  return (
    <Card variant="outlined" sx={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <CardActionArea component={RouterLink} to={`/groups/${g.id}`} sx={{ flexGrow: 1 }}>
        <CardContent>
          <Stack direction="row" spacing={2} sx={{ justifyContent: "space-between", alignItems: "flex-start" }}>
            <Box sx={{ minWidth: 0 }}>
              <Typography variant="h6" component="h2" sx={{ overflowWrap: "anywhere" }}>{g.name}</Typography>
              <Typography variant="body2" color="text.secondary">{groupMeta(g.member_count, g.subscription_count)}</Typography>
            </Box>
            <Chip
              size="small" label={isPublic ? "Public" : "Private"} color={isPublic ? "success" : "default"}
              variant={isPublic ? "filled" : "outlined"}
            />
          </Stack>
          {summary && summary.spots !== null && (
            <Stack direction="row" spacing={2} sx={{ justifyContent: "space-between", alignItems: "flex-end", mt: 2 }}>
              <Box>
                <Typography variant="overline" color="text.secondary" component="div">Last 30 days</Typography>
                <Typography variant="h5" component="div">{plural(summary.spots, "spot", "spots")}</Typography>
                <Typography variant="body2" color="text.secondary">
                  {`${summary.members_heard ?? 0} of ${plural(summary.member_count ?? 0, "member", "members")} heard`}
                </Typography>
              </Box>
              {daily && (
                <Box role="img" aria-label="Spots per day, last 30 days" sx={{ width: 120, height: 32, flexShrink: 0 }}>
                  <SparkLineChart data={daily} height={32} width={120} />
                </Box>
              )}
            </Stack>
          )}
          <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>{onAirLine(summary?.on_air ?? [])}</Typography>
        </CardContent>
      </CardActionArea>
      <Divider />
      <CardActions>
        <Button size="small" startIcon={<BarChartIcon />} component={RouterLink} to={`/groups/${g.id}`}>Statistics</Button>
        <Button size="small" color="inherit" startIcon={<EditIcon />} component={RouterLink} to={`/groups/${g.id}/settings`}>Settings</Button>
        <Button size="small" color="inherit" startIcon={<NotificationsActiveIcon />} disabled={busy} onClick={onAlerts}>Get alerts</Button>
      </CardActions>
    </Card>
  );
}
