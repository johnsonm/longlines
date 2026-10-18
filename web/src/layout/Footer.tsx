import { Box, Divider, Link, Typography } from "@mui/material";
import GitHubIcon from "@mui/icons-material/GitHub";

export const REPO_URL = "https://github.com/sonyccd/longlines";
// Read once per load; render stays pure.
const YEAR = new Date().getFullYear();

/** The copyright line and repository link at the bottom of every frame (AppShell, PublicShell, AuthFrame). */
export function Footer() {
  return (
    <Box component="footer" sx={{ mt: 4 }}>
      <Divider />
      <Box sx={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "center", gap: 2, py: 2 }}>
        <Typography variant="body2" color="text.secondary">
          © {YEAR} Brad Bazemore
        </Typography>
        <Link
          href={REPO_URL}
          target="_blank"
          rel="noopener noreferrer"
          variant="body2"
          color="text.secondary"
          underline="hover"
          sx={{ display: "inline-flex", alignItems: "center", gap: 0.5 }}
        >
          <GitHubIcon fontSize="small" />
          GitHub
        </Link>
      </Box>
    </Box>
  );
}
