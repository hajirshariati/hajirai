// Enriches a logged-in customer with Klaviyo segment membership so the AI
// can tailor responses (e.g. treat a "VIP" or "High Value" segment member
// differently from a "Winback" or "Churn Risk" customer).
//
// Uses Klaviyo's v3 Private API. The private key is stored encrypted in
// ShopConfig.klaviyoPrivateKey. We NEVER send this key to the browser.

const KLAVIYO_API = "https://a.klaviyo.com/api";
const KLAVIYO_REVISION = "2024-10-15";

const CACHE = new Map();
const TTL_MS = 5 * 60 * 1000;

function cacheGet(key) {
  const e = CACHE.get(key);
  if (!e) return null;
  if (Date.now() - e.t > TTL_MS) {
    CACHE.delete(key);
    return null;
  }
  return e.v;
}

function cacheSet(key, v) {
  CACHE.set(key, { v, t: Date.now() });
}

async function klaviyoGet(path, privateKey) {
  const res = await fetch(`${KLAVIYO_API}${path}`, {
    headers: {
      Authorization: `Klaviyo-API-Key ${privateKey}`,
      revision: KLAVIYO_REVISION,
      accept: "application/json",
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Klaviyo ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

export async function fetchKlaviyoEnrichment({ privateKey, email }) {
  if (!privateKey || !email) return null;
  const cacheKey = `${privateKey.slice(0, 8)}:${email}`;
  const cached = cacheGet(cacheKey);
  if (cached !== null) return cached;

  try {
    // 1. Find the profile by email.
    const filter = encodeURIComponent(`equals(email,"${email.replace(/"/g, '\\"')}")`);
    const profileRes = await klaviyoGet(`/profiles/?filter=${filter}`, privateKey);
    const profile = profileRes?.data?.[0];
    if (!profile?.id) {
      cacheSet(cacheKey, null);
      return null;
    }

    // 2. Fetch the profile's segment memberships (names only — we don't need
    //    IDs or metadata for AI context).
    let segments = [];
    try {
      const segRes = await klaviyoGet(`/profiles/${profile.id}/segments/`, privateKey);
      segments = (segRes?.data || [])
        .map((s) => s?.attributes?.name || "")
        .filter(Boolean);
    } catch (e) {
      console.warn(`[klaviyo-enrichment] segments fetch failed: ${e.message}`);
    }

    const result = {
      segments,
      totalClicks: profile?.attributes?.properties?.total_clicks || null,
      lastOpenedEmail: profile?.attributes?.last_event_date || null,
    };
    cacheSet(cacheKey, result);
    return result;
  } catch (e) {
    console.warn(`[klaviyo-enrichment] lookup failed: ${e.message}`);
    cacheSet(cacheKey, null);
    return null;
  }
}
