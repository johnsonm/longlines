import { Card, CardActionArea, CardContent, Chip, Stack, Typography } from "@mui/material";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import { Link } from "react-router";
import type { SourceInfo } from "./sources";
import { STATUS_COLOR, STATUS_LABEL, type SourceStatus } from "./status";
import { formatRate, rateUnit, type Rates } from "./rates";
import { SourceMark } from "./SourceMark";

export function SourceTile({ source, status, rates }: { source: SourceInfo; status: SourceStatus; rates: Rates | null }) {
  const live = source.status === "live";
  const body = (
    <CardContent>
      <Stack spacing={2}>
        <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: "flex-start", flexWrap: "wrap" }}>
          <SourceMark source={source} />
          <Stack direction="row" spacing={1} useFlexGap sx={{ flexGrow: 1, justifyContent: "flex-end", flexWrap: "wrap" }}>
            <Chip size="small" color={STATUS_COLOR[status]} variant={status === "planned" ? "outlined" : "filled"} label={STATUS_LABEL[status]} />
          </Stack>
        </Stack>
        <div>
          <Typography variant="h6" component="h2" color={live ? "text.primary" : "text.secondary"}>{source.title}</Typography>
          <Typography variant="body2" color="text.secondary">{source.tagline}</Typography>
        </div>
        <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
          <Chip size="small" variant="outlined" color={source.volume === "high" ? "warning" : "default"}
            label={source.volume === "high" ? "High volume" : "Standard volume"} />
          {rates && <Typography variant="body2" color="text.secondary">{formatRate(rates.average)} {rateUnit(source.statsKey)}</Typography>}
          {live && <ChevronRightIcon color="action" sx={{ ml: "auto" }} aria-hidden />}
        </Stack>
      </Stack>
    </CardContent>
  );
  return (
    <Card variant="outlined" sx={{ height: "100%" }}>
      {live
        ? <CardActionArea component={Link} to={`/sources/${source.id}`} sx={{ height: "100%" }}>{body}</CardActionArea>
        : body}
    </Card>
  );
}
