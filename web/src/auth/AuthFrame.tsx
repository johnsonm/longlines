import { Container, LinearProgress, Link, Paper, Typography } from "@mui/material";
import type { ReactNode } from "react";
import { Link as RouterLink } from "react-router";
import { Footer } from "../layout/Footer";

/** The centered card every sign-in screen sits in. With no nav, the name leads back to the site root. */
export function AuthFrame({ busy, children, tabs }: { busy?: boolean; children: ReactNode; tabs?: ReactNode }) {
  return (
    <Container maxWidth="xs" sx={{ py: { xs: 4, sm: 10 } }}>
      <Typography variant="h4" align="center" gutterBottom>
        <Link component={RouterLink} to="/" color="inherit" underline="none">Long Lines</Link>
      </Typography>
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
