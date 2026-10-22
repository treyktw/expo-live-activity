import type { ConfigPlugin } from "expo/config-plugins";

export type TripLiveActivityPluginOptions = {
  /** Override the extension bundle id. Default: `<ios.bundleIdentifier>.TripLiveActivity`. */
  bundleIdentifier?: string;
  /** Apple team for local signing. Default: `ios.appleTeamId` from the app config. */
  appleTeamId?: string;
};

declare const withTripLiveActivity: ConfigPlugin<TripLiveActivityPluginOptions | void> & {
  TARGET_NAME: string;
  EXTENSION_FILES: Record<string, string>;
  SOURCE_FILES: string[];
  extensionBundleIdentifier(
    config: { ios?: { bundleIdentifier?: string } },
    options?: TripLiveActivityPluginOptions,
  ): string;
  // `project` is an `xcode` package XcodeProject.
  ensureExtensionTarget(project: unknown, bundleId: string, options?: { appleTeamId?: string }): void;
  withEasAppExtension<T extends { extra?: Record<string, unknown> }>(config: T, bundleId: string): T;
};

export = withTripLiveActivity;
