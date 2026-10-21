// Only the sealed launcher sets this value, after verifying the runtime signature.
export const runtimeResourcesPath = globalThis[Symbol.for("omb.verifiedRuntimeResources")] ?? process.resourcesPath;
