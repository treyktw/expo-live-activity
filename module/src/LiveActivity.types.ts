// Deterministic, already-computed trip facts shown on the lock screen /
// Dynamic Island (iOS) and the ongoing notification (Android). No logic here —
// the caller passes formatted strings; this module only renders/updates them.
export type TripActivityState = {
  tripId?: string;
  nextStopLabel: string; // "Delivery — Acme, Effingham IL"
  etaText: string; // "ETA 4:12 PM"
  driveRemainingText: string; // "Drive 3h 20m"
  breakText: string; // "Break in 1h 05m" | "Break due"
  offRoute: boolean;
};
