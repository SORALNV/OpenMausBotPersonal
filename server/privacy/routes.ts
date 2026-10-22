import { join } from "node:path";
import { PersonalPrivacyService } from "./service.ts";
import { createPersonalPrivacyRoute } from "./personal.ts";

export { assertPrivacyMode } from "./policy.ts";
export function createPersonalPrivacyRoutes(dataDir: string, hasThread: (id: string) => boolean, run: ConstructorParameters<typeof PersonalPrivacyService>[1]) {
  const personalPrivacy = new PersonalPrivacyService(join(dataDir, "private"), run);
  personalPrivacy.start();
  return { personalPrivacy, personalPrivacyRoute: createPersonalPrivacyRoute(hasThread, { service: personalPrivacy }) };
}
