import type { ReactNode } from "react";
import { Box, Card, CardActionArea, Stack, Typography, useTheme } from "@mui/material";
import { styled } from "@mui/material/styles";
import SendIcon from "@mui/icons-material/Send";
import { Link as RouterLink } from "react-router";
import { sourceName } from "../sources/sources";
import { sourceColor } from "./colors";
import { columnHeight, linkPaths, NODE_HEIGHT, NODE_WIDTH, type LinkPath } from "./layout";
import { connectionDetail, count, destinationDetail, moreConnectionsName, type Flow, type FlowLink } from "./model";

/** The "more" nodes stand for several, so their outline is dashed. */
const MoreCard = styled(Card)({ borderStyle: "dashed" });

interface NodeProps {
  to: string;
  icon: ReactNode;
  name: string;
  detail: string;
  more?: boolean;
}

/** One 56 px node: an icon or colour dot, a name and a caption, linking to its page. */
export function FlowNode({ to, icon, name, detail, more = false }: NodeProps) {
  const Frame = more ? MoreCard : Card;
  return (
    <Frame variant="outlined" sx={{ height: NODE_HEIGHT, flex: "none" }}>
      <CardActionArea component={RouterLink} to={to} sx={{ height: 1, px: 1.5, display: "flex", gap: 1.5, justifyContent: "flex-start" }}>
        {icon}
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="subtitle2" noWrap>{name}</Typography>
          <Typography variant="caption" color="text.secondary" component="div" noWrap>{detail}</Typography>
        </Box>
      </CardActionArea>
    </Frame>
  );
}

export function Dot({ color }: { color: string }) {
  return (
    <svg width={10} height={10} viewBox="0 0 10 10" aria-hidden="true">
      <circle cx={5} cy={5} r={5} fill={color} />
    </svg>
  );
}

export function DestinationIcon() {
  return <SendIcon fontSize="small" color="action" />;
}

function Column({ children }: { children: ReactNode }) {
  return <Stack sx={{ width: NODE_WIDTH, flex: "none", justifyContent: "space-between" }}>{children}</Stack>;
}

/** One gap between columns: an SVG stretched across it, strokes kept at their pixel width. */
function Links({ height, paths, links }: { height: number; paths: LinkPath[]; links: FlowLink[] }) {
  const theme = useTheme();
  return (
    <Box sx={{ flex: "1 1 0", minWidth: 0 }}>
      <svg aria-hidden="true" width="100%" height={height} viewBox={`0 0 100 ${height}`} preserveAspectRatio="none" overflow="visible">
        {paths.map((p, i) => (
          <path
            key={i} d={p.d} fill="none" stroke={sourceColor(theme, links[i]?.source ?? null)} strokeOpacity={0.45}
            strokeWidth={p.width} vectorEffect="non-scaling-stroke"
          />
        ))}
      </svg>
    </Box>
  );
}

/** Sources, connections and destinations in three columns, joined by curved links (desktop only). */
export function FlowDiagram({ flow }: { flow: Flow }) {
  const theme = useTheme();
  const sourceRows = flow.sources.length + (flow.moreSources > 0 ? 1 : 0);
  const connectionRows = flow.connections.length + (flow.moreConnections ? 1 : 0);
  const destinationRows = flow.destinations.length + (flow.moreDestinations > 0 ? 1 : 0);
  const height = columnHeight(Math.max(sourceRows, connectionRows, destinationRows));
  const left = linkPaths(sourceRows, connectionRows, height, flow.sourceLinks);
  const right = linkPaths(connectionRows, destinationRows, height, flow.destinationLinks);
  const heading = (label: string) => (
    <Typography variant="overline" color="text.secondary" component="div" sx={{ width: NODE_WIDTH, flex: "none" }}>{label}</Typography>
  );

  return (
    <Box sx={{ overflowX: "auto" }}>
      <Box sx={{ minWidth: 820 }}>
        <Box sx={{ display: "flex" }}>
          {heading("Sources")}
          <Box sx={{ flex: "1 1 0" }} />
          {heading("Connections")}
          <Box sx={{ flex: "1 1 0" }} />
          {heading("Destinations")}
        </Box>
        <Box sx={{ display: "flex", height }}>
          <Column>
            {flow.sources.map((s) => (
              <FlowNode
                key={s.id} to={`/sources/${s.id}`} icon={<Dot color={sourceColor(theme, s.id)} />}
                name={sourceName(s.id)} detail={`${count(s.matched)} matched`}
              />
            ))}
            {flow.moreSources > 0 && (
              <FlowNode to="/sources" icon={<Dot color="none" />} name={`+${flow.moreSources} more`} detail="View all" more />
            )}
          </Column>
          <Links height={height} paths={left} links={flow.sourceLinks} />
          <Column>
            {flow.connections.map((c) => (
              <FlowNode
                key={c.id} to={`/connections/${c.id}`} icon={<Dot color={sourceColor(theme, c.source)} />}
                name={c.name} detail={connectionDetail(c)}
              />
            ))}
            {flow.moreConnections && (
              <FlowNode
                to="/connections" icon={<Dot color="none" />} name={moreConnectionsName(flow.moreConnections.count)}
                detail={`${count(flow.moreConnections.matched)} matched · View all`} more
              />
            )}
          </Column>
          <Links height={height} paths={right} links={flow.destinationLinks} />
          <Column>
            {flow.destinations.map((d) => (
              <FlowNode key={d.id} to={`/destinations/${d.id}`} icon={<DestinationIcon />} name={d.name} detail={destinationDetail(d)} />
            ))}
            {flow.moreDestinations > 0 && (
              <FlowNode to="/destinations" icon={<DestinationIcon />} name={`+${flow.moreDestinations} more`} detail="View all" more />
            )}
          </Column>
        </Box>
      </Box>
    </Box>
  );
}
