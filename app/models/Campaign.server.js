import prisma from "../db.server";

// What the chat assistant reads on every turn.
// `now` parameter exists so callers can pass a stable timestamp during
// a single request (avoids a campaign starting/ending mid-stream).
export async function getActiveCampaigns(shop, now = new Date()) {
  if (!shop) return [];
  return prisma.campaign.findMany({
    where: {
      shop,
      startsAt: { lte: now },
      endsAt: { gte: now },
    },
    orderBy: { startsAt: "asc" },
    select: { id: true, name: true, content: true, startsAt: true, endsAt: true },
  });
}

export async function listCampaigns(shop) {
  if (!shop) return [];
  return prisma.campaign.findMany({
    where: { shop },
    orderBy: [{ startsAt: "desc" }, { createdAt: "desc" }],
    select: { id: true, name: true, content: true, startsAt: true, endsAt: true, createdAt: true, updatedAt: true },
  });
}

export async function saveCampaign(shop, { id, name, content, startsAt, endsAt }) {
  if (!shop) throw new Error("shop required");
  const data = {
    name: String(name || "").trim().slice(0, 200),
    content: String(content || "").trim().slice(0, 20000),
    startsAt: new Date(startsAt),
    endsAt: new Date(endsAt),
  };
  if (!data.name || !data.content) throw new Error("name and content required");
  if (!(data.startsAt instanceof Date) || isNaN(+data.startsAt)) throw new Error("invalid startsAt");
  if (!(data.endsAt instanceof Date) || isNaN(+data.endsAt)) throw new Error("invalid endsAt");
  if (+data.endsAt <= +data.startsAt) throw new Error("endsAt must be after startsAt");

  if (id) {
    return prisma.campaign.update({ where: { id }, data });
  }
  return prisma.campaign.create({ data: { ...data, shop } });
}

export async function deleteCampaign(shop, id) {
  if (!shop || !id) return;
  await prisma.campaign.deleteMany({ where: { id, shop } });
}

// Plain-text template the merchant can copy/paste into the content
// field as a starting structure. Covers the most common sale types
// (% off, BOGO, free shipping, free gift) without being so prescriptive
// the AI parrots it back verbatim.
export const CAMPAIGN_TEMPLATE = `# [Campaign name, e.g. Summer Sale 2026]

## What's on sale
- [Eligible products or categories — e.g. all women's boots, all orthotics, sitewide except gift cards]
- [Any explicit exclusions — e.g. excludes already-discounted items, sale items, gift cards]

## How the discount works
- [Mechanic — e.g. 20% off automatically at checkout / Buy 2 Get 1 Free / Free shipping over $75]
- [Code, if any — e.g. SUMMER20]
- [Stacking rules — e.g. cannot be combined with other codes]
- [Limit — e.g. one use per customer]

## Dates
- Starts: [date and time, with time zone]
- Ends: [date and time, with time zone]

## Returns and exchanges
- [Same as standard policy / sale items final sale / etc.]

## Anything else customers ask about
- [Free gift threshold, BOGO mechanic details, gift wrap, expedited shipping cutoffs, etc.]
`;
