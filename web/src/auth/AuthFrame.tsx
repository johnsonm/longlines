import { Container, LinearProgress, Paper, Typography } from "@mui/material";
import type { ReactNode } from "react";
import { Footer } from "../layout/Footer";

/** The centered card every signed-out screen sits in. */
export function AuthFrame({ busy, children, tabs }: { busy?: boolean; children: ReactNode; tabs?: ReactNode }) {
  return (
    <Container maxWidth="xs" sx={{ py: { xs: 4, sm: 10 } }}>
      <Typography variant="h4" align="center" gutterBottom>Long Lines</Typography>
      <Typography variant="body2" color="text.secondary" align="center" sx={{ mb: 3 }}>
        Ham radio spots, routed where you want them.
      </Typography>
      <Paper variant="outlined">
        {tabs}
        {busy && <LinearProgress />}
        {children}
      </Paper>
      <Footer />
    </Container>
  );
}
