// The model sometimes emits markdown links whose anchor text IS the URL
// (e.g. "[aetrex.com/pages/aetrex-and-govx](https://aetrex.com/pages/...)"),
// which renders as an unfriendly button like "aetrex.com/pages/aetrex-and-govx →".
// This helper detects URL-like labels and derives a friendly label from the URL path.

const LOOKS_LIKE_URL = /^(?:https?:\/\/|www\.|\/|[\w-]+(?:\.[\w-]+)+(?:\/|$))/i;

const PATH_HINTS = [
  { re: /\b(teachers?|educators?|students?|schools?|govx|military|veterans?|first.?responders?|medical|nurses?|healthcare)\b/i, label: "Verify Eligibility" },
  { re: /\b(returns?|refunds?|exchanges?)\b/i, label: "Start Your Return" },
  { re: /\b(track(ing)?|shipments?|deliver(y|ies))\b/i, label: "Track Your Order" },
  { re: /\b(contact|support|help(-?center)?|customer-?service)\b/i, label: "Contact Support" },
  { re: /\b(size-?guides?|sizing|fit(-?guides?)?)\b/i, label: "Size Guide" },
  { re: /\b(faqs?|questions)\b/i, label: "Read FAQs" },
  { re: /\b(rewards?|loyalty|points|vip)\b/i, label: "See Rewards" },
  { re: /\b(refer(rals?)?|invite)\b/i, label: "Share & Earn" },
  { re: /\b(sale|clearance|deals|discounts?|promo)\b/i, label: "Shop the Sale" },
  { re: /\b(new(-?arrivals|-?in)?|latest)\b/i, label: "Shop New Arrivals" },
  { re: /\b(about|story|mission)\b/i, label: "Learn More" },
  { re: /\/collections\//i, label: "Browse Collection" },
  { re: /\/products\//i, label: "View Product" },
  { re: /\/blogs?\//i, label: "Read More" },
];

function humanize(slug) {
  const words = String(slug || "")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
  if (words.length === 0) return "";
  return words.map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
}

function deriveFromPath(url) {
  try {
    const u = new URL(/^https?:\/\//i.test(url) ? url : `https://${url.replace(/^\/+/, "")}`);
    const full = `${u.hostname}${u.pathname}${u.search}`;
    for (const hint of PATH_HINTS) {
      if (hint.re.test(full)) return hint.label;
    }
    const segments = u.pathname.split("/").filter(Boolean);
    const last = segments[segments.length - 1] || segments[segments.length - 2] || "";
    if (/^collections$/i.test(segments[segments.length - 2] || "")) {
      const name = humanize(last);
      if (name) return `Shop ${name}`;
    }
    if (/^products$/i.test(segments[segments.length - 2] || "")) {
      const name = humanize(last);
      if (name) return `View ${name}`;
    }
    if (last && !/^https?:$/.test(last)) {
      const h = humanize(last);
      if (h && h.length <= 40) return h;
    }
  } catch {
    // fall through
  }
  return "";
}

function looksLikeUrl(label) {
  const trimmed = String(label || "").trim();
  if (!trimmed) return true;
  if (LOOKS_LIKE_URL.test(trimmed)) return true;
  if (/^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(trimmed)) return true;
  return false;
}

function stripMarkdownFormatting(s) {
  return String(s || "")
    .replace(/[*_~`]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function sanitizeCtaLabel(label, url, fallback = "Learn More") {
  const stripped = stripMarkdownFormatting(label);
  if (!looksLikeUrl(stripped)) return stripped;
  const derived = deriveFromPath(url || stripped);
  return derived || fallback;
}
