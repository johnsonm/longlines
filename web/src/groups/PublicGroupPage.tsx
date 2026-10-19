import { useEffect, useRef, useState } from "react";
import { Alert, Box, Button, Chip, LinearProgress, Stack, Typography } from "@mui/material";
import ShareIcon from "@mui/icons-material/Share";
import { useSearchParams } from "react-router";
import { PageTitle } from "../layout/PageTitle";
import { loadPublicGroup } from "../lib/api";
import { errorText, useNotify } from "../app/hooks";
import { plural } from "../profile/format";
import { GroupPrivate } from "./GroupPrivate";
import { GroupStatistics } from "./GroupStatistics";
import { parsePeriod, updatedAgo } from "./stats/model";
import type { GroupPeriod, PublicGroupStatistics } from "./stats/types";

/**
 * Asks search engines not to index the page while it is shown. web/vercel.json
 * sends X-Robots-Tag: noindex for /g/* too; the tag covers crawlers that run
 * the app.
 */
function useNoIndex() {
  useEffect(() => {
    const meta = document.createElement("meta");
    meta.name = "robots";
    meta.content = "noindex";
    document.head.appendChild(meta);
    return () => meta.remove();
  }, []);
}

/** /g/<code>: a group's public statistics page (canvas page 10), for anyone with the link. */
export function PublicGroupPage({ slug }: { slug: string }) {
  useNoIndex();
  const notify = useNotify();
  const [search, setSearch] = useSearchParams();
  const period = parsePeriod(search.get("period"));
  // undefined while loading, null for a private or unknown page.
  const [stats, setStats] = useState<PublicGroupStatistics | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [now] = useState(() => new Date());
  const latest = useRef(0);

  useEffect(() => {
    const request = ++latest.current;
    setError(null);
    loadPublicGroup(slug, period)
      .then((next) => {
        if (request === latest.current) setStats(next);
      })
      .catch((err: unknown) => {
        if (request === latest.current) setError(errorText(err, "This page is unavailable right now."));
      });
  }, [slug, period]);

  const name = stats?.group.name;
  useEffect(() => {
    if (!name) return;
    const before = document.title;
    document.title = `${name} statistics`;
    return () => {
      document.title = before;
    };
  }, [name]);

  if (error && !stats) return <Alert severity="error">{error}</Alert>;
  if (stats === undefined) return <LinearProgress />;
  if (stats === null) return <GroupPrivate />;

  const choosePeriod = (next: GroupPeriod) => setSearch(next === "30d" ? {} : { period: next }, { replace: true });
  const url = `${window.location.origin}/g/${slug}`;
  const share = async () => {
    if (typeof navigator.share === "function") {
      try {
        await navigator.share({ title: `${stats.group.name} statistics`, url });
      } catch {
        // Dismissing the share sheet is not an error.
      }
      return;
    }
    try {
      await navigator.clipboard.writeText(url);
      notify("Link copied");
    } catch {
      notify("Couldn't copy the link.");
    }
  };

  return (
    <Stack spacing={3}>
      <Stack direction="row" spacing={2} useFlexGap sx={{ justifyContent: "space-between", alignItems: "center", flexWrap: "wrap" }}>
        <Box sx={{ minWidth: 0 }}>
          <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
            <PageTitle>{stats.group.name}</PageTitle>
            <Chip size="small" variant="outlined" label="Public page" />
          </Stack>
          <Typography variant="body2" color="text.secondary">
            {`Club statistics · ${plural(stats.group.member_count, "member", "members")} · Updated ${updatedAgo(stats.generatedAt, now)}`}
          </Typography>
        </Box>
        <Button variant="outlined" startIcon={<ShareIcon />} onClick={() => void share()}>Share</Button>
      </Stack>
      {error && <Alert severity="error">{error}</Alert>}
      <GroupStatistics stats={stats} period={period} onPeriod={choosePeriod} now={now} />
      <Typography variant="caption" color="text.secondary">
        Built from public spots for the callsigns in this group. The group owner chose to share this page and can turn it off at any time.
        Long Lines does not show addresses.
      </Typography>
    </Stack>
  );
}
