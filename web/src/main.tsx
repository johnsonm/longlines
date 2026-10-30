import "./instrument";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import App from "./App";
import { rootErrorHandlers } from "./lib/sentry";
import { captureInstallPrompt } from "./pwa/install";
import { registerServiceWorker } from "./pwa/register";

// Before render: Chrome fires beforeinstallprompt once, early, and never again.
captureInstallPrompt();

createRoot(document.getElementById("root")!, rootErrorHandlers()).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);

// After load, so the worker's fetch doesn't compete with first render.
window.addEventListener("load", () => void registerServiceWorker());
