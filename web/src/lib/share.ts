// Share a page's link: the browser's share sheet where there is one, else the
// clipboard. Closing the sheet is not a failure; any other refusal (a
// permissions policy, lost user activation) falls back to copying the link.

export async function shareLink(
  { title, url, copied, notify }: { title: string; url: string; copied: string; notify: (message: string) => void },
): Promise<void> {
  if (typeof navigator.share === "function") {
    try {
      await navigator.share({ title, url });
      return;
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    notify(copied);
  } catch {
    notify("Couldn't copy the link.");
  }
}
