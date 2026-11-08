import { useQuery } from "@tanstack/react-query";
import { api, ApiError, withQuery } from "../../lib/api";

/** Where to send a donation by bank transfer, typed in by hand. */
export interface BankTransfer {
  iban: string;
  name: string;
  street: string | null;
  city: string;
  purpose: string;
  /** "SI99": the payment needs no reference. */
  reference: string;
}

/** The phone number to send a donation to with Flik, and a message to send with it. */
export interface Flik {
  number: string;
  message: string;
}

/** At least one is set. The server answers 404 when donations are off. */
export interface DonationDetails {
  bank_transfer: BankTransfer | null;
  flik: Flik | null;
}

/** The details, or null when donations are off. They change only with the server's settings. */
export function useDonationDetails() {
  return useQuery({
    queryKey: ["donations"],
    queryFn: async () => {
      try {
        return await api.get<DonationDetails>("/donations");
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      }
    },
    staleTime: Infinity,
    retry: false,
  });
}

/** The UPN QR code's image. Without an amount, the payer enters one in their banking app. */
export function upnQrUrl(amountCents: number | null): string {
  return `/api${withQuery("/donations/upn-qr.svg", { amount_cents: amountCents })}`;
}
