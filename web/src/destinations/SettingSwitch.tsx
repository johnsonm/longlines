import { Box, Stack, Switch, Typography } from "@mui/material";

interface Props {
  label: string;
  help: string;
  checked: boolean;
  onChange: (on: boolean) => void;
}

/** A switch with its sentence under the label; the switch is named by the label alone. */
export function SettingSwitch({ label, help, checked, onChange }: Props) {
  return (
    <Stack direction="row" spacing={2} sx={{ justifyContent: "space-between", alignItems: "center" }}>
      <Box>
        <Typography>{label}</Typography>
        <Typography variant="body2" color="text.secondary">{help}</Typography>
      </Box>
      <Switch checked={checked} onChange={(e) => onChange(e.target.checked)} slotProps={{ input: { "aria-label": label } }} />
    </Stack>
  );
}
