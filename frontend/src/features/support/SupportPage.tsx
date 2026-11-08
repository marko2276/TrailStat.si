import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ErrorMessage } from "../../components/ErrorMessage";
import { Loading } from "../../components/Loading";
import { upnQrUrl, useDonationDetails } from "./api";

/** Suggested amounts, in euro cents. The payer can also enter their own. */
export const AMOUNTS = [500, 1000, 2000, 5000] as const;

/** Donations by bank transfer: a UPN QR code to scan, and the details to type in without it. */
export function SupportPage() {
  const { t, i18n } = useTranslation("support");
  const details = useDonationDetails();
  const [amount, setAmount] = useState<number | null>(AMOUNTS[1]);

  if (details.isPending) return <Loading />;
  if (details.isError) return <ErrorMessage error={details.error} />;

  const euro = new Intl.NumberFormat(i18n.language, {
    style: "currency",
    currency: "EUR",
    maximumFractionDigits: 0,
  });
  const donation = details.data;

  return (
    <article>
      <h1>{t("title")}</h1>
      <p>{t("intro")}</p>
      {donation === null ? (
        <p role="status">{t("off")}</p>
      ) : (
        <>
          <section className="card support-qr">
            <h2>{t("qr.title")}</h2>
            <fieldset className="amount-choice">
              <legend>{t("qr.amount")}</legend>
              {[...AMOUNTS, null].map((cents) => (
                <label key={cents ?? "own"}>
                  <input
                    type="radio"
                    name="amount"
                    checked={amount === cents}
                    onChange={() => setAmount(cents)}
                  />
                  {cents === null ? t("qr.ownAmount") : euro.format(cents / 100)}
                </label>
              ))}
            </fieldset>
            <img
              className="upn-qr"
              src={upnQrUrl(amount)}
              width={340}
              height={340}
              alt={
                amount === null
                  ? t("qr.altOwnAmount")
                  : t("qr.alt", { amount: euro.format(amount / 100) })
              }
            />
            <p className="muted">{t("qr.howTo")}</p>
          </section>

          <section>
            <h2>{t("transfer.title")}</h2>
            <dl className="donation-details">
              <dt>{t("transfer.recipient")}</dt>
              <dd>
                {donation.name}
                {donation.street && <br />}
                {donation.street}
                <br />
                {donation.city}
              </dd>
              <dt>{t("transfer.iban")}</dt>
              <dd className="wrap-anywhere">{donation.iban}</dd>
              <dt>{t("transfer.purpose")}</dt>
              <dd>{donation.purpose}</dd>
              <dt>{t("transfer.reference")}</dt>
              <dd>{donation.reference}</dd>
            </dl>
          </section>

          <p className="muted">{t("direct")}</p>
          <p>{t("thanks")}</p>
        </>
      )}
    </article>
  );
}
