import { Avatar, Box, Button, Paper, Stack, Typography } from "@mui/material";
import { styled } from "@mui/material/styles";
import NotificationsIcon from "@mui/icons-material/Notifications";

import { MOCKUP_CAPTIONS, type MockupVariant } from "./pushModel";

const LABELS: Record<MockupVariant, string> = { android: "Android", iphone: "iPhone", desktop: "Desktop" };

/** The app icon, in the theme's primary colour: palette only, never the canvas's hex. */
const AppAvatar = styled(Avatar)(({ theme }) => ({
  width: 24,
  height: 24,
  backgroundColor: theme.palette.primary.main,
  color: theme.palette.primary.contrastText,
}));

interface Props {
  variant: MockupVariant;
  /** The text SQL rendered (preview_push_notification); the web never builds it. */
  title: string;
  body: string;
  /** The action buttons, already labelled; empty when the destination hides them or the variant cannot show them. */
  actions: string[];
}

/**
 * A rough picture of the notification on each platform, from Paper
 * elevation and the palette. Only the arrangement differs: the text is
 * what SQL rendered, so the three show the same words.
 */
export function NotificationMockup({ variant, title, body, actions }: Props) {
  const shown = variant === "iphone" ? [] : actions;
  return (
    <Stack spacing={1}>
      <Typography variant="overline" color="text.secondary">{LABELS[variant]}</Typography>
      <Paper elevation={variant === "desktop" ? 6 : 2} sx={{ p: 1.5 }} role="figure" aria-label={`${LABELS[variant]} notification`}>
        <Stack direction="row" spacing={1} sx={{ alignItems: "center", mb: 0.5 }}>
          <AppAvatar variant={variant === "iphone" ? "rounded" : "circular"}>
            <NotificationsIcon sx={{ fontSize: 16 }} />
          </AppAvatar>
          <Typography variant="caption" color="text.secondary" sx={{ flexGrow: 1 }}>
            {variant === "iphone" ? "LONG LINES" : "Long Lines"}
          </Typography>
          <Typography variant="caption" color="text.secondary">now</Typography>
        </Stack>
        <Typography variant="subtitle2" sx={{ overflowWrap: "anywhere" }}>{title}</Typography>
        <Typography variant="body2" color="text.secondary" sx={{ whiteSpace: "pre-line", overflowWrap: "anywhere" }}>{body}</Typography>
        {shown.length > 0 && (
          <Box sx={{ mt: 1, display: "flex", gap: 1, flexWrap: "wrap" }}>
            {shown.map((a) => <Button key={a} size="small" tabIndex={-1} aria-hidden>{a}</Button>)}
          </Box>
        )}
      </Paper>
      <Typography variant="caption" color="text.secondary">{MOCKUP_CAPTIONS[variant]}</Typography>
    </Stack>
  );
}
