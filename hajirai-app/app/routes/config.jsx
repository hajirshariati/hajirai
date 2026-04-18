import { authenticate } from "../shopify.server";
import { getShopConfig } from "../models/ShopConfig.server";

export const loader = async ({ request }) => {
  const { session } = await authenticate.public.appProxy(request);
  if (!session) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const c = await getShopConfig(session.shop);

  const publicConfig = {
    apiUrl: c.chatServerUrl,
    assistantName: c.assistantName,
    assistantTagline: c.assistantTagline,
    greeting: c.greeting,
    greetingCta: c.greetingCta,
    avatarUrl: c.avatarUrl,
    bannerUrl: c.bannerUrl,
    showBanner: c.showBanner,
    launcherPlaceholder: c.launcherPlaceholder,
    inputPlaceholder: c.inputPlaceholder,
    launcherWidth: c.launcherWidth,
    widgetPosition: c.widgetPosition,
    colorPrimary: c.colorPrimary,
    colorAccent: c.colorAccent,
    colorCtaBg: c.colorCtaBg,
    colorCtaText: c.colorCtaText,
    colorCtaHover: c.colorCtaHover,
    cta1Label: c.cta1Label, cta1Message: c.cta1Message,
    cta2Label: c.cta2Label, cta2Message: c.cta2Message,
    cta3Label: c.cta3Label, cta3Message: c.cta3Message,
    cta4Label: c.cta4Label, cta4Message: c.cta4Message,
    quickPick1Label: c.qp1Label, quickPick1Message: c.qp1Message,
    quickPick2Label: c.qp2Label, quickPick2Message: c.qp2Message,
    quickPick3Label: c.qp3Label, quickPick3Message: c.qp3Message,
    quickPick4Label: c.qp4Label, quickPick4Message: c.qp4Message,
    ctaHint: c.ctaHint,
    disclaimerText: c.disclaimerText,
    privacyUrl: c.privacyUrl,
  };

  return Response.json(publicConfig, {
    headers: {
      "Cache-Control": "public, max-age=30",
      "Content-Type": "application/json",
    },
  });
};
