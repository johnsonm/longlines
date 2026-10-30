import { useCallback, useEffect, useRef, useState } from "react";
import {
  Alert, AlertTitle, Box, Breadcrumbs, Button, Chip, Grid, IconButton, LinearProgress, Link, Stack, Typography, useMediaQuery,
  type Theme,
} from "@mui/material";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import EditIcon from "@mui/icons-material/Edit";
import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import { Link as RouterLink, useNavigate } from "react-router";
import { PageTitle } from "../layout/PageTitle";
import { copyGoal, loadGoal, markGoalEntry, resolveGoalReview } from "../lib/api";
import { errorText, useNotify } from "../app/hooks";
import { RELAY_DOWNLOAD_URL } from "../tokens/model";
import {
  browserStorage, completeRuleBanner, completeText, copyYear, datesLine, dismissRelay, endedBanner, neededParks,
  relayBannerText, relayDismissed, reviewBanner, showRelayBanner,
} from "./model";
import { MarkingCard, PhoneMarkingAccordion, PhoneSummaryCard, ProgressCard, UsedByCard, WhyCard } from "./Panels";
import { RequirementCard } from "./RequirementCard";
import { ReviewCard } from "./ReviewCard";
import type { GoalProgress } from "./types";
import { useDeleteGoal } from "./useDeleteGoal";

/** /goals/:id: one list's progress, read-only but for marking entries and resolving contacts (canvas page 1). */
export function GoalPage({ id }: { id: string }) {
  const [progress, setProgress] = useState<GoalProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Only the newest request lands, so a slow load never replaces the answer to a later change.
  const latest = useRef(0);

  const load = useCallback(async (): Promise<GoalProgress | null> => {
    const request = ++latest.current;
    try {
      const next = await loadGoal(id);
      if (request === latest.current) {
        setProgress(next);
        setError(null);
      }
      return next;
    } catch (err) {
      if (request === latest.current) setError(errorText(err, "Couldn't load the goal."));
      return null;
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!progress) return error ? <Alert severity="error">{error}</Alert> : <LinearProgress />;
  return <Progress progress={progress} reload={load} error={error} />;
}

interface ProgressProps {
  progress: GoalProgress;
  reload: () => Promise<GoalProgress | null>;
  error: string | null;
}

function Progress({ progress, reload, error }: ProgressProps) {
  const notify = useNotify();
  const navigate = useNavigate();
  const phone = useMediaQuery((t: Theme) => t.breakpoints.down("md"));
  const [busy, setBusy] = useState(false);
  const [dismissed, setDismissed] = useState(() => relayDismissed(browserStorage(), progress.list.id, new Date()));
  const reviewRef = useRef<HTMLDivElement>(null);
  const deleting = useDeleteGoal(progress, reload);
  // The clock for "64 days left" and "12 minutes ago", as other pages keep one: set when the page opens.
  const [now] = useState(() => new Date());
  const l = progress.list;
  const editPath = `/goals/${l.id}/edit`;

  /** A change, then the page again from SQL: every count and mark is SQL's. */
  const run = async (change: () => Promise<unknown>, fallback: string) => {
    setBusy(true);
    try {
      await change();
      await reload();
    } catch (err) {
      notify(errorText(err, fallback));
    } finally {
      setBusy(false);
    }
  };

  const mark = (requirementId: string) => (value: string, worked: boolean) =>
    void run(() => markGoalEntry(requirementId, value, worked), "Couldn't update the entry.");
  const resolve = (reviewId: string, reference: string | null) =>
    void run(() => resolveGoalReview(reviewId, reference), "Couldn't save that.");

  const copy = async () => {
    setBusy(true);
    try {
      const copyId = await copyGoal(l.id);
      void navigate(`/goals/${copyId}/edit`);
    } catch (err) {
      notify(errorText(err, "Couldn't copy the goal."));
    } finally {
      setBusy(false);
    }
  };

  const dismiss = () => {
    dismissRelay(browserStorage(), l.id, new Date());
    setDismissed(true);
  };

  const ruleOff = l.status === "complete" ? completeRuleBanner(progress.used_by) : null;
  const ended = l.status === "ended" ? endedBanner(l, progress.used_by.length) : null;
  const reviews = progress.reviews.length > 0 && (
    <Box ref={reviewRef}>
      <ReviewCard reviews={progress.reviews} neededParks={neededParks(progress.requirements)} now={now} busy={busy} onResolve={resolve} />
    </Box>
  );
  const requirements = progress.requirements.map((r) => (
    <RequirementCard key={r.id} req={r} status={l.status} phone={phone} now={now} busy={busy} onMark={mark(r.id)} />
  ));

  return (
    <Stack spacing={3}>
      {!phone && (
        <Breadcrumbs>
          <Link component={RouterLink} to="/goals" underline="hover" color="inherit">Goals</Link>
          <Typography color="text.primary">{l.name}</Typography>
        </Breadcrumbs>
      )}
      <Box>
        <Stack direction="row" spacing={2} useFlexGap sx={{ justifyContent: "space-between", alignItems: "center", flexWrap: "wrap" }}>
          <Stack direction="row" spacing={1} sx={{ alignItems: "center", minWidth: 0 }}>
            {phone && (
              <IconButton aria-label="Back" component={RouterLink} to="/goals" edge="start">
                <ArrowBackIcon />
              </IconButton>
            )}
            <PageTitle>{l.name}</PageTitle>
            {l.status === "complete" && <Chip size="small" color="success" label="Complete" />}
            {l.status === "ended" && <Chip size="small" variant="outlined" label="Ended" />}
          </Stack>
          <Button variant="contained" startIcon={<EditIcon />} component={RouterLink} to={editPath}>
            {phone ? "Edit" : "Edit goal"}
          </Button>
        </Stack>
        <Typography color="text.secondary">{datesLine(l, now, phone)}</Typography>
      </Box>

      {error && <Alert severity="error">{error}</Alert>}

      {showRelayBanner(l, progress.relay) && !dismissed && (
        <Alert severity="warning">
          <AlertTitle>Entries aren't being marked automatically</AlertTitle>
          {relayBannerText(progress.relay, now)}
          <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: "wrap", mt: 1 }}>
            <Button color="inherit" size="small" href={RELAY_DOWNLOAD_URL} target="_blank" rel="noopener noreferrer" endIcon={<OpenInNewIcon />}>
              Download the relay
            </Button>
            <Button color="inherit" size="small" onClick={dismiss}>Dismiss for 7 days</Button>
          </Stack>
        </Alert>
      )}

      {progress.reviews.length > 0 && (
        <Alert
          severity="info"
          action={
            <Button color="inherit" size="small" onClick={() => reviewRef.current?.scrollIntoView?.({ behavior: "smooth", block: "start" })}>
              Review
            </Button>
          }
        >
          {reviewBanner(progress.reviews.length)}
        </Alert>
      )}

      {l.status === "complete" && (
        <Alert
          severity="success"
          action={ruleOff ? undefined : <Button color="inherit" size="small" onClick={deleting.start}>Delete goal</Button>}
        >
          <AlertTitle>You worked everything on this goal</AlertTitle>
          {completeText(progress.requirements.length)}
        </Alert>
      )}
      {ruleOff && (
        <Alert severity="info">
          <AlertTitle>{ruleOff.title}</AlertTitle>
          {ruleOff.text}
          <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: "wrap", mt: 1 }}>
            <Button color="inherit" size="small" onClick={() => void navigate("/connections")}>Review connections</Button>
            <Button color="inherit" size="small" onClick={deleting.start}>Delete goal</Button>
          </Stack>
        </Alert>
      )}
      {ended && (
        <Alert severity="warning">
          <AlertTitle>{ended.title}</AlertTitle>
          {ended.text}
          <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: "wrap", mt: 1 }}>
            <Button color="inherit" size="small" onClick={() => void navigate(editPath)}>Change dates</Button>
            <Button color="inherit" size="small" disabled={busy} onClick={() => void copy()}>{`Copy for ${copyYear(l, now)}`}</Button>
            <Button color="inherit" size="small" onClick={deleting.start}>Delete</Button>
          </Stack>
        </Alert>
      )}

      {phone
        ? (
          <Stack spacing={2}>
            <PhoneSummaryCard progress={progress} now={now} />
            {reviews}
            {requirements}
            {l.status === "active" && <PhoneMarkingAccordion progress={progress} />}
            <UsedByCard progress={progress} phone />
          </Stack>
        )
        : (
          <Grid container spacing={2}>
            <Grid size={{ xs: 12, md: 8 }}>
              <Stack spacing={2}>
                {reviews}
                {requirements}
              </Stack>
            </Grid>
            <Grid size={{ xs: 12, md: 4 }}>
              <Stack spacing={2} component="aside" aria-label="Summary">
                <ProgressCard progress={progress} />
                {progress.reviews.length > 0 && <WhyCard />}
                {l.status === "active" && <MarkingCard progress={progress} now={now} />}
                <UsedByCard progress={progress} phone={false} />
              </Stack>
            </Grid>
          </Grid>
        )}
      {deleting.dialog}
    </Stack>
  );
}
