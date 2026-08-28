/// <reference types="@cloudflare/workers-types" />

// Cloudflare Pages Function for /view/:id.
//
// A SPA can't give link-preview crawlers (iMessage, Slack, Facebook, X, …)
// per-event Open Graph tags, because those crawlers don't run JavaScript — they
// read the static HTML. This edge function intercepts /view/:id, and *for
// crawlers only* fetches the event from the public backend and injects og:/
// twitter: meta tags into the shell before returning it. Humans get the
// untouched SPA (which then boots and sets the tab title client-side).
//
// It runs only on /view/* — the rest of the app is served straight from the
// CDN — and skips the backend fetch entirely for non-bot requests.

interface Env {
  // Backend origin for the public get-event lookup. Set per-environment in the
  // Pages project (or .dev.vars locally); falls back to the deployed Worker.
  BACKEND_URL?: string;
}

const DEFAULT_BACKEND = "https://do-sockets-backend.trebdev.workers.dev";

// Known link-preview / crawler user agents. Matching is intentionally broad;
// a miss just means that client gets the default tags, never a broken page.
const CRAWLER_UA =
  /bot|crawler|spider|facebookexternalhit|slackbot|twitterbot|whatsapp|telegrambot|discordbot|linkedinbot|embedly|quora link preview|redditbot|applebot|pinterest|vkshare|bingpreview|skypeuripreview|google-inspectiontool/i;

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

interface EventMetadata {
  name?: string;
  description?: string;
  location?: string;
  date?: string;
  time?: string;
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const { request, params, env, next } = context;

  // Always start from the SPA shell that would otherwise be served for this
  // route (index.html via the SPA fallback). Nothing is prebuilt.
  const response = await next();

  const ua = request.headers.get("user-agent") ?? "";
  const contentType = response.headers.get("content-type") ?? "";
  // Only rewrite HTML, and only for crawlers — humans get the SPA as-is.
  if (!CRAWLER_UA.test(ua) || !contentType.includes("text/html")) {
    return response;
  }

  const id = String(params.id);
  const base = (env.BACKEND_URL || DEFAULT_BACKEND).replace(/\/+$/, "");

  let title = "Rotation";
  let description = "Padel socials where players rotate partners.";
  try {
    const res = await fetch(
      `${base}/get-event?id=${encodeURIComponent(id)}`,
      // Bots don't carry the owner token; this is the public view.
      { headers: { accept: "application/json" } },
    );
    if (res.ok) {
      const record = (await res.json()) as { data?: { metadata?: EventMetadata } };
      const meta = record.data?.metadata;
      if (meta?.name?.trim()) title = `Rotation: ${meta.name.trim()}`;
      const bits = [meta?.date, meta?.time, meta?.location]
        .map((b) => b?.trim())
        .filter((b): b is string => !!b);
      if (bits.length) description = bits.join(" · ");
    }
  } catch {
    // Network/parse failure → serve the shell with the default tags.
  }

  const tags =
    `<meta property="og:type" content="website">` +
    `<meta property="og:site_name" content="Rotation">` +
    `<meta property="og:title" content="${escapeAttr(title)}">` +
    `<meta property="og:description" content="${escapeAttr(description)}">` +
    `<meta property="og:url" content="${escapeAttr(request.url)}">` +
    `<meta name="twitter:card" content="summary">` +
    `<meta name="twitter:title" content="${escapeAttr(title)}">` +
    `<meta name="twitter:description" content="${escapeAttr(description)}">`;

  return new HTMLRewriter()
    .on("title", {
      element(el) {
        el.setInnerContent(title);
      },
    })
    .on("head", {
      element(el) {
        el.append(tags, { html: true });
      },
    })
    .transform(response);
};
