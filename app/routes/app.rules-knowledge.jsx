// Legacy route. The Rules & Knowledge page split into four focused
// pages (Catalog / Rules / Knowledge / Smart Recommenders) plus a
// few sections that moved into Settings. This file remains as a
// 301 redirect to /app/rules so existing bookmarks and direct
// links from older docs / emails don't 404.
//
// React Router v7 handles loader-side redirects with the standard
// Response constructor (no need for the redirect() helper here).
// Both loader and action redirect — `action` covers the case where
// a stale form was open in a tab when the route changed and the
// merchant clicks Save; we send them to the new page rather than
// returning 405.

import { redirect } from "react-router";

const TARGET = "/app/rules";

export const loader = () => redirect(TARGET);
export const action = () => redirect(TARGET);

export default function RulesKnowledgeRedirect() {
  return null;
}
