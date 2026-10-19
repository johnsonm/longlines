import { useCallback, useEffect, useState } from "react";
import {
  Alert, Box, Breadcrumbs, Button, Chip, LinearProgress, Link, Stack, Tab, Tabs, Typography, useMediaQuery, type Theme,
} from "@mui/material";
import NotificationsActiveIcon from "@mui/icons-material/NotificationsActive";
import { Link as RouterLink, useSearchParams } from "react-router";
import { PageTitle } from "../layout/PageTitle";
import { loadGroupStatistics } from "../lib/api";
import { errorText } from "../app/hooks";
import { GroupSettings } from "./GroupSettings";
import { GroupStatistics } from "./GroupStatistics";
import { groupMeta, parsePeriod } from "./stats/model";
import type { GroupPeriod, OwnerGroupStatistics } from "./stats/types";
import { useGetAlerts } from "./useGetAlerts";

export type GroupTab = "statistics" | "settings";

/** /groups/:id and /groups/:id/settings: the owner's page for one group (canvas page 10). */
export function GroupPage({ id, tab }: { id: string; tab: GroupTab }) {
  const mobile = useMediaQuery((t: Theme) => t.breakpoints.down("sm"));
  const alerts = useGetAlerts();
  const [search, setSearch] = useSearchParams();
  const period = parsePeriod(search.get("period"));
  const [stats, setStats] = useState<OwnerGroupStatistics | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setStats(await loadGroupStatistics(id, period));
    } catch (err) {
      setError(errorText(err, "Couldn't load the statistics."));
    }
  }, [id, period]);

  useEffect(() => {
    void load();
  }, [load]);

  const choosePeriod = (next: GroupPeriod) => {
    setSearch(next === "30d" ? {} : { period: next }, { replace: true });
  };

  if (error && !stats) return <Alert severity="error">{error}</Alert>;
  if (!stats) return <LinearProgress />;
  const g = stats.group;
  const query = period === "30d" ? "" : `?period=${period}`;

  return (
    <Stack spacing={3}>
      <Breadcrumbs>
        <Link component={RouterLink} to="/groups" underline="hover" color="inherit">Groups</Link>
        <Typography color="text.primary">{g.name}</Typography>
      </Breadcrumbs>
      <Stack direction="row" spacing={2} useFlexGap sx={{ justifyContent: "space-between", alignItems: "center", flexWrap: "wrap" }}>
        <Box sx={{ minWidth: 0 }}>
          <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
            <PageTitle>{g.name}</PageTitle>
            {!mobile && (
              <Chip
                size="small" label={g.public ? "Public page" : "Private page"} color={g.public ? "success" : "default"}
                variant={g.public ? "filled" : "outlined"}
              />
            )}
          </Stack>
          <Typography variant="body2" color="text.secondary">{groupMeta(g.member_count, g.subscription_count)}</Typography>
        </Box>
        {!mobile && (
          <Button variant="outlined" startIcon={<NotificationsActiveIcon />} disabled={alerts.busyId === g.id} onClick={() => alerts.start(g.id)}>
            Get alerts
          </Button>
        )}
      </Stack>
      <Tabs value={tab}>
        <Tab value="statistics" label="Statistics" component={RouterLink} to={`/groups/${g.id}${query}`} />
        <Tab value="settings" label="Settings" component={RouterLink} to={`/groups/${g.id}/settings`} />
      </Tabs>
      {error && <Alert severity="error">{error}</Alert>}
      {tab === "statistics" && <GroupStatistics stats={stats} period={period} onPeriod={choosePeriod} />}
      {tab === "settings" && <GroupSettings group={g} onSaved={load} />}
      {alerts.dialog}
    </Stack>
  );
}
