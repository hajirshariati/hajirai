import { redirect } from "react-router";

// Fit predictor merged into the Smart Recommenders page — both guided
// answers (product finder + size recommendation) live together now.
// This route survives only so old links and bookmarks keep working.
export const loader = async () => redirect("/app/recommenders");
export const action = async () => redirect("/app/recommenders");
