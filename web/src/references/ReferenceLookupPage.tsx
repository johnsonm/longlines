import { useState, type FormEvent, type ReactNode } from "react";
import {
  Alert, Box, Button, Card, CardContent, Chip, Divider, LinearProgress, Link, List, ListItem, ListItemButton, Stack, TextField, Typography,
  useMediaQuery, useTheme,
} from "@mui/material";
import SearchIcon from "@mui/icons-material/Search";
import { Link as RouterLink, useSearchParams } from "react-router";
import { errorText } from "../app/hooks";
import { PageTitle } from "../layout/PageTitle";
import { fmt } from "../stats/format";
import { useStats } from "../stats/useStats";
import { PROGRAMS } from "./format";
import { referencePath, referenceProgram } from "./paths";
import {
  activationsLine, detailLine, INVALID_SEARCH, matchesTitle, nameParts, noMatches, PROGRAM_CHIPS, searchWords, validSearch,
} from "./search";
import type { ReferenceProgram, ReferenceSearch, ReferenceSearchResult } from "./types";
import { useReferenceSearch } from "./useReferenceSearch";

/** How many of the Stats snapshot's topReferences the no-query card shows. */
const MOST_SPOTTED = 5;

/** What a failed search says when the function sent no message of its own. */
export const SEARCH_FAILED = "Couldn't search the reference lists.";

/**
 * /ref: find a POTA park, SOTA summit or WWFF reference. The submitted query and the program live in
 * the URL (/ref?q=mitchell&program=sota), so Back and a shared link show the same search; each
 * search is one request (useReferenceSearch), never one per keystroke.
 */
export function ReferenceLookupPage() {
  const theme = useTheme();
  const mobile = useMediaQuery(theme.breakpoints.down("sm"));
  // Autofocus on desktop only, so a phone keyboard doesn't cover the page, as on Callsign lookup.
  const desktop = useMediaQuery(theme.breakpoints.up("md"), { noSsr: true });
  const [params, setParams] = useSearchParams();
  const q = (params.get("q") ?? "").trim();
  const program = referenceProgram(params.get("program") ?? "");

  // The field follows the URL when Back or a link changes the search.
  const [value, setValue] = useState(q);
  const [shownQ, setShownQ] = useState(q);
  if (shownQ !== q) {
    setShownQ(q);
    setValue(q);
  }
  // A submitted query outside search_references' bounds, until the field changes.
  const [refused, setRefused] = useState(false);

  const valid = q !== "" && validSearch(q);
  const { search, error, loading, retry } = useReferenceSearch(valid ? q : null, program);
  // A link's query outside the bounds is refused without a request, as a typed one is.
  const invalid = refused || (q !== "" && !valid && value === q);

  const go = (query: string, p: ReferenceProgram | null) => {
    const next = new URLSearchParams();
    if (query) next.set("q", query);
    if (p) next.set("program", p);
    // An unchanged search adds no history entry (and the cache answers it anyway). After a failure
    // the same search asks again, so Look up is how to try again.
    if (next.toString() !== params.toString()) setParams(next);
    if (query === q && p === program && error !== null) retry();
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const query = value.trim();
    if (query !== "" && !validSearch(query)) setRefused(true);
    else go(query, program);
  };

  const field = (
    <TextField
      type="search"
      value={value}
      onChange={(e) => {
        setValue(e.target.value);
        setRefused(false);
      }}
      label={mobile ? undefined : "Reference or name"}
      placeholder={mobile ? "Reference or name, like US-2763" : "Reference or name, like US-2763 or Mount Mitchell"}
      error={invalid}
      helperText={invalid ? INVALID_SEARCH : undefined}
      autoFocus={desktop && q === ""}
      fullWidth
      slotProps={{
        inputLabel: { shrink: true },
        htmlInput: { "aria-label": "Reference or name", autoCapitalize: "characters", autoCorrect: "off", spellCheck: false },
      }}
    />
  );

  return (
    <Stack spacing={3} useFlexGap>
      <Box>
        <PageTitle>Reference lookup</PageTitle>
        <Typography color="text.secondary">Find a POTA park, SOTA summit or WWFF reference by its reference or its name.</Typography>
      </Box>

      <Stack component="form" onSubmit={submit} noValidate spacing={2} useFlexGap>
        <Stack direction="row" spacing={mobile ? 1 : 1.5} useFlexGap sx={{ alignItems: "flex-start", maxWidth: mobile ? undefined : 720 }}>
          {field}
          {mobile
            ? (
              <Button type="submit" variant="contained" aria-label="Look up" sx={{ minWidth: 56, height: 56, flexShrink: 0 }}>
                <SearchIcon />
              </Button>
            )
            : (
              <Button type="submit" variant="contained" size="large" startIcon={<SearchIcon />} sx={{ height: 56, flexShrink: 0 }}>
                Look up
              </Button>
            )}
        </Stack>
        <Stack role="group" aria-label="Program" direction="row" spacing={1} useFlexGap sx={{ flexWrap: mobile ? "nowrap" : "wrap", overflowX: "auto" }}>
          {PROGRAM_CHIPS.map((c) => {
            const on = c.program === program;
            return (
              <Chip
                key={c.label}
                label={mobile ? c.short : c.label}
                color={on ? "primary" : "default"}
                variant={on ? "filled" : "outlined"}
                aria-pressed={on}
                onClick={() => go(q, c.program)}
              />
            );
          })}
        </Stack>
      </Stack>

      {q === "" && <MostSpotted />}
      {valid && loading && <LinearProgress />}
      {valid && error !== null && <Alert severity="error">{errorText(error, SEARCH_FAILED)}</Alert>}
      {valid && search && <Results query={q} search={search} mobile={mobile} />}
    </Stack>
  );
}

function Results({ query, search, mobile }: { query: string; search: ReferenceSearch; mobile: boolean }) {
  const [now] = useState(() => new Date());
  if (!search.results.length) {
    return (
      <Card variant="outlined">
        <CardContent>
          <Typography color="text.secondary">{noMatches(query)}</Typography>
        </CardContent>
      </Card>
    );
  }
  const words = searchWords(query);
  return (
    <Card variant="outlined">
      <CardContent>
        <Typography variant="h6" component="h2">{matchesTitle(search.results.length, query)}</Typography>
        <Typography variant="body2" color="text.secondary">Most activated first</Typography>
      </CardContent>
      <Divider />
      <List disablePadding>
        {search.results.map((r, i) => (
          <ResultRow
            key={`${r.program} ${r.reference}`}
            result={r}
            words={words}
            now={now}
            mobile={mobile}
            divider={i < search.results.length - 1}
          />
        ))}
      </List>
      {search.more && (
        <>
          <Divider />
          <CardContent>
            <Typography variant="body2" color="text.secondary">Showing the top 25. Add a word to narrow it down.</Typography>
          </CardContent>
        </>
      )}
    </Card>
  );
}

/** The name with the query's words in medium weight (subtitle2 is body2's size at weight 500). */
function Name({ name, words }: { name: string; words: string[] }) {
  return (
    <Typography variant="body2" component="span">
      {nameParts(name, words).map((p, i) =>
        p.match ? <Typography key={i} variant="subtitle2" component="span">{p.text}</Typography> : p.text
      )}
    </Typography>
  );
}

function ProgramChip({ program }: { program: ReferenceProgram }) {
  const info = PROGRAMS[program];
  return <Chip size="small" color={info.color} label={info.short} />;
}

function ResultRow(
  { result, words, now, mobile, divider }: { result: ReferenceSearchResult; words: string[]; now: Date; mobile: boolean; divider: boolean },
) {
  const path = referencePath(result.program, result.reference);
  const detail = detailLine(result);
  const right = activationsLine(result, now);
  const retired = !result.active && <Chip size="small" variant="outlined" label="Retired" />;
  const reference = <Typography variant="subtitle2" component="span" color="primary">{result.reference}</Typography>;

  const body = mobile
    ? (
      <Box sx={{ minWidth: 0, width: "100%" }}>
        <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: "center", flexWrap: "wrap" }}>
          {reference}
          <ProgramChip program={result.program} />
          {retired}
        </Stack>
        {result.name && <Box><Name name={result.name} words={words} /></Box>}
        {detail && <Typography variant="body2" color="text.secondary">{detail}</Typography>}
        <Typography variant="body2" color="text.secondary">{right}</Typography>
      </Box>
    )
    : (
      <Stack direction="row" spacing={2} useFlexGap sx={{ alignItems: "center", width: "100%" }}>
        <Box sx={{ minWidth: 120 }}>{reference}</Box>
        <ProgramChip program={result.program} />
        <Box sx={{ flexGrow: 1, minWidth: 0 }}>
          <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: "center", flexWrap: "wrap" }}>
            {result.name && <Name name={result.name} words={words} />}
            {retired}
          </Stack>
          {detail && <Typography variant="body2" color="text.secondary">{detail}</Typography>}
        </Box>
        <Typography variant="body2" color="text.secondary" sx={{ flexShrink: 0 }}>{right}</Typography>
      </Stack>
    );

  // SQL only returns references of programs with pages, so path is null only for a reference the router can't hold.
  return <Row path={path} divider={divider}>{body}</Row>;
}

/** A list row linking to a reference page; plain for a reference the router can't hold. */
function Row({ path, divider, children }: { path: string | null; divider: boolean; children: ReactNode }) {
  if (!path) return <ListItem divider={divider}>{children}</ListItem>;
  return (
    <ListItem disablePadding divider={divider}>
      <ListItemButton component={RouterLink} to={path}>{children}</ListItemButton>
    </ListItem>
  );
}

/** With no query: the Stats snapshot's most spotted references, from useStats() (never a new request). */
function MostSpotted() {
  const { stats } = useStats();
  const top = (stats?.payload.topReferences ?? []).slice(0, MOST_SPOTTED);
  if (!top.length) return null;
  return (
    <Card variant="outlined">
      <CardContent>
        <Typography variant="h6" component="h2">Most spotted this week</Typography>
        <Typography variant="body2" color="text.secondary">Parks, summits and WWFF references</Typography>
      </CardContent>
      <Divider />
      <List disablePadding>
        {top.map((r, i) => {
          const program = referenceProgram(r.program);
          const path = program && referencePath(program, r.reference);
          const body = (
            <Stack direction="row" spacing={1.5} useFlexGap sx={{ alignItems: "center", width: "100%" }}>
              {program && <ProgramChip program={program} />}
              <Box sx={{ flexGrow: 1, minWidth: 0 }}>
                <Typography variant="subtitle2" component="div" color="primary">{r.reference}</Typography>
                {r.name && <Typography variant="body2" color="text.secondary">{r.name}</Typography>}
              </Box>
              <Typography variant="body2" color="text.secondary">{fmt(r.spots)}</Typography>
            </Stack>
          );
          return <Row key={`${r.program} ${r.reference}`} path={path} divider={i < top.length - 1}>{body}</Row>;
        })}
      </List>
      <Divider />
      <CardContent>
        <Link component={RouterLink} to="/stats" variant="body2">More on the Stats page</Link>
      </CardContent>
    </Card>
  );
}
