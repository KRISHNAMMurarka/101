// Expo config plugins are loaded synchronously as CommonJS during prebuild.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { withXcodeProject } = require('@expo/config-plugins');

const TARGET_NAME = '101LinkWatch';
const BUNDLE_ID = 'com.oneohone.link.watchkitapp';
const APP_FILES = ['One01WatchApp.swift', 'WatchSessionRelay.swift', 'MotionSource.swift'];

function addWatchApp(project) {
  const objects = project.hash.project.objects;
  const existing = Object.values(project.pbxNativeTargetSection()).some(
    (target) => target?.isa === 'PBXNativeTarget' && target.name?.replace(/^"|"$/g, '') === TARGET_NAME,
  );
  if (existing) return project;

  // Modern SwiftUI watch apps are executable application targets for the watchOS SDK.
  // The legacy watch2_app product is a stub container and cannot compile @main sources.
  const hostUuid = project.getFirstTarget().uuid;
  // Expo's initial project has no dependency sections. xcode.addTargetDependency
  // silently skips the host-to-watch edge unless both sections exist first.
  objects.PBXTargetDependency ??= {};
  objects.PBXContainerItemProxy ??= {};
  const target = project.addTarget(TARGET_NAME, 'application', TARGET_NAME, BUNDLE_ID);
  project.addBuildPhase(
    [`${TARGET_NAME}.app`], 'PBXCopyFilesBuildPhase', 'Embed Watch Content',
    hostUuid, 'watch2_app', '"$(CONTENTS_FOLDER_PATH)/Watch"',
  );
  const group = project.addPbxGroup([], TARGET_NAME);
  delete group.pbxGroup.path;
  const rootGroup = project.getPBXGroupByKey(project.getFirstProject().firstProject.mainGroup);
  rootGroup.children.push({ value: group.uuid, comment: TARGET_NAME });

  project.addBuildPhase([], 'PBXSourcesBuildPhase', 'Sources', target.uuid);
  project.addBuildPhase([], 'PBXFrameworksBuildPhase', 'Frameworks', target.uuid);
  project.addBuildPhase([], 'PBXResourcesBuildPhase', 'Resources', target.uuid);
  for (const file of APP_FILES) {
    project.addSourceFile(`../../watch-ios/App/${file}`, { target: target.uuid }, group.uuid);
  }
  const assets = project.addFile('../../watch-ios/App/Assets.xcassets', group.uuid);
  if (!assets) throw new Error('Could not add the 101 Link Watch asset catalog');
  assets.target = target.uuid;
  assets.uuid = project.generateUuid();
  project.addToPbxBuildFileSection(assets);
  project.addToPbxResourcesBuildPhase(assets);

  const packageUuid = project.generateUuid();
  const productUuid = project.generateUuid();
  const buildFileUuid = project.generateUuid();
  objects.XCLocalSwiftPackageReference ??= {};
  objects.XCSwiftPackageProductDependency ??= {};
  objects.XCLocalSwiftPackageReference[packageUuid] = {
    isa: 'XCLocalSwiftPackageReference',
    relativePath: '"../../watch-ios"',
  };
  objects.XCLocalSwiftPackageReference[`${packageUuid}_comment`] = 'One01Watch';
  objects.XCSwiftPackageProductDependency[productUuid] = {
    isa: 'XCSwiftPackageProductDependency',
    package: packageUuid,
    package_comment: 'One01Watch',
    productName: 'One01WatchCore',
  };
  objects.XCSwiftPackageProductDependency[`${productUuid}_comment`] = 'One01WatchCore';
  objects.PBXBuildFile[buildFileUuid] = {
    isa: 'PBXBuildFile',
    productRef: productUuid,
    productRef_comment: 'One01WatchCore',
  };
  objects.PBXBuildFile[`${buildFileUuid}_comment`] = 'One01WatchCore in Frameworks';
  const projectObject = project.getFirstProject().firstProject;
  projectObject.packageReferences ??= [];
  projectObject.packageReferences.push({ value: packageUuid, comment: 'One01Watch' });
  target.pbxNativeTarget.packageProductDependencies = [
    { value: productUuid, comment: 'One01WatchCore' },
  ];
  const frameworkPhase = Object.values(objects.PBXFrameworksBuildPhase).find(
    (phase) => phase?.isa === 'PBXFrameworksBuildPhase' &&
      target.pbxNativeTarget.buildPhases.some((entry) => objects.PBXFrameworksBuildPhase[entry.value] === phase),
  );
  if (!frameworkPhase) throw new Error('Could not find the 101 Link Watch frameworks phase');
  frameworkPhase.files.push({ value: buildFileUuid, comment: 'One01WatchCore in Frameworks' });

  const configurations = project.pbxXCConfigurationList()[target.pbxNativeTarget.buildConfigurationList];
  for (const entry of configurations.buildConfigurations) {
    const settings = project.pbxXCBuildConfigurationSection()[entry.value].buildSettings;
    delete settings.INFOPLIST_FILE;
    settings.ASSETCATALOG_COMPILER_APPICON_NAME = 'AppIcon';
    settings.CODE_SIGN_STYLE = 'Automatic';
    settings.GENERATE_INFOPLIST_FILE = 'YES';
    settings.INFOPLIST_KEY_CFBundleDisplayName = '"101 Link"';
    settings.INFOPLIST_KEY_WKCompanionAppBundleIdentifier = 'com.oneohone.link';
    settings.LD_RUNPATH_SEARCH_PATHS = '"$(inherited) @executable_path/Frameworks"';
    settings.SDKROOT = 'watchos';
    settings.SWIFT_VERSION = '5.0';
    settings.TARGETED_DEVICE_FAMILY = '4';
    settings.WATCHOS_DEPLOYMENT_TARGET = '10.0';
  }
  project.addTargetAttribute('ProvisioningStyle', 'Automatic', target);
  return project;
}

module.exports = (config) => withXcodeProject(config, (config) => {
  config.modResults = addWatchApp(config.modResults);
  return config;
});

module.exports.addWatchApp = addWatchApp;
