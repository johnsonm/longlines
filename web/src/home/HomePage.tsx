import { useEffect, useMemo, useState } from "react";
import { Box, Button, Grid, LinearProgress, Paper, Stack, Typography, useMediaQuery, useTheme } from "@mui/material";
import AddIcon from "@mui/icons-material/Add";
import { Link as RouterLink, useNavigate } from "react-router";
import { PageTitle } from "../layout/PageTitle";
import { loadHomeFlow, type Destination, type SubscriptionWithLinks } from "../lib/api";
import { errorText, useNotify } from "../app/hooks";
import { SourcePickerDialog } from "../subscriptions/SourcePickerDialog";
import { DestinationDialog } from "../destinations/DestinationDialog";
import { DestinationIcon, FlowDiagram, FlowNode } from "./FlowDiagram";
import { buildFlow, count, destinationDetail, destinationTotals, DASH, TOP_CONNECTIONS } from "./model";
import type { HomeFlow } from "./types";

interface Props {
  subs: SubscriptionWithLinks[];
  dests: Destination[];
  loading: boolean;
}

function StatCard({ label, value, caption }: { label: string; value: string; caption: string }) {
  return (
    <Paper variant="outlined" sx={{ p: 2, height: "100%" }}>
      <Typography variant="overline" color="text.secondary" component="div">{label}</Typography>
      <Typography variant="h4" component="div">{value}</Typography>
      <Typography variant="caption" color="text.secondary" component="div">{caption}</Typography>
    </Paper>
  );
}

function EmptyCard({ line, action, busy, onClick }: { line: string; action: string; busy: boolean; onClick: () => void }) {
  return (
    <Paper variant="outlined">
      {busy && <LinearProgress />}
      <Stack spacing={2} sx={{ p: { xs: 2, sm: 3 }, alignItems: "flex-start" }}>
        <Typography>{line}</Typography>
        <Button variant="contained" startIcon={<AddIcon />} onClick={onClick}>{action}</Button>
      </Stack>
    </Paper>
  );
}

/** The signed-in landing page: the last 24 hours, and how spots flow from sources through connections to destinations. */
export function HomePage({ subs, dests, loading }: Props) {
  const notify = useNotify();
  const navigate = useNavigate();
  const phone = useMediaQuery(useTheme().breakpoints.down("sm"));
  const [flow, setFlow] = useState<HomeFlow | null>(null);
  const [fetching, setFetching] = useState(true);
  const [adding, setAdding] = useState<"connection" | "destination" | null>(null);

  useEffect(() => {
    let active = true;
    loadHomeFlow()
      .then((f) => {
        if (active) setFlow(f);
      })
      .catch((err: unknown) => {
        if (active) notify(errorText(err, "Couldn't load your last 24 hours."));
      })
      .finally(() => {
        if (active) setFetching(false);
      });
    return () => {
      active = false;
    };
  }, [notify]);

  const model = useMemo(() => buildFlow(subs, dests, flow), [subs, dests, flow]);
  const totals = useMemo(() => destinationTotals(dests, flow), [dests, flow]);
  const busy = loading || fetching;
  const total = (n: number | undefined) => (n === undefined ? DASH : count(n));

  const dialogs = (
    <>
      {adding === "connection" && (
        <SourcePickerDialog
          open fullScreen={phone} onClose={() => setAdding(null)}
          onContinue={(source) => void navigate(`/connections/new?source=${encodeURIComponent(source)}`)}
        />
      )}
      <DestinationDialog open={adding === "destination"} onClose={() => setAdding(null)} />
    </>
  );

  if (!loading && subs.length === 0) {
    return (
      <>
        <PageTitle>Home</PageTitle>
        <EmptyCard
          line="No connections or destinations yet." action="Add your first connection" busy={false}
          onClick={() => setAdding("connection")}
        />
        {dialogs}
      </>
    );
  }

  const caption = phone
    ? "Last 24 hours, by destination."
    : `Last 24 hours. Line width shows how many spots matched.${model.moreConnections ? ` Showing your top ${TOP_CONNECTIONS} connections.` : ""}`;

  return (
    <>
      <PageTitle>Home</PageTitle>
      <Grid container spacing={2} sx={{ mb: 2 }}>
        <Grid size={6}>
          <StatCard
            label="Delivered" value={total(flow?.delivered)}
            caption={phone ? "last 24 hours" : "spots sent to your destinations · last 24 hours"}
          />
        </Grid>
        <Grid size={6}>
          <StatCard
            label="Matched" value={total(flow?.matched)}
            caption={phone ? "last 24 hours" : "spots your connections picked up · last 24 hours"}
          />
        </Grid>
      </Grid>
      {!loading && dests.length === 0
        ? (
          <EmptyCard
            line="Your connections have nowhere to send spots yet." action="Add your first destination" busy={busy}
            onClick={() => setAdding("destination")}
          />
        )
        : (
          <Paper variant="outlined">
            {busy && <LinearProgress />}
            <Box sx={{ p: { xs: 2, sm: 3 } }}>
              <Typography variant="h6" component="h2">How your spots flow</Typography>
              <Typography variant="caption" color="text.secondary" component="p" sx={{ mb: 2 }}>{caption}</Typography>
              {!loading && (phone
                ? (
                  <>
                    <Stack spacing={1}>
                      {totals.map((d) => (
                        <FlowNode key={d.id} to={`/destinations/${d.id}`} icon={<DestinationIcon />} name={d.name} detail={destinationDetail(d)} />
                      ))}
                    </Stack>
                    <Button component={RouterLink} to="/connections" sx={{ mt: 1 }}>View all connections</Button>
                  </>
                )
                : <FlowDiagram flow={model} />)}
            </Box>
          </Paper>
        )}
      {dialogs}
    </>
  );
}
