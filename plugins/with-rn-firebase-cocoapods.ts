import { CodeGenerator, type ConfigPlugin, withPodfile } from "expo/config-plugins";

const withRNFirebaseCocoaPods: ConfigPlugin = (config) =>
  withPodfile(config, (podfileConfig) => {
    podfileConfig.modResults.contents = CodeGenerator.mergeContents({
      tag: "rn-firebase-cocoapods",
      src: podfileConfig.modResults.contents,
      newSrc: [
        "# Firebase SPM products are dynamic-only and cannot be linked into this app's static frameworks.",
        "$RNFirebaseDisableSPM = true",
      ].join("\n"),
      anchor: /prepare_react_native_project!/,
      offset: 1,
      comment: "#",
    }).contents;
    return podfileConfig;
  });

export default withRNFirebaseCocoaPods;
