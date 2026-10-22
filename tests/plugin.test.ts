/**
 * The plugin cannot be proven by building for iOS on Linux CI, so these tests
 * prove the next best thing: run against the real Xcode project Expo SDK 54's
 * `expo prebuild` starts from (tests/fixtures/ios-template, copied verbatim
 * from expo-template-bare-minimum), and check that the generated project has
 * every piece Xcode needs to build and embed the extension — and that running
 * prebuild twice changes nothing.
 */

import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const xcode = require("xcode") as {
  project(path: string): XcodeProject;
};
const plugin = require("../plugin/withTripLiveActivity.js") as PluginModule;
const { compileModsAsync } = require("expo/config-plugins") as {
  compileModsAsync: (
    config: ExpoConfig,
    options: { projectRoot: string; platforms: string[]; assertMissingModProviders?: boolean },
  ) => Promise<ExpoConfig>;
};

type ExpoConfig = Record<string, any>;
type XcodeProject = {
  parseSync(): XcodeProject;
  writeSync(): string;
  hash: any;
  pbxNativeTargetSection(): Record<string, any>;
  pbxBuildFileSection(): Record<string, any>;
  pbxFileReferenceSection(): Record<string, any>;
};
type PluginModule = ((config: ExpoConfig, options?: Record<string, unknown>) => ExpoConfig) & {
  TARGET_NAME: string;
  EXTENSION_FILES: Record<string, string>;
  SOURCE_FILES: string[];
  extensionBundleIdentifier(config: ExpoConfig, options?: Record<string, unknown>): string;
  ensureExtensionTarget(project: XcodeProject, bundleId: string, options?: { appleTeamId?: string }): void;
  withEasAppExtension(config: ExpoConfig, bundleId: string): ExpoConfig;
};

const FIXTURE_IOS = resolve(__dirname, "fixtures/ios-template");
const PBXPROJ = "HelloWorld.xcodeproj/project.pbxproj";
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function freshProject(): XcodeProject {
  return xcode.project(join(FIXTURE_IOS, PBXPROJ)).parseSync();
}

function nativeTargets(project: XcodeProject) {
  return Object.entries(project.pbxNativeTargetSection())
    .filter(([key]) => !key.endsWith("_comment"))
    .map(([uuid, target]) => ({ uuid, target }));
}

function extensionTarget(project: XcodeProject) {
  return nativeTargets(project).find(
    ({ target }) => target.name.replace(/"/g, "") === plugin.TARGET_NAME,
  );
}

function appTarget(project: XcodeProject) {
  return nativeTargets(project).find(
    ({ target }) => target.productType.replace(/"/g, "") === "com.apple.product-type.application",
  )!;
}

function buildSettingsFor(project: XcodeProject, target: any) {
  const objects = project.hash.project.objects;
  const list = objects.XCConfigurationList[target.buildConfigurationList];
  return list.buildConfigurations.map(
    (entry: { value: string }) => objects.XCBuildConfiguration[entry.value].buildSettings,
  );
}

function embedPhases(project: XcodeProject) {
  const objects = project.hash.project.objects;
  const phases = objects.PBXCopyFilesBuildPhase ?? {};
  return (appTarget(project).target.buildPhases as Array<{ value: string }>)
    .map((entry) => phases[entry.value])
    .filter(Boolean);
}

describe("bundle identifier", () => {
  it("is derived from the app's bundle id so the embed passes validation", () => {
    expect(plugin.extensionBundleIdentifier({ ios: { bundleIdentifier: "com.acme.trucks" } })).toBe(
      "com.acme.trucks.TripLiveActivity",
    );
    expect(plugin.extensionBundleIdentifier({})).toBe("com.example.tripactivity.TripLiveActivity");
    expect(
      plugin.extensionBundleIdentifier({ ios: { bundleIdentifier: "a.b" } }, { bundleIdentifier: "x.y.z" }),
    ).toBe("x.y.z");
  });
});

describe("ensureExtensionTarget on the Expo SDK 54 template project", () => {
  const bundleId = "com.example.tripactivity.TripLiveActivity";

  it("adds a WidgetKit app-extension target with the right build settings", () => {
    const project = freshProject();
    expect(extensionTarget(project)).toBeUndefined();

    plugin.ensureExtensionTarget(project, bundleId, { appleTeamId: "ABCDE12345" });

    const ext = extensionTarget(project)!;
    expect(ext).toBeDefined();
    expect(ext.target.productType.replace(/"/g, "")).toBe("com.apple.product-type.app-extension");

    const settings = buildSettingsFor(project, ext.target);
    expect(settings).toHaveLength(2); // Debug + Release
    for (const s of settings) {
      expect(s.PRODUCT_BUNDLE_IDENTIFIER).toBe(bundleId);
      expect(s.INFOPLIST_FILE).toBe("TripLiveActivity/Info.plist");
      expect(s.GENERATE_INFOPLIST_FILE).toBe("NO");
      expect(s.IPHONEOS_DEPLOYMENT_TARGET).toBe("16.1");
      expect(s.SKIP_INSTALL).toBe("YES");
      expect(s.DEVELOPMENT_TEAM).toBe("ABCDE12345");
    }
  });

  it("compiles the three Swift files into the extension's Sources phase", () => {
    const project = freshProject();
    plugin.ensureExtensionTarget(project, bundleId);
    const objects = project.hash.project.objects;
    const ext = extensionTarget(project)!;

    const sourcesPhase = (ext.target.buildPhases as Array<{ value: string }>)
      .map((entry) => objects.PBXSourcesBuildPhase?.[entry.value])
      .find(Boolean);
    expect(sourcesPhase).toBeDefined();
    const compiled = (sourcesPhase.files as Array<{ value: string }>).map((file) => {
      const buildFile = project.pbxBuildFileSection()[file.value];
      return project.pbxFileReferenceSection()[`${buildFile.fileRef}_comment`];
    });
    expect(compiled.sort()).toEqual([...plugin.SOURCE_FILES].sort());
  });

  it("makes the app depend on and embed TripLiveActivity.appex", () => {
    const project = freshProject();
    plugin.ensureExtensionTarget(project, bundleId);
    const objects = project.hash.project.objects;
    const ext = extensionTarget(project)!;
    const app = appTarget(project);

    // Target dependency: Xcode builds the extension before the app.
    const dependsOnExtension = (app.target.dependencies as Array<{ value: string }>).some(
      (dep) => objects.PBXTargetDependency[dep.value]?.target === ext.uuid,
    );
    expect(dependsOnExtension).toBe(true);

    // Embed phase copies the .appex into PlugIns/ (dstSubfolderSpec 13).
    const phases = embedPhases(project).filter((phase) => phase.dstSubfolderSpec === 13);
    expect(phases).toHaveLength(1);
    const embedded = (phases[0].files as Array<{ value: string }>).map(
      (file) => project.pbxBuildFileSection()[file.value].fileRef,
    );
    expect(embedded).toContain(ext.target.productReference);

    const product = project.pbxFileReferenceSection()[ext.target.productReference];
    expect(product.path.replace(/"/g, "")).toBe("TripLiveActivity.appex");
    expect(product.explicitFileType.replace(/"/g, "")).toBe("wrapper.app-extension");
  });

  it("is idempotent: a second prebuild leaves exactly one target, dependency and embed", () => {
    const project = freshProject();
    plugin.ensureExtensionTarget(project, bundleId);
    const once = project.writeSync();
    plugin.ensureExtensionTarget(project, bundleId);
    plugin.ensureExtensionTarget(project, bundleId);

    expect(nativeTargets(project).filter(({ target }) => target.name.includes("TripLiveActivity"))).toHaveLength(1);
    const app = appTarget(project);
    expect(app.target.dependencies).toHaveLength(1);
    const phase = embedPhases(project).find((p) => p.dstSubfolderSpec === 13);
    expect(phase.files).toHaveLength(1);
    expect(project.writeSync()).toBe(once);
  });

  it("round-trips: the written pbxproj re-parses with the extension intact", () => {
    const project = freshProject();
    plugin.ensureExtensionTarget(project, bundleId);
    const dir = mkdtempSync(join(tmpdir(), "tla-pbx-"));
    tempDirs.push(dir);
    const out = join(dir, "project.pbxproj");
    require("node:fs").writeFileSync(out, project.writeSync());
    const reparsed = xcode.project(out).parseSync();
    expect(extensionTarget(reparsed)).toBeDefined();
  });
});

describe("generated Swift", () => {
  it("keeps the extension's ContentState identical to the native module's", () => {
    // ActivityKit matches attributes by type name and Codable shape. If the
    // extension and the module disagree, Activity.request succeeds but the
    // widget never renders — the worst kind of failure to debug on device.
    const block = (source: string) =>
      /struct TripActivityAttributes: ActivityAttributes \{[\s\S]*?\n\s*var tripId: String\n\}/
        .exec(source)?.[0]
        .replace(/\s+/g, " ");
    const generated = block(plugin.EXTENSION_FILES["TripActivityAttributes.swift"]);
    const moduleSource = readFileSync(resolve(__dirname, "../module/ios/LiveActivityModule.swift"), "utf8");
    expect(generated).toBeTruthy();
    expect(block(moduleSource)).toBe(generated);
  });

  it("matches the content-state keys the server pushes", async () => {
    const { liveActivityContentState } = await import("../server/apns-live-activity");
    const state = liveActivityContentState({ title: "t", body: "b" });
    const swift = plugin.EXTENSION_FILES["TripActivityAttributes.swift"];
    const swiftKeys = [...swift.matchAll(/var (\w+): (?:String|Bool)/g)]
      .map((m) => m[1])
      .filter((key) => key !== "tripId");
    expect(Object.keys(state).sort()).toEqual(swiftKeys.sort());
  });
});

describe("full plugin through Expo's mod compiler", () => {
  it("writes the extension sources, Info.plist flag, Xcode target and EAS entry", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "tla-prebuild-"));
    tempDirs.push(projectRoot);
    cpSync(FIXTURE_IOS, join(projectRoot, "ios"), { recursive: true });

    const baseConfig: ExpoConfig = {
      name: "HelloWorld",
      slug: "hello-world",
      ios: { bundleIdentifier: "com.example.tripactivity" },
      _internal: { projectRoot },
    };
    const withPlugin = plugin(baseConfig);

    // EAS sees the extension before it reads the Xcode project.
    expect(withPlugin.extra.eas.build.experimental.ios.appExtensions).toEqual([
      { targetName: "TripLiveActivity", bundleIdentifier: "com.example.tripactivity.TripLiveActivity" },
    ]);

    await compileModsAsync(withPlugin, {
      projectRoot,
      platforms: ["ios"],
      assertMissingModProviders: false,
    });

    for (const file of Object.keys(plugin.EXTENSION_FILES)) {
      expect(existsSync(join(projectRoot, "ios/TripLiveActivity", file))).toBe(true);
    }
    const infoPlist = readFileSync(join(projectRoot, "ios/HelloWorld/Info.plist"), "utf8");
    expect(infoPlist).toMatch(/<key>NSSupportsLiveActivities<\/key>\s*<true\/>/);

    const project = xcode.project(join(projectRoot, "ios", PBXPROJ)).parseSync();
    expect(extensionTarget(project)).toBeDefined();
  });

  it("does not duplicate the EAS extension entry when applied twice", () => {
    const once = plugin.withEasAppExtension({ ios: { bundleIdentifier: "a.b" } }, "a.b.TripLiveActivity");
    const twice = plugin.withEasAppExtension(once, "a.b.TripLiveActivity");
    expect(twice.extra.eas.build.experimental.ios.appExtensions).toHaveLength(1);
  });
});
