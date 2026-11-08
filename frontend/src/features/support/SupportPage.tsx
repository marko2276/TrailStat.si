import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ErrorMessage } from "../../components/ErrorMessage";
import { Loading } from "../../components/Loading";
import { upnQrUrl, useDonationDetails } from "./api";
import type { BankTransfer, Flik } from "./api";

/** Suggested amounts, in euro cents. The payer can also enter their own. */
export const AMOUNTS = [200, 500, 1000, 2000] as const;

/** Donations with Flik, or by bank transfer: a UPN QR code to scan, or the details to type in. */
export function SupportPage() {
  const { t } = useTranslation("support");
  const details = useDonationDetails();

  if (details.isPending) return <Loading />;
  if (details.isError) return <ErrorMessage error={details.error} />;

  const donation = details.data;
  return (
    <article className="support">
      <h1>{t("title")}</h1>
      <p>{t("intro")}</p>
      {donation === null ? (
        <p role="status">{t("off")}</p>
      ) : (
        <>
          {donation.bank_transfer && <UpnQr />}
          {donation.flik && <FlikOption flik={donation.flik} />}
          {donation.bank_transfer && <ByHand transfer={donation.bank_transfer} />}
          <p className="muted">{t("direct")}</p>
          <p>{t("thanks")}</p>
        </>
      )}
    </article>
  );
}

function UpnQr() {
  const { t, i18n } = useTranslation("support");
  const [amount, setAmount] = useState<number | null>(AMOUNTS[2]);
  const euro = new Intl.NumberFormat(i18n.language, {
    style: "currency",
    currency: "EUR",
    maximumFractionDigits: 0,
  });

  return (
    <section className="card support-option">
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
  );
}

function FlikOption({ flik }: { flik: Flik }) {
  const { t } = useTranslation("support");
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(flik.number.replace(/\s/g, ""));
      setCopied(true);
    } catch {
      // Without clipboard access the number is still there to read.
    }
  }

  return (
    <section className="card support-option">
      <h2>{t("flik.title")}</h2>
      <p className="flik-number">
        <strong>{flik.number}</strong>{" "}
        <button type="button" className="btn" onClick={() => void copy()}>
          {t("flik.copy")}
        </button>
      </p>
      <p role="status" className="muted">
        {copied ? t("flik.copied") : ""}
      </p>
      <p className="muted">{t("flik.howTo", { message: flik.message })}</p>
    </section>
  );
}

function ByHand({ transfer }: { transfer: BankTransfer }) {
  const { t } = useTranslation("support");
  return (
    <section>
      <h2>{t("transfer.title")}</h2>
      <dl className="donation-details">
        <dt>{t("transfer.recipient")}</dt>
        <dd>
          {transfer.name}
          {transfer.street && <br />}
          {transfer.street}
          <br />
          {transfer.city}
        </dd>
        <dt>{t("transfer.iban")}</dt>
        <dd className="wrap-anywhere">{transfer.iban}</dd>
        <dt>{t("transfer.purpose")}</dt>
        <dd>{transfer.purpose}</dd>
        <dt>{t("transfer.reference")}</dt>
        <dd>{transfer.reference}</dd>
      </dl>
    </section>
  );
}
