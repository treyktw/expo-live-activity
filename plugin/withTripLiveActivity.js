const { existsSync, mkdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const {
  withDangerousMod,
  withInfoPlist,
  withXcodeProject,
} = require("expo/config-plugins");

const TARGET_NAME = "TripLiveActivity";
// Used only when the app config has no ios.bundleIdentifier (e.g. in tests).
const FALLBACK_APP_BUNDLE_ID = "com.example.tripactivity";
const DEPLOYMENT_TARGET = "16.1";
const SOURCE_FILES = [
  "TripActivityAttributes.swift",
  "TripLiveActivityBundle.swift",
  "TripLiveActivityWidget.swift",
];

// The extension's bundle id must be prefixed by the app's, or App Store
// validation rejects the embed. Derived from the app config so the plugin
// carries no product identifiers of its own.
function extensionBundleIdentifier(config, options = {}) {
  if (options.bundleIdentifier) return options.bundleIdentifier;
  const appBundleId = config.ios?.bundleIdentifier ?? FALLBACK_APP_BUNDLE_ID;
  return `${appBundleId}.${TARGET_NAME}`;
}
const EXTENSION_FILES = {
  "Info.plist": `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>CFBundleDevelopmentRegion</key>
\t<string>$(DEVELOPMENT_LANGUAGE)</string>
\t<key>CFBundleDisplayName</key>
\t<string>Trip Live Activity</string>
\t<key>CFBundleExecutable</key>
\t<string>$(EXECUTABLE_NAME)</string>
\t<key>CFBundleIdentifier</key>
\t<string>$(PRODUCT_BUNDLE_IDENTIFIER)</string>
\t<key>CFBundleInfoDictionaryVersion</key>
\t<string>6.0</string>
\t<key>CFBundleName</key>
\t<string>$(PRODUCT_NAME)</string>
\t<key>CFBundlePackageType</key>
\t<string>$(PRODUCT_BUNDLE_PACKAGE_TYPE)</string>
\t<key>CFBundleShortVersionString</key>
\t<string>$(MARKETING_VERSION)</string>
\t<key>CFBundleVersion</key>
\t<string>$(CURRENT_PROJECT_VERSION)</string>
\t<key>NSExtension</key>
\t<dict>
\t\t<key>NSExtensionPointIdentifier</key>
\t\t<string>com.apple.widgetkit-extension</string>
\t</dict>
</dict>
</plist>
`,
  "TripActivityAttributes.swift": `import ActivityKit
import Foundation

struct TripActivityAttributes: ActivityAttributes {
  public struct ContentState: Codable, Hashable {
    var nextStopLabel: String
    var etaText: String
    var driveRemainingText: String
    var breakText: String
    var offRoute: Bool
  }

  var tripId: String
}
`,
  "TripLiveActivityBundle.swift": `import SwiftUI
import WidgetKit

@main
struct TripLiveActivityBundle: WidgetBundle {
  var body: some Widget {
    TripLiveActivityWidget()
  }
}
`,
  "TripLiveActivityWidget.swift": `import ActivityKit
import SwiftUI
import WidgetKit

struct TripLiveActivityWidget: Widget {
  var body: some WidgetConfiguration {
    ActivityConfiguration(for: TripActivityAttributes.self) { context in
      LockScreenTripView(state: context.state)
        .activityBackgroundTint(Color(red: 0.08, green: 0.08, blue: 0.07))
        .activitySystemActionForegroundColor(.white)
    } dynamicIsland: { context in
      DynamicIsland {
        DynamicIslandExpandedRegion(.leading) {
          VStack(alignment: .leading, spacing: 2) {
            Text(context.state.offRoute ? "Off route" : "Next stop")
              .font(.caption2)
              .foregroundStyle(.secondary)
            Text(context.state.nextStopLabel)
              .font(.caption)
              .lineLimit(2)
          }
        }
        DynamicIslandExpandedRegion(.trailing) {
          VStack(alignment: .trailing, spacing: 2) {
            Text(context.state.etaText)
              .font(.caption)
              .fontWeight(.semibold)
            Text(context.state.driveRemainingText)
              .font(.caption2)
              .foregroundStyle(.secondary)
          }
        }
        DynamicIslandExpandedRegion(.bottom) {
          HStack {
            Label(context.state.breakText, systemImage: "clock")
              .font(.caption)
              .lineLimit(1)
            Spacer()
            if context.state.offRoute {
              Label("Check route", systemImage: "exclamationmark.triangle.fill")
                .font(.caption)
                .foregroundStyle(.orange)
            }
          }
        }
      } compactLeading: {
        Image(systemName: context.state.offRoute ? "exclamationmark.triangle.fill" : "truck.box")
          .foregroundStyle(context.state.offRoute ? .orange : .green)
      } compactTrailing: {
        Text(context.state.etaText.replacingOccurrences(of: "ETA ", with: ""))
          .font(.caption2)
          .minimumScaleFactor(0.75)
      } minimal: {
        Image(systemName: context.state.offRoute ? "exclamationmark.triangle.fill" : "truck.box")
          .foregroundStyle(context.state.offRoute ? .orange : .green)
      }
    }
  }
}

private struct LockScreenTripView: View {
  let state: TripActivityAttributes.ContentState

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(alignment: .top) {
        VStack(alignment: .leading, spacing: 3) {
          Text(state.offRoute ? "Off route" : "Active trip")
            .font(.caption)
            .foregroundStyle(state.offRoute ? .orange : .secondary)
          Text(state.nextStopLabel)
            .font(.headline)
            .lineLimit(2)
        }
        Spacer()
        Text(state.etaText)
          .font(.subheadline)
          .fontWeight(.semibold)
      }

      HStack(spacing: 10) {
        LivePill(systemImage: "steeringwheel", text: state.driveRemainingText)
        LivePill(systemImage: "clock", text: state.breakText)
      }
    }
    .padding(16)
    .foregroundStyle(.white)
  }
}

private struct LivePill: View {
  let systemImage: String
  let text: String

  var body: some View {
    Label(text, systemImage: systemImage)
      .font(.caption)
      .lineLimit(1)
      .padding(.horizontal, 10)
      .padding(.vertical, 6)
      .background(.white.opacity(0.12), in: Capsule())
  }
}
`,
};

function findNativeTarget(project, name) {
  const targets = project.pbxNativeTargetSection();
  return Object.entries(targets).find(([key, target]) => {
    return !key.endsWith("_comment") && target.name?.replace(/"/g, "") === name;
  });
}

function findAppTarget(project) {
  const targets = project.pbxNativeTargetSection();
  return Object.entries(targets).find(([key, target]) => {
    return (
      !key.endsWith("_comment") &&
      target.productType?.replace(/"/g, "") === "com.apple.product-type.application"
    );
  });
}

function getBuildConfigs(project, target) {
  const listId = target.buildConfigurationList;
  const list = project.hash.project.objects.XCConfigurationList[listId];
  const configs = project.hash.project.objects.XCBuildConfiguration;
  return list.buildConfigurations.map((entry) => configs[entry.value]);
}

function ensureTargetBuildSettings(project, target, bundleId, options = {}) {
  for (const config of getBuildConfigs(project, target)) {
    config.buildSettings.CLANG_ENABLE_OBJC_WEAK = "NO";
    config.buildSettings.CURRENT_PROJECT_VERSION = 1;
    config.buildSettings.GENERATE_INFOPLIST_FILE = "NO";
    config.buildSettings.INFOPLIST_FILE = `${TARGET_NAME}/Info.plist`;
    config.buildSettings.IPHONEOS_DEPLOYMENT_TARGET = DEPLOYMENT_TARGET;
    config.buildSettings.MARKETING_VERSION = "1.0.0";
    config.buildSettings.PRODUCT_BUNDLE_IDENTIFIER = bundleId;
    config.buildSettings.PRODUCT_NAME = '"$(TARGET_NAME)"';
    config.buildSettings.SDKROOT = "iphoneos";
    config.buildSettings.SKIP_INSTALL = "YES";
    config.buildSettings.SWIFT_VERSION = 5.0;
    config.buildSettings.TARGETED_DEVICE_FAMILY = '"1,2"';
    // Signing team: inherit the app's when the config names one, so a local
    // `expo run:ios` signs the extension without opening Xcode. EAS Build
    // manages this itself via extra.eas.build.experimental.ios.appExtensions.
    if (options.appleTeamId) {
      config.buildSettings.DEVELOPMENT_TEAM = options.appleTeamId;
    }
  }
}

function ensureProductReference(project, target) {
  const productRef = target.productReference;
  const productFiles = project.pbxFileReferenceSection();
  const file = productFiles[productRef];
  if (!file) return;

  file.explicitFileType = '"wrapper.app-extension"';
  file.includeInIndex = 0;
  file.path = `${TARGET_NAME}.appex`;
  file.sourceTree = "BUILT_PRODUCTS_DIR";
  productFiles[`${productRef}_comment`] = `${TARGET_NAME}.appex`;
}

function ensureAppTargetDependency(project, appTargetUuid, extensionTargetUuid) {
  const appTarget = project.pbxNativeTargetSection()[appTargetUuid];
  const dependencies = appTarget.dependencies ?? [];
  const hasDependency = dependencies.some((dependency) => {
    const dependencyEntry =
      project.hash.project.objects.PBXTargetDependency?.[dependency.value];
    return dependencyEntry?.target === extensionTargetUuid;
  });

  if (!hasDependency) {
    // `xcode` silently skips the dependency when these sections don't exist
    // yet — and a fresh single-target Expo project has neither. Without them
    // the app only builds the extension via Xcode's implicit-dependency guess.
    const objects = project.hash.project.objects;
    objects.PBXTargetDependency = objects.PBXTargetDependency ?? {};
    objects.PBXContainerItemProxy = objects.PBXContainerItemProxy ?? {};
    project.addTargetDependency(appTargetUuid, [extensionTargetUuid]);
  }
}

function findEmbedExtensionsPhase(project, appTarget) {
  const phases = project.hash.project.objects.PBXCopyFilesBuildPhase ?? {};
  for (const entry of appTarget.buildPhases ?? []) {
    const phase = phases[entry.value];
    if (
      phase &&
      (phase.name?.replace(/"/g, "") === "Embed App Extensions" ||
        phase.dstSubfolderSpec === 13)
    ) {
      return phase;
    }
  }

  return null;
}

function ensureEmbeddedExtension(project, appTargetUuid, extensionTarget) {
  const appTarget = project.pbxNativeTargetSection()[appTargetUuid];
  let embedPhase = findEmbedExtensionsPhase(project, appTarget);

  if (!embedPhase) {
    project.addBuildPhase(
      [],
      "PBXCopyFilesBuildPhase",
      "Embed App Extensions",
      appTargetUuid,
      "app_extension",
    );
    embedPhase = findEmbedExtensionsPhase(project, appTarget);
  }

  if (!embedPhase) return;

  const productRef = extensionTarget.productReference;
  const hasProduct = (embedPhase.files ?? []).some((file) => {
    const buildFile = project.pbxBuildFileSection()[file.value];
    return buildFile?.fileRef === productRef;
  });

  if (hasProduct) return;

  const buildFileUuid = project.generateUuid();
  project.pbxBuildFileSection()[buildFileUuid] = {
    isa: "PBXBuildFile",
    fileRef: productRef,
    fileRef_comment: `${TARGET_NAME}.appex`,
    settings: { ATTRIBUTES: ["RemoveHeadersOnCopy"] },
  };
  project.pbxBuildFileSection()[`${buildFileUuid}_comment`] =
    `${TARGET_NAME}.appex in Embed App Extensions`;

  embedPhase.files = embedPhase.files ?? [];
  embedPhase.files.push({
    value: buildFileUuid,
    comment: `${TARGET_NAME}.appex in Embed App Extensions`,
  });
}

function ensureAppEmbedsExtension(project, extensionTargetUuid, extensionTarget) {
  ensureProductReference(project, extensionTarget);

  const appTarget = findAppTarget(project);
  if (!appTarget) return;

  ensureAppTargetDependency(project, appTarget[0], extensionTargetUuid);
  ensureEmbeddedExtension(project, appTarget[0], extensionTarget);
}

function ensureExtensionTarget(project, bundleId, options = {}) {
  const existing = findNativeTarget(project, TARGET_NAME);
  if (existing) {
    ensureTargetBuildSettings(project, existing[1], bundleId, options);
    ensureAppEmbedsExtension(project, existing[0], existing[1]);
    return;
  }

  const target = project.addTarget(TARGET_NAME, "app_extension", TARGET_NAME, bundleId);
  project.addBuildPhase([], "PBXSourcesBuildPhase", "Sources", target.uuid);
  project.addBuildPhase([], "PBXFrameworksBuildPhase", "Frameworks", target.uuid);
  project.addBuildPhase([], "PBXResourcesBuildPhase", "Resources", target.uuid);

  const group = project.pbxCreateGroup(TARGET_NAME, TARGET_NAME);
  const mainGroup = project.getFirstProject().firstProject.mainGroup;
  project.addToPbxGroup(group, mainGroup);

  for (const file of SOURCE_FILES) {
    project.addSourceFile(file, { target: target.uuid }, group);
  }

  ensureTargetBuildSettings(project, target.pbxNativeTarget, bundleId, options);
  ensureAppEmbedsExtension(project, target.uuid, target.pbxNativeTarget);
}

// EAS Build provisions one profile per target and needs to know the extension
// exists before it reads the Xcode project. Declaring it here keeps the whole
// setup inside the plugin instead of in every app's app.config.
function withEasAppExtension(config, bundleId) {
  const extra = config.extra ?? {};
  const eas = extra.eas ?? {};
  const build = eas.build ?? {};
  const experimental = build.experimental ?? {};
  const ios = experimental.ios ?? {};
  const appExtensions = (ios.appExtensions ?? []).filter(
    (extension) => extension.targetName !== TARGET_NAME,
  );
  appExtensions.push({ targetName: TARGET_NAME, bundleIdentifier: bundleId });

  return {
    ...config,
    extra: {
      ...extra,
      eas: {
        ...eas,
        build: {
          ...build,
          experimental: { ...experimental, ios: { ...ios, appExtensions } },
        },
      },
    },
  };
}

function withTripLiveActivity(config, options = {}) {
  const bundleId = extensionBundleIdentifier(config, options);
  const appleTeamId = options.appleTeamId ?? config.ios?.appleTeamId;

  config = withEasAppExtension(config, bundleId);

  // ActivityKit refuses Activity.request() unless the host app opts in.
  config = withInfoPlist(config, (cfg) => {
    cfg.modResults.NSSupportsLiveActivities = true;
    return cfg;
  });

  config = withDangerousMod(config, [
    "ios",
    (cfg) => {
      const extensionDir = join(cfg.modRequest.platformProjectRoot, TARGET_NAME);
      if (!existsSync(extensionDir)) {
        mkdirSync(extensionDir, { recursive: true });
      }

      for (const [fileName, contents] of Object.entries(EXTENSION_FILES)) {
        writeFileSync(join(extensionDir, fileName), contents);
      }

      return cfg;
    },
  ]);

  return withXcodeProject(config, (cfg) => {
    ensureExtensionTarget(cfg.modResults, bundleId, { appleTeamId });
    return cfg;
  });
}

module.exports = withTripLiveActivity;
// Internals, exported for tests and for apps that want to inspect the output.
module.exports.TARGET_NAME = TARGET_NAME;
module.exports.EXTENSION_FILES = EXTENSION_FILES;
module.exports.SOURCE_FILES = SOURCE_FILES;
module.exports.extensionBundleIdentifier = extensionBundleIdentifier;
module.exports.ensureExtensionTarget = ensureExtensionTarget;
module.exports.withEasAppExtension = withEasAppExtension;
