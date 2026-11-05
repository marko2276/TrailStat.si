# ADR 0006: Scaleway Transactional Email for outgoing e-mail

- Status: accepted
- Date: 2026-11-05

## Context

The backend sends group invitations and join request notifications over SMTP. A home server cannot send them itself: home internet connections have a poor sending reputation, and many ISPs block outgoing mail on port 25. NFR-3 asks for services hosted in the EU, without depending on US big tech at runtime.

## Decision

Use Scaleway Transactional Email through its SMTP relay (`smtp.tem.scaleway.com`). Scaleway is a French company in the Iliad group. Its documentation says e-mail content, logs and backups stay in France, and that no dedicated sub-processor handles e-mail content or metadata.

Compared in November 2026, and rejected:

- **Brevo:** French, with 300 free e-mails a day, but its help pages say data is stored on Google Cloud in Belgium.
- **Mailjet:** owned by Sinch, with 6,000 free e-mails a month, but Sinch's sub-processor list names Google Cloud as its hosting, and free e-mails carry a Mailjet logo.
- **MailerSend:** the legal entity is MailerSend, Inc., with an EU representative under GDPR, and its hosting could not be confirmed.

## Consequences

300 e-mails a month are free, then €0.25 per 1,000, with no monthly fee. Scaleway's pages disagree on the default monthly sending limit, so it must be checked in the console. The service only sends, so `privacy@trailstat.si` needs a separate mailbox or forwarding. The privacy policy names Scaleway, as it receives recipients' addresses and the messages.

`trailstat.si` needs SPF, DKIM and DMARC records. Bounces are visible only in Scaleway's console: the backend only knows that the message was accepted. The backend supports STARTTLS (port 587), not direct TLS (port 465).

Hanko Cloud sends its own e-mail. Once Hanko is self-hosted (#41), it needs SMTP settings too, and can use the same service, which adds its sign-in passcodes to the volume.

Only SMTP settings and DNS records tie the app to Scaleway, so changing provider later needs no code change.
