/** Private settings: these rules belong on the owner's Mac, never in model config, prompts, telemetry, or client snapshots. */
export interface PrivacyAlias { replacement: string; variants: string[]; restoreAs?: string }
export const PRIVACY_SOURCES = ["custom", "browser", "composio", "data"] as const;
export type PrivacySource = typeof PRIVACY_SOURCES[number];
export interface PersonalPrivacySettings {
  enabled: boolean;
  allRoutines: boolean;
  routineIds: string[];
  sources: PrivacySource[];
  aliases: PrivacyAlias[];
  toolFiltering?: boolean;
}
export const DEFAULT_PERSONAL_PRIVACY: PersonalPrivacySettings = {
  enabled: false, allRoutines: true, routineIds: [], sources: ["custom", "browser", "composio", "data"], aliases: [], toolFiltering: false,
};
