// GET /api/activation-image?id=<id>: the preview's 1200 by 630 PNG map. A Vercel Function on the
// Node.js runtime with the Web-standard `fetch` export; the work is in _lib/image.ts.

import { handleImage } from "./_lib/image.ts";

export default {
  fetch(request: Request): Promise<Response> {
    return handleImage(request, process.env, fetch);
  },
};
