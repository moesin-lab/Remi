declare const MULTIREMI_VERSION: string | undefined;

const compiledVersion =
  typeof MULTIREMI_VERSION !== "undefined" && MULTIREMI_VERSION
    ? MULTIREMI_VERSION
    : null;
const runtimeVersion =
  typeof process !== "undefined" ? process.env.MULTIREMI_VERSION?.trim() || null : null;
const injectedVersion = compiledVersion ?? runtimeVersion;

/** Remi version, with release builds taking their value from the Git tag. */
export const VERSION = injectedVersion?.replace(/^v/, "") ?? "0.2.26";

/** Build identity shared by daemon metadata, installer verification and the platform. */
declare const MULTIREMI_BUILD_COMMIT: string | undefined;
const buildCommit = (typeof MULTIREMI_BUILD_COMMIT !== "undefined" && MULTIREMI_BUILD_COMMIT
  ? MULTIREMI_BUILD_COMMIT : process.env.MULTIREMI_BUILD_COMMIT)?.trim().toLowerCase();
export const BUILD_COMMIT: string | null = buildCommit && /^[a-f0-9]{40}$/.test(buildCommit) ? buildCommit : null;
