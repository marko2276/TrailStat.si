import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { ErrorMessage } from "../../components/ErrorMessage";
import { Loading } from "../../components/Loading";
import { getHanko } from "../../auth/hanko";
import { countryOptions } from "../../lib/countries";
import { AccountData } from "./AccountData";
import { useMe, useUpdateMe } from "./api";
import type { Me } from "./api";

function ProfileForm({ me }: { me: Me }) {
  const { t, i18n } = useTranslation("profile");
  const updateMe = useUpdateMe();
  const [displayName, setDisplayName] = useState(me.display_name);
  const [country, setCountry] = useState(me.country ?? "");
  const [city, setCity] = useState(me.city ?? "");
  const countries = useMemo(
    () => countryOptions(i18n.resolvedLanguage ?? "en"),
    [i18n.resolvedLanguage],
  );

  function submit(event: FormEvent) {
    event.preventDefault();
    updateMe.mutate({
      display_name: displayName,
      country: country || null,
      city: city.trim() || null,
    });
  }

  return (
    <form className="form card" onSubmit={submit}>
      <div className="field">
        <label htmlFor="email">{t("email")}</label>
        <input id="email" value={me.email} readOnly disabled />
      </div>
      <div className="field">
        <label htmlFor="display-name">{t("displayName")}</label>
        <input
          id="display-name"
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
          required
          maxLength={100}
        />
      </div>
      <div className="field">
        <label htmlFor="country">{t("country")}</label>
        <select id="country" value={country} onChange={(event) => setCountry(event.target.value)}>
          <option value="">{t("notSet")}</option>
          {countries.map(({ code, name }) => (
            <option key={code} value={code}>
              {name}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor="city">{t("city")}</label>
        <input
          id="city"
          value={city}
          onChange={(event) => setCity(event.target.value)}
          maxLength={100}
        />
      </div>
      {updateMe.isError && <ErrorMessage error={updateMe.error} ns="profile" />}
      {updateMe.isSuccess && <p role="status">{t("saved")}</p>}
      <div>
        <button className="btn btn-primary" disabled={updateMe.isPending}>
          {t("common:save")}
        </button>
      </div>
    </form>
  );
}

function HankoProfile() {
  const { i18n } = useTranslation();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let active = true;
    void getHanko().then(() => {
      if (active) setReady(true);
    });
    return () => {
      active = false;
    };
  }, []);

  return ready ? <hanko-profile lang={i18n.resolvedLanguage} /> : <Loading />;
}

export function ProfilePage() {
  const { t } = useTranslation("profile");
  const { data: me, error } = useMe();

  if (error) return <ErrorMessage error={error} ns="profile" />;
  if (!me) return <Loading />;

  return (
    <>
      <h1>{t("title")}</h1>
      <ProfileForm key={me.id} me={me} />
      <h2>{t("security")}</h2>
      <p className="muted">{t("securityHint")}</p>
      <div className="card">
        <HankoProfile />
      </div>
      <AccountData me={me} />
    </>
  );
}
