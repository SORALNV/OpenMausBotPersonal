import { useEffect, useState } from "react";
import { useStore, type ConfigStatus } from "@/state/store";
import { t } from "@/lib/i18n";
import { AboutMeSettings } from "./AboutMeSettings";

export function ProfileFields() {
  const { state, dispatch } = useStore();
  const [name, setName] = useState(state.config?.profile?.name ?? "");
  const [email, setEmail] = useState(state.config?.profile?.email ?? "");
  useEffect(() => {
    setName(state.config?.profile?.name ?? "");
    setEmail(state.config?.profile?.email ?? "");
  }, [state.config?.profile?.name, state.config?.profile?.email]);

  const save = () => {
    void fetch("/api/config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ profile: { name: name.trim(), email: email.trim().toLowerCase() } }),
    })
      .then((r) => { if (!r.ok) throw new Error("Profile save failed"); return r.json(); })
      .then((config: ConfigStatus) => {
        if (config.profile) dispatch({ type: "profileSaved", profile: { name: config.profile.name, email: config.profile.email } });
      })
      .catch(() => {});
  };

  const inputClass =
    "w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[14px] text-ink placeholder:text-ink-secondary focus:outline-none";
  return (
    <div className="flex flex-col gap-3">
      <input aria-label={t("settings.profile.name")} value={name} onChange={(e) => setName(e.target.value)} onBlur={save} placeholder={t("settings.profile.name")} className={inputClass} />
      <input
        type="email"
        aria-label={t("phone.signIn.email")}
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        onBlur={save}
        placeholder="you@example.com"
        className={inputClass}
      />
      <AboutMeSettings />
    </div>
  );
}
