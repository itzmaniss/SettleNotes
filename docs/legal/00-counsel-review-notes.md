# Settle legal review pack

**Status:** Working drafts for Singapore counsel. Not approved for publication.
**Prepared:** 31 October 2026

## Drafts included

1. [Terms of Service](01-terms-of-service-draft.md), with the Acceptable Use Policy inside it.
2. [Privacy Notice](02-privacy-notice-draft.md).
3. [Payments, Cancellation and Refunds](03-payment-refund-draft.md).

A separate Cookie Policy is not included because the reviewed app uses an essential dashboard session cookie and no analytics or advertising cookies were identified. Recheck the production build before relying on that assumption. A public customer DPA is not included because Settle is currently direct-to-student. Revisit if schools or other organisations become customers.

## Facts supplied by the operator

- Operator: Balasubramanian Manish, acting as an individual. No company has been formed.
- Product: Telegram bot and web dashboard for students, including AI-assisted task extraction and study materials.
- Minimum intended age: 15. The operator prefers clear, age-appropriate student consent and a parent or guardian clause. There is no confirmed parental approval workflow.
- Market: Settle is marketed in Singapore, but signups are not blocked elsewhere.
- Customers: students directly, not schools or tutors.
- Payments: Stripe monthly and yearly, plus Telegram Stars monthly. The project configuration lists S$7.99 monthly, S$63.99 yearly and 600 Stars monthly. The operator confirmed these figures and the proposed refund interpretation. PayNow is excluded from this draft.
- Refund position: the first payment is refundable on request within 7 days; later renewal charges are not refunded. Cancellation stops the next renewal and access continues until the paid term ends.
- Privacy contact: `settlenotes@gmail.com`. Whether this contact is formally designated as the DPO, and what postal address may be published, remain to be confirmed.
- Hosting: self-managed VPS in Singapore, provider not yet identified. Supabase is intended to use its Singapore region.
- User uploads: raw files and identifiable information are to be deleted within 60 days after account closure. The operator wants to retain derived, anonymised material and honour withdrawal of reuse consent. The anonymisation process is being built and is not yet confirmed as operational.
- Secondary use: no model training. The operator is considering internal evaluation and using derived study material to answer other students.

## Counsel decisions and launch conditions

1. **Operator identity and liability.** Confirm how the individual operator must be identified, what correspondence address is required, whether incorporation is advisable before launch, and an appropriate liability cap and exclusions. A contract clause does not create a separate company or corporate liability shield.
2. **Users aged 15 to 17.** Confirm the contract and subscription position for minors, whether a parent or guardian must approve paid subscriptions, and what the parent clause should permit. PDPC guidance discusses when teenagers may consent to data practices; that does not itself decide whether a minor can enter a paid contract.
3. **Secondary use of submissions.** Draft on the assumption this is off at launch. Before enabling it, Settle should obtain a separate, optional, affirmative and revocable consent for internal evaluation and for derived material used to answer other students. Declining must not prevent use of the core service. Confirm rights to use uploaded course and third-party material, including group chat screenshots.
4. **Anonymisation and withdrawal.** Removing names alone is not sufficient to call material anonymous. If Settle must remove retained material when consent is withdrawn, keep a protected link that makes the material findable until deletion. Until that link is destroyed, describe the material as de-identified or pseudonymised, not irreversibly anonymous. Confirm the deletion period after withdrawal, backup schedule, and a maximum retention or review period for retained material.
5. **Retention capability.** The project currently stores raw uploads in Supabase. The reviewed code does not show an account deletion or de-identification workflow. Do not publish the 60-day deletion or withdrawal promises until the operational process covers source files, transcripts, generated outputs, database rows, backups and any retained derived corpus.
6. **Overseas signups and transfers.** Global signups are intended to remain open. Confirm whether Settle needs country restrictions or additional legal steps. Do not tell users outside Singapore that all compliance is their responsibility. Verify applicable transfer safeguards under the Singapore PDPA and any other relevant laws.
7. **Vendor and hosting details.** Confirm the live Supabase project region, VPS provider, and locations for VPS backups and logs. Review the current vendor agreements and subprocessors for Telegram, Meta, Supabase, Stripe and the VPS provider. Do not claim that all data stays in Singapore.
8. **Data requests and privacy contact.** Confirm that `settlenotes@gmail.com` is monitored for access, correction, withdrawal, account closure and deletion requests, and whether Balasubramanian Manish is the named DPO. Define a process for verifying and completing requests.
9. **Billing.** Confirm Stripe Price IDs match S$7.99 monthly and S$63.99 yearly, and that Telegram Stars is 600 Stars each 30-day period. Confirm tax treatment and that cancellation access-end dates and refund handling match the text.
10. **Consent and notice flow.** Add clear Terms and Privacy acceptance before creating a student account or charging it. Add a separate unticked opt-in for any secondary use. The current `/start` handler creates a user row before showing policies, and the footer has no policy links. Register the Privacy Notice in BotFather as required for the Telegram bot.

## Template sources reviewed

- **Privacy Notice:** The [PDPC Data Protection Notice Generator](https://apps.pdpc.gov.sg/dp-notice-generator/introduction) is a free customer-notice questionnaire that generates a Word document. Its [questionnaire preview](https://apps.pdpc.gov.sg/dpng/resources/DP%20Notice%20Generator%20-%20Questionnaires.xlsx) was also reviewed. PDPC says the output must be adapted to actual practices and is not a compliance guarantee.
- **Singapore Terms option:** [FirstCOUNSEL's document library](https://www.firstcounsel.co/documentlibrary) lists a Web & Mobile App Terms of Use template created in association with Collyer Law LLC, but the full text was not publicly accessible. These Settle drafts are a tailored review skeleton, not a copy of that gated template.
- **Generic Terms generator:** [TermsBox's Terms generator](https://termsbox.com/terms-and-conditions-generator) can produce an editable draft with common SaaS, account, subscription, content and liability sections. Its listed compliance modules focus on US, EU and UK subjects, so it was not treated as Singapore legal authority.

## Vendor facts found in official materials

- **Supabase:** The selected project region hosts the primary database, storage and backups. Supabase's current residency FAQ also describes out-of-region account processing, global support access, telemetry and logs stored in EU data centres, global CDN delivery, and US affiliate operations. A Singapore region does not mean every processing activity remains in Singapore. [Data residency FAQ](https://supabase.com/legal/privacy-resources/data-residency-and-transfers-faq) · [Available regions](https://supabase.com/docs/guides/platform/regions)
- **Telegram:** Its FAQ describes cloud data distributed across multiple data centres in different jurisdictions. No Singapore-specific bot-data residency commitment was found. [Telegram FAQ](https://telegram.org/faq?setln=en) · [Bot Developer Terms](https://telegram.org/tos/bot-developers)
- **Meta Model API:** The current Standard Services terms say request content is not used to train Meta models, but permit retention as needed for service, legal, safety and security purposes without a fixed period in that clause. No Singapore-only processing commitment was found. [Meta Model API Terms](https://dev.meta.ai/legal/terms-of-service)
- **Stripe:** Its current DPA describes transfers to Stripe LLC in the United States and global transfers through affiliates and subprocessors. Confirm the entity and terms in Settle's Stripe account. [Stripe DPA](https://stripe.com/legal/dpa)
- **Singapore law:** The PDPA contains retention and overseas transfer requirements. [Personal Data Protection Act 2012](https://sso.agc.gov.sg/Act/PDPA2012?ProvIds=pr25-)
- **Children and anonymisation:** [PDPC children's data guidance](https://www.pdpc.gov.sg/-/media/files/pdpc/pdf-files/advisory-guidelines/advisory-guidelines-on-the-pdpa-for-children%27s-personal-data-in-the-digital-environment_mar24.pdf) · [PDPC basic anonymisation guide](https://www.pdpc.gov.sg/-/media/files/pdpc/pdf-files/advisory-guidelines/guide-to-basic-anonymisation-%28updated-24-july-2024%29.pdf)

