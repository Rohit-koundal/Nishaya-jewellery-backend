# 2Factor: request OTP delivery through transactional SMS

## What is fixed, and what is not

The default adapter already calls 2Factor's manual `/API/V1/.../SMS/...` OTP API. It does not request voice, use AUTOGEN, or retry through another provider. A provider SMS log marked `DELIVERED`, even with an empty fallback checkbox, is not enough to explain a customer receiving a call. Provider-side delivery traces are still needed for that discrepancy.

An explicit `transactional_sms` mode now uses the **separate transactional SMS product**: `POST https://2factor.in/API/R1/` with `module=TRANS_SMS`. 2Factor documents this endpoint for OTPs as well as other transactional messages. It needs a DLT-approved SMS format and approved sender. It uses the account's transactional SMS service/balance, not the legacy OTP product. Verify account entitlement and billing with 2Factor before enabling it.

This implementation never falls back from that endpoint to the OTP route, voice or another vendor. It cannot guarantee handset delivery or control undocumented provider behavior. A controlled handset test is required before saying calls have stopped. Nothing in this change activates the new mode or changes any production environment.

## Approval gate -- do this before changing production

If approved sender/template details are missing or unknown, **leave the current mode unchanged**. Enabling transactional mode without the required fields fails closed and will stop OTP sending rather than silently call the old route.

Ask 2Factor support, using the authenticated dashboard:

> We need OTP delivery via your transactional SMS API (`API/R1`, `module=TRANS_SMS`), without automatic voice delivery. Please confirm this route for our account, its transactional balance/billing, and the approved Sender ID, exact message text, PE ID and Content Template ID. Our legacy SMS OTP logs say DELIVERED with no fallback, but users receive calls; please also trace the affected session IDs. Tell us what DLT/template/sender approvals or mappings remain before we can enable the transactional route.

The API key or wallet balance alone does not demonstrate those approvals. Do not invent a sender ID/template or copy sample identifiers. Do not paste secrets, phone numbers or OTPs into support screenshots or ordinary application logs. Rotate previously exposed API keys through the provider and update the backend secret store.

## Backend configuration

Only after provider setup is complete, set these in the **Nishaya backend** hosting environment:

```dotenv
OTP_MODE=production
SMS_PROVIDER=2factor
TWOFACTOR_API_KEY=<current-private-provider-key>
TWOFACTOR_DELIVERY_MODE=transactional_sms
TWOFACTOR_SMS_SENDER_ID=<approved-six-letter-sender>
TWOFACTOR_SMS_TEMPLATE=<exact-approved-message-with-one-{otp}-placeholder>
```

The values in angle brackets are instructions, not usable credentials/content. In Render, enter the real value without surrounding quotes.

- `TWOFACTOR_SMS_TEMPLATE` is the full approved message text, **not** a template name or ID. Replace the approved OTP variable with exactly one `{otp}` marker. Keep the remaining characters, punctuation and whitespace unchanged. Additional/unresolved placeholders are rejected locally. No sample message is supplied as a live default.
- The application still generates and verifies its own six-digit code; it substitutes only `{otp}`. Do not switch to AUTOGEN.
- Use a generic verification message suitable for all enabled flows: customer/admin login, phone verification and COD verification share this transport. Do not claim a different validity period from the backend's configured OTP expiry.
- Optional `TWOFACTOR_DLT_ENTITY_ID` and `TWOFACTOR_DLT_TEMPLATE_ID` are passed as `peid` and `ctid`. Supply the approved numeric IDs if required for your account; only omit them if 2Factor confirms the account-side mapping is sufficient. These values are treated as strings, never converted to numbers.
- `TWOFACTOR_TEMPLATE_NAME` is used only by the legacy `otp` mode. Setting it does not configure transactional SMS.
- `SMS_REQUEST_TIMEOUT_MS` remains supported (15 seconds by default, bounded to 1-30 seconds). A timeout does not trigger another send because the first message may already have been accepted.
- Only Indian mobile numbers are supported by this adapter. Input normalization and OTP verification security are unchanged.

Unset/blank `TWOFACTOR_DELIVERY_MODE` defaults to `otp` for existing deployments. Explicit `otp` also retains the old behavior. Unknown mode values are rejected; there is no `voice`, `auto`, or `sms_only` mode.

## Deployment and controlled verification

1. Deploy the backend code, keeping the legacy configuration until approvals are ready. No frontend build or database migration is needed.
2. Add the approved transactional configuration, save and redeploy the backend. Do not place any provider key in frontend variables.
3. From the backend environment run `npm run check:otp`. It makes no network requests and sends no SMS. Expect `provider: "2factor"`, `deliveryMode: "transactional_sms"`, `ready: true`, and empty `missing`/`invalid` arrays. This checks local configuration only, not account approval, balance, credentials or handset delivery.
4. With the recipient's consent, request one OTP and confirm it arrives as **SMS** with the approved sender and correct code. Inspect **Transactional SMS** logs, not the old SMS OTP or Voice OTP log. Provider acceptance alone is not proof of SMS delivery.
5. Verify the received code, resend after the existing cooldown, and check both customer and owner/admin login. Check COD/phone-change verification if used. Do not repeatedly send test OTPs after a timeout; check the provider logs first.
6. Confirm no call accompanies the test. If a call persists on this separate endpoint, escalate the transactional request trace to 2Factor; do not claim the issue is solved or add an undocumented API flag.

Reverting explicitly to `otp` restores the old route but **can restore the reported call behavior**. It is not a silent fallback or SMS-only workaround. Do not enable demo OTP to get around provider failures.

## Automated regression checks

```sh
node --test --test-concurrency=1 tests/twoFactorTransactional.unit.test.js tests/smsProviders.unit.test.js tests/smsFlows.test.js tests/authRecovery.unit.test.js tests/phoneUtils.test.js tests/env.test.js
```

Provider requests are mocked; no paid SMS/call is made. Database-backed tests use the existing isolated MongoDB test harness. They cover the exact form-encoded API contract, backend OTP preservation, template/ID validation, missing settings, unknown modes, auth/HTTP/network failures, no fallback or automatic retry, credential-safe diagnostics, customer/admin login, resend cooldown, invalid/reused codes, COD verification and compatibility with existing providers.

## Official references

- [2Factor API documentation](https://documenter.getpostman.com/view/301893/TWDamFGh): **Send Transactional SMS > Send Single SMS**, and **Send SMS OTP > Send OTP - Custom OTP**.
- [Legacy manual OTP request](https://2factor.in/API/DOCS/SMS_OTP.html).
- [Transactional SMS service](https://2factor.in/v3/transactional-sms-services).
