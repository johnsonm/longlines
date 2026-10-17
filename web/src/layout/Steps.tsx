import { Avatar, List, ListItem, ListItemAvatar, ListItemText } from "@mui/material";

export interface Step {
  title: string;
  text?: string;
}

/** Numbered steps, as the Add a device and Install dialogs draw them. */
export function Steps({ steps }: { steps: Step[] }) {
  return (
    <List disablePadding>
      {steps.map((s, i) => (
        <ListItem key={s.title} disableGutters sx={{ alignItems: "flex-start" }}>
          <ListItemAvatar>
            <Avatar>{i + 1}</Avatar>
          </ListItemAvatar>
          <ListItemText primary={s.title} secondary={s.text} />
        </ListItem>
      ))}
    </List>
  );
}
