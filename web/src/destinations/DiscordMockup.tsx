import { Avatar, Box, Stack } from "@mui/material";
import { styled } from "@mui/material/styles";
import SendIcon from "@mui/icons-material/Send";
import { useState, type ReactNode } from "react";

import type { DiscordPreview } from "../lib/api";
import { colorHex, renderDiscordMarkdown, todayAt, type MarkdownComponents } from "./discordMarkdown";

// Discord's dark theme, as on the canvas. These are Discord's colours, not
// the app's, so they stay fixed in both of the app's colour schemes.
const DISCORD = {
  background: "#313338",
  embed: "#2b2d31",
  text: "#dbdee1",
  heading: "#f2f3f5",
  muted: "#949ba4",
  link: "#00a8fc",
  blurple: "#5865f2",
  white: "#ffffff",
} as const;

const FONT = '"gg sans", "Noto Sans", "Helvetica Neue", Helvetica, Arial, sans-serif';

const Message = styled("div")({
  backgroundColor: DISCORD.background,
  color: DISCORD.text,
  fontFamily: FONT,
  fontSize: 15,
  lineHeight: 1.375,
  borderRadius: 8,
  padding: 16,
  overflowWrap: "anywhere",
});

const BotAvatar = styled(Avatar)({
  width: 40,
  height: 40,
  backgroundColor: DISCORD.blurple,
  color: DISCORD.white,
});

const Author = styled("span")({ color: DISCORD.heading, fontWeight: 500, fontSize: 16 });

const AppBadge = styled("span")({
  backgroundColor: DISCORD.blurple,
  color: DISCORD.white,
  fontSize: 10,
  fontWeight: 600,
  lineHeight: "15px",
  padding: "0 4px",
  borderRadius: 3,
});

const Time = styled("span")({ color: DISCORD.muted, fontSize: 12 });

const Embed = styled("div", { shouldForwardProp: (p) => p !== "barColor" })<{ barColor: string }>(({ barColor }) => ({
  backgroundColor: DISCORD.embed,
  borderLeft: `4px solid ${barColor}`,
  borderRadius: 4,
  padding: "8px 16px 16px 12px",
  maxWidth: 520,
}));

const EmbedTitle = styled("div")({ color: DISCORD.heading, fontWeight: 600, fontSize: 16 });

const Link = styled("a")({
  color: DISCORD.link,
  textDecoration: "none",
  "&:hover": { textDecoration: "underline" },
});

const Description = styled("div")({ fontSize: 14, whiteSpace: "pre-line" });

const Grid = styled("div")({
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))",
  gap: 8,
  fontSize: 14,
});

const FieldName = styled("div")({ color: DISCORD.heading, fontWeight: 600 });

const Footer = styled("div")({ color: DISCORD.muted, fontSize: 12 });

const Line = styled("div")({ whiteSpace: "pre-line" });

const Bold = styled("strong")({ fontWeight: 700 });

const MARKDOWN: MarkdownComponents = { Bold, Link };

function newTab(href: string, children: ReactNode) {
  return <Link href={href} target="_blank" rel="noopener noreferrer">{children}</Link>;
}

interface Props {
  /** SQL's nine keys (preview_discord_message); null until the first preview loads. */
  preview: DiscordPreview | null;
  /** The clock for the author row's time (default: when the mock-up first rendered); tests pin it. */
  now?: Date;
}

/**
 * A rough picture of the message in Discord's dark theme: the author row,
 * then the card or the plain line. Every word is what SQL rendered; the
 * plain line's **bold** and [text](url) are drawn by discordMarkdown.ts.
 */
export function DiscordMockup({ preview, now }: Props) {
  const [opened] = useState(() => new Date());
  return (
    <Message role="figure" aria-label="Discord message">
      <Stack direction="row" spacing={2}>
        <BotAvatar aria-hidden>
          <SendIcon fontSize="small" />
        </BotAvatar>
        <Box sx={{ minWidth: 0, flexGrow: 1 }}>
          <Stack direction="row" spacing={0.75} sx={{ alignItems: "center", flexWrap: "wrap" }}>
            <Author>Long Lines</Author>
            <AppBadge>APP</AppBadge>
            <Time>{todayAt(now ?? opened)}</Time>
          </Stack>
          {preview === null ? (
            <Line>…</Line>
          ) : preview.discord_style === "plain" ? (
            <Line data-testid="discord-line">{renderDiscordMarkdown(preview.discord_line, MARKDOWN)}</Line>
          ) : (
            <Embed barColor={colorHex(preview.discord_color)} data-testid="discord-embed" sx={{ mt: 0.5 }}>
              <Stack spacing={1}>
                <EmbedTitle>
                  {preview.discord_url ? newTab(preview.discord_url, preview.discord_title) : preview.discord_title}
                </EmbedTitle>
                {preview.discord_description !== "" && <Description>{preview.discord_description}</Description>}
                {preview.discord_grid.length > 0 && (
                  <Grid>
                    {preview.discord_grid.map((f, i) => (
                      <div key={i}>
                        <FieldName>{f.name}</FieldName>
                        <div>{f.value}</div>
                      </div>
                    ))}
                  </Grid>
                )}
                {preview.discord_footer !== null && <Footer>{preview.discord_footer}</Footer>}
              </Stack>
            </Embed>
          )}
        </Box>
      </Stack>
    </Message>
  );
}
