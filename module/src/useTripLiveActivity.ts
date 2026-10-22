import { useEffect, useRef } from "react";
import {
  endTripActivity,
  isLiveActivityAvailable,
  startTripActivity,
  updateTripActivity,
} from "../index";
import type { TripActivityState } from "./LiveActivity.types";

export type TripLiveActivityToken = {
  /** Hex APNs push token for THIS activity (iOS 16.2+). */
  liveActivityPushToken: string;
  liveActivityTripId?: string;
};

// Drive the trip Live Activity / ongoing notification from the active-nav
// screen. Deterministic, pre-formatted fields only. No-ops safely when the
// native module / Widget Extension isn't present (Expo Go, pre-prebuild) —
// the in-app screen is the always-available fallback.
//
// `onPushToken` is where the token goes to your backend so it can push
// updates while the app is suspended (see server/apns-live-activity.ts).
export function useTripLiveActivity(
  active: boolean,
  state: TripActivityState | null,
  onPushToken?: (token: TripLiveActivityToken) => Promise<void> | void,
) {
  const started = useRef(false);
  const registeredToken = useRef<string | null>(null);
  const onPushTokenRef = useRef(onPushToken);
  onPushTokenRef.current = onPushToken;
  // Serialize the state so updates only fire when a field actually changes.
  const sig = state
    ? [
        state.nextStopLabel,
        state.etaText,
        state.driveRemainingText,
        state.breakText,
        state.offRoute ? "off" : "on",
      ].join("|")
    : "";

  useEffect(() => {
    if (!active || !state) return;
    if (!isLiveActivityAvailable()) return;

    if (!started.current) {
      started.current = true;
      void startTripActivity(state).then(async (token) => {
        if (!token || registeredToken.current === token) return;
        await onPushTokenRef.current?.({
          liveActivityPushToken: token,
          liveActivityTripId: state.tripId,
        });
        registeredToken.current = token;
      });
    } else {
      void updateTripActivity(state);
    }
    // `sig` stands in for `state`: re-run on content changes, not identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, sig]);

  // End when nav stops or the screen unmounts.
  useEffect(() => {
    if (active) return;
    if (started.current) {
      started.current = false;
      void endTripActivity();
    }
  }, [active]);

  useEffect(
    () => () => {
      if (started.current) {
        started.current = false;
        void endTripActivity();
      }
    },
    [],
  );
}
