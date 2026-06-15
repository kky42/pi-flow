import type { ExtensionContext, ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { SubagentProfile } from "../types.ts";

export function findProfileModel(profile: SubagentProfile, modelRegistry: ModelRegistry): ExtensionContext["model"] {
  if (!profile.model) {
    return undefined;
  }
  const separator = profile.model.indexOf("/");
  if (separator === -1) {
    return undefined;
  }
  return modelRegistry.find(profile.model.slice(0, separator), profile.model.slice(separator + 1));
}

export function resolveProfileModel(profile: SubagentProfile, ctx: ExtensionContext): ExtensionContext["model"] {
  return profile.model ? findProfileModel(profile, ctx.modelRegistry) : ctx.model;
}

export function filterProfilesForModelRegistry(
  profiles: Map<string, SubagentProfile>,
  modelRegistry: ModelRegistry | undefined,
): Map<string, SubagentProfile> {
  if (!modelRegistry) {
    return profiles;
  }
  return new Map(
    [...profiles].filter(([, profile]) => !profile.model || Boolean(findProfileModel(profile, modelRegistry))),
  );
}
