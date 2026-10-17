import type { ComponentType } from "react";
import type { SvgIconProps } from "@mui/material";
import ForumOutlinedIcon from "@mui/icons-material/ForumOutlined";
import HttpIcon from "@mui/icons-material/Http";
import NotificationsOutlinedIcon from "@mui/icons-material/NotificationsOutlined";
import type { DestinationType } from "../lib/api";

export interface DestType {
  id: DestinationType;
  label: string;
  /** The picker's one-sentence description (page 5). */
  help: string;
  icon: ComponentType<SvgIconProps>;
}

/** The types a user can add, in the order the picker shows them. Data, so a new type is one more entry. */
export const DEST_TYPES: DestType[] = [
  { id: "discord", label: "Discord channel", help: "Post each spot to a channel through a webhook.", icon: ForumOutlinedIcon },
  { id: "webhook", label: "Webhook", help: "Send each spot as JSON to your own URL.", icon: HttpIcon },
  { id: "push", label: "Push notification", help: "Notify your phone or computer. Works in the browser, no app to install.", icon: NotificationsOutlinedIcon },
];

export function typeLabel(id: string): string {
  return DEST_TYPES.find((t) => t.id === id)?.label ?? id;
}
