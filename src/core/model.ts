import type { ExtensionContext, ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { SubagentProfile } from "../types.ts";

export function usesPiBackend(profile: SubagentProfile): boolean {
  return profile.backend === "pi";
}

export function findProfileModel(profile: SubagentProfile, modelRegistry: ModelRegistry): ExtensionContext["model"] {
  if (!usesPiBackend(profile) || !profile.model) {
    return undefined;
  }
  const separator = profile.model.indexOf("/");
  if (separator === -1) {
    return undefined;
  }
  return modelRegistry.find(profile.model.slice(0, separator), profile.model.slice(separator + 1));
}

export function resolveProfileModel(profile: SubagentProfile, ctx: ExtensionContext): ExtensionContext["model"] {
  if (!usesPiBackend(profile)) {
    return undefined;
  }
  return profile.model ? findProfileModel(profile, ctx.modelRegistry) : ctx.model;
}

export function filterProfilesForModelRegistry(
  profiles: Map<string, SubagentProfile>,
  _modelRegistry: ModelRegistry | undefined,
): Map<string, SubagentProfile> {
  return profiles;
}
