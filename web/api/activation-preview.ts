// GET /api/activation-preview?id=<id>: the Open Graph page link-preview crawlers get for an
// activation (vercel.json rewrites them here by user agent). A Vercel Function on the Node.js
// runtime with the Web-standard `fetch` export; the work is in _lib/preview.ts.

import { handlePreview } from "./_lib/preview.ts";

export default {
  fetch(request: Request): Promise<Response> {
    return handlePreview(request, process.env, fetch);
  },
};
