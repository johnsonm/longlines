import {
  Accordion, AccordionDetails, AccordionSummary, Box, Button, Card, CardContent, Chip, Divider, LinearProgress, Link, Stack,
  Typography,
} from "@mui/material";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import { Link as RouterLink } from "react-router";
import { RELAY_DOWNLOAD_URL } from "../tokens/model";
import { connectionDetail, percent, relayConnected, relayLine, requirementsLine, usedByNote, workedLine } from "./model";
import type { GoalProgress } from "./types";

const HOW_CONTACT = "When you log a contact, Long Lines checks it against your entries. States and bands come from the contact. Parks come from the POTA spot for that station around the time you logged it.";
const HOW_SPOT = "A spot alone never marks anything worked. Only a contact you logged does. You can also mark entries by hand.";
const HOW_OFF = "While the relay is off, contacts you log don't reach Long Lines, so nothing on this goal gets marked worked.";
const HOW_HAND = "You mark entries on this goal by hand. Contacts you log don't mark anything on it.";

const completeCount = (p: GoalProgress): number => p.requirements.filter((r) => r.complete).length;

function Overline({ children }: { children: string }) {
  return <Typography variant="overline" color="text.secondary" component="h2">{children}</Typography>;
}

/** Progress: "18 of 64 worked" and how many requirements are complete. */
export function ProgressCard({ progress }: { progress: GoalProgress }) {
  const l = progress.list;
  const done = l.status === "complete";
  return (
    <Card variant="outlined">
      <CardContent>
        <Overline>Progress</Overline>
        <Typography variant="h5" component="p" sx={{ my: 1.5 }}>{workedLine(l.worked, l.total)}</Typography>
        <LinearProgress variant="determinate" value={percent(l.worked, l.total)} color={done ? "success" : "primary"} aria-label="Overall progress" />
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1.5 }}>
          {requirementsLine(completeCount(progress), progress.requirements.length, l.status)}
        </Typography>
      </CardContent>
    </Card>
  );
}

function DownloadRelay() {
  return (
    <Button href={RELAY_DOWNLOAD_URL} target="_blank" rel="noopener noreferrer" endIcon={<OpenInNewIcon />}>
      Download the relay
    </Button>
  );
}

function RelayStatus({ progress, now, phone }: { progress: GoalProgress; now: Date; phone: boolean }) {
  const connected = relayConnected(progress.relay);
  return (
    <Box>
      <Stack direction="row" spacing={1} sx={{ alignItems: "center", justifyContent: "space-between" }}>
        <Typography variant="body2">{phone ? "Relay" : "Long Lines relay"}</Typography>
        <Chip size="small" color={connected ? "success" : "warning"} label={connected ? "Connected" : "Not connected"} />
      </Stack>
      <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 0.5 }}>{relayLine(progress.relay, now, phone)}</Typography>
    </Box>
  );
}

/** How entries get marked: the relay's state and a short plain explanation. */
export function MarkingCard({ progress, now }: { progress: GoalProgress; now: Date }) {
  const relay = progress.list.marking === "relay";
  const connected = relayConnected(progress.relay);
  return (
    <Card variant="outlined">
      <CardContent>
        <Overline>How entries get marked</Overline>
        {relay
          ? (
            <Stack spacing={2} sx={{ mt: 1.5 }}>
              <RelayStatus progress={progress} now={now} phone={false} />
              {connected
                ? (
                  <>
                    <Typography variant="body2">{HOW_CONTACT}</Typography>
                    <Typography variant="caption" color="text.secondary" component="p">{HOW_SPOT}</Typography>
                  </>
                )
                : (
                  <>
                    <Typography variant="body2">{HOW_OFF}</Typography>
                    <Box><DownloadRelay /></Box>
                  </>
                )}
            </Stack>
          )
          : <Typography variant="body2" sx={{ mt: 1.5 }}>{HOW_HAND}</Typography>}
      </CardContent>
    </Card>
  );
}

/** Beside "Needs a look": why a contact can't be matched to a park. */
export function WhyCard() {
  return (
    <Card variant="outlined">
      <CardContent>
        <Overline>Why this happens</Overline>
        <Typography variant="body2" sx={{ mt: 1.5 }}>
          Your log says who you worked, not which park they were in. Long Lines looks for a POTA spot of that station near the time you logged it. No spot, or spots at two parks, means it can't tell.
        </Typography>
        <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 1.5 }}>
          States and bands never need a look. They come straight from the contact.
        </Typography>
      </CardContent>
    </Card>
  );
}

/** Used by: the connections whose rules name this goal, each linking to its editor. */
export function UsedByCard({ progress, phone }: { progress: GoalProgress; phone: boolean }) {
  const used = progress.used_by;
  return (
    <Card variant="outlined" component="section" aria-label="Used by">
      <CardContent>
        <Overline>Used by</Overline>
        {used.length === 0
          ? <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>Not used by any connection</Typography>
          : (
            <Stack divider={<Divider />} sx={{ mt: 0.5 }}>
              {used.map((c) => (
                <Box key={c.id} sx={{ py: 1.5 }}>
                  <Link component={RouterLink} to={`/connections/${c.id}`} color="inherit" underline="hover" sx={{ overflowWrap: "anywhere" }}>
                    {c.name}
                  </Link>
                  <Typography variant="body2" color="text.secondary">{connectionDetail(c)}</Typography>
                </Box>
              ))}
            </Stack>
          )}
        {!phone && used.length > 0 && (
          <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 2 }}>
            {usedByNote(progress.list.status, used.length)}
          </Typography>
        )}
      </CardContent>
    </Card>
  );
}

/** Phones: progress and the relay's state in one card at the top. */
export function PhoneSummaryCard({ progress, now }: { progress: GoalProgress; now: Date }) {
  const l = progress.list;
  return (
    <Card variant="outlined">
      <CardContent>
        <Typography variant="h5" component="p">{workedLine(l.worked, l.total)}</Typography>
        <LinearProgress
          variant="determinate" value={percent(l.worked, l.total)} color={l.status === "complete" ? "success" : "primary"}
          aria-label="Overall progress" sx={{ my: 1.5 }}
        />
        <Typography variant="body2" color="text.secondary">
          {requirementsLine(completeCount(progress), progress.requirements.length, l.status)}
        </Typography>
        {l.marking === "relay" && l.status === "active" && (
          <Box sx={{ mt: 2 }}>
            <RelayStatus progress={progress} now={now} phone />
          </Box>
        )}
      </CardContent>
    </Card>
  );
}

/** Phones: How entries get marked, folded. */
export function PhoneMarkingAccordion({ progress }: { progress: GoalProgress }) {
  const relay = progress.list.marking === "relay";
  const connected = relayConnected(progress.relay);
  return (
    <Accordion variant="outlined" disableGutters>
      <AccordionSummary expandIcon={<ExpandMoreIcon />}>
        <Typography>How entries get marked</Typography>
      </AccordionSummary>
      <AccordionDetails>
        {!relay && <Typography variant="body2">{HOW_HAND}</Typography>}
        {relay && connected && <Typography variant="body2">{HOW_CONTACT}</Typography>}
        {relay && !connected && (
          <Stack spacing={1}>
            <Typography variant="body2">{HOW_OFF}</Typography>
            <Box><DownloadRelay /></Box>
          </Stack>
        )}
      </AccordionDetails>
    </Accordion>
  );
}
