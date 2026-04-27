import { redirect } from "react-router";

// The public root is the onboarding page. Everything else is a passthrough:
//   - Visitors with ?shop= are mid-install from the App Store / Shopify admin
//     and need to start the OAuth flow at /app.
//   - Everyone else (curious developers, search engines, reviewers, returning
//     merchants who bookmarked the URL) gets the onboarding guide.
export const loader = async ({ request }) => {
  const url = new URL(request.url);

  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  throw redirect("/onboarding");
};

// Loader always throws a redirect; this default export only exists so React
// Router considers the route valid. It's never rendered.
export default function Index() {
  return null;
}
