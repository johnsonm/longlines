import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import App from "./App";
import { registerServiceWorker } from "./pwa/register";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);

// After load, so the worker's fetch doesn't compete with first render.
window.addEventListener("load", () => void registerServiceWorker());
