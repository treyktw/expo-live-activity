import { requireOptionalNativeModule } from "expo-modules-core";
import type { TripActivityState } from "./LiveActivity.types";

type NativeLiveActivity = {
  // Are Live Activities available + enabled (iOS 16.1+, user setting on)?
  isSupported(): boolean;
  start(state: TripActivityState): Promise<string | null>;
  update(state: TripActivityState): Promise<void>;
  end(): Promise<void>;
};

// Returns null (never throws / redboxes) when the native module is absent —
// Expo Go, simulator builds without the widget extension, or a build that
// didn't autolink the local module. Callers guard with isLiveActivityAvailable().
export const LiveActivityModule =
  requireOptionalNativeModule<NativeLiveActivity>("LiveActivityModule");
