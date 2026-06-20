// The app is free and every feature is unlocked, so plan gating no longer
// applies. PlanGate is kept as a pass-through wrapper (callers still wrap
// feature sections in <PlanGate ...>) and simply renders its children. The
// extra props (plan, feature, summary) are accepted and ignored.
export function PlanGate({ children }) {
  return children;
}
