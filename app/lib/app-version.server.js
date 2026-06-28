// One-time boot version log so PRD staleness is never a guessing game. Every
// server start prints `[app-version] commit=<sha>`. Railway exposes the deployed
// commit as RAILWAY_GIT_COMMIT_SHA; fall back to other common CI/host vars, then
// to a build-time-injected APP_COMMIT, then "unknown".
const rawCommit =
  process.env.RAILWAY_GIT_COMMIT_SHA ||
  process.env.APP_COMMIT ||
  process.env.SOURCE_VERSION ||
  process.env.GIT_COMMIT ||
  process.env.COMMIT_SHA ||
  process.env.HEROKU_SLUG_COMMIT ||
  "unknown";

export const APP_COMMIT = String(rawCommit).trim().slice(0, 12) || "unknown";

let logged = false;
// Idempotent so dev HMR / repeated imports don't spam the log.
export function logAppVersion() {
  if (logged) return;
  logged = true;
  console.log(`[app-version] commit=${APP_COMMIT}`);
}

// Runs once when this module is first imported at server boot.
logAppVersion();
