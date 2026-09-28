# 2Factor: request OTP delivery through transactional SMS

## What is fixed, and what is not

The legacy `/API/V1/.../SMS/...` OTP branch has been removed from this adapter. It now has only one transport: transactional SMS. It does not request voice, use AUTOGEN, or retry through another provider. A provider SMS log marked `DELIVERED`, even with an empty fallback checkbox, was not enough to explain the reported calls; provider-side delivery traces are still needed for that historical discrepancy.

The default and only supported mode is `transactional_sms`, using the **separate transactional SMS product**: `POST https://2factor.in/API/R1/` with `module=TRANS_SMS`. 2Factor documents this endpoint for OTPs as well as other transactional messages. It needs a DLT-approved SMS format and approved sender. It uses the account's transactional SMS service/balance, not the legacy OTP product. Verify account entitlement and billing with 2Factor before deploying this version.

This implementation never falls back from that endpoint to the OTP route, voice or another vendor. It cannot guarantee handset delivery or control undocumented provider behavior. A controlled handset test is required before saying calls have stopped. The code change does not itself deploy anything or edit any production environment, but **deploying this version changes the 2Factor default route**. Other providers and OTP generation/verification remain unchanged.

## Approval gate -- do this before changing production

If approved sender/template details are missing or unknown, **do not deploy this backend version to an active 2Factor installation yet**. Supplying only the old API key/template-name configuration will stop OTP sending with `OTP_PROVIDER_NOT_CONFIGURED`. The adapter will not silently call the old route. No dummy approved identifiers or defaults are supplied.

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
- `TWOFACTOR_TEMPLATE_NAME` is obsolete and ignored. It cannot replace `TWOFACTOR_SMS_TEMPLATE` or configure transactional SMS.
- `SMS_REQUEST_TIMEOUT_MS` remains supported (15 seconds by default, bounded to 1-30 seconds). A timeout does not trigger another send because the first message may already have been accepted.
- Only Indian mobile numbers are supported by this adapter. Input normalization and OTP verification security are unchanged.

Unset/blank `TWOFACTOR_DELIVERY_MODE` defaults to `transactional_sms`; explicitly setting that value is also supported. An existing value of `otp` or `sms_otp` must be removed or changed to `transactional_sms`. Legacy and unknown values fail closed; there is no `voice`, `auto`, or `sms_only` mode and no environment switch that restores the legacy route.

## Deployment and controlled verification

1. Obtain and verify the approved transactional configuration **before deployment**. No frontend build or database migration is needed.
2. Deploy this backend version with the approved configuration. Remove/change any explicit legacy delivery mode. Do not place any provider key in frontend variables.
3. From the backend environment run `npm run check:otp`. It makes no network requests and sends no SMS. Expect `provider: "2factor"`, `deliveryMode: "transactional_sms"`, `ready: true`, and empty `missing`/`invalid` arrays. This checks local configuration only, not account approval, balance, credentials or handset delivery.
4. With the recipient's consent, request one OTP and confirm it arrives as **SMS** with the approved sender and correct code. Inspect **Transactional SMS** logs, not the old SMS OTP or Voice OTP log. Provider acceptance alone is not proof of SMS delivery.
5. Verify the received code, resend after the existing cooldown, and check both customer and owner/admin login. Check COD/phone-change verification if used. Do not repeatedly send test OTPs after a timeout; check the provider logs first.
6. Confirm no call accompanies the test. If a call persists on this separate endpoint, escalate the transactional request trace to 2Factor; do not claim the issue is solved or add an undocumented API flag.

Before each provider request the backend logs only `[2Factor] deliveryMode: transactional_sms`; keys, messages, OTPs, phone numbers and request bodies are never logged. A successful adapter result includes `channel: "sms"`, indicating the requested transport, not a verified handset receipt.

Setting `otp` does **not** restore the old route. Rolling back to older backend code is a separate deployment decision and can restore the reported call behavior; it is not an SMS-only workaround. Do not enable demo OTP to get around provider failures.

## Automated regression checks

```sh
node --test --test-concurrency=1 tests/twoFactorTransactional.unit.test.js tests/smsProviders.unit.test.js tests/smsFlows.test.js tests/authRecovery.unit.test.js tests/phoneUtils.test.js tests/env.test.js
```

Provider requests are mocked; no paid SMS/call is made. Database-backed tests use the existing isolated MongoDB test harness. They cover the exact form-encoded API contract, backend OTP preservation, template/ID validation, missing/legacy settings, rejected legacy/unknown modes, auth/HTTP/network failures, no fallback or automatic retry, credential-safe route logging, recovery after configuration repair, customer/admin login, resend cooldown, invalid/reused codes, COD verification and compatibility with other providers.

## Official references

- [2Factor API documentation](https://documenter.getpostman.com/view/301893/TWDamFGh): **Send Transactional SMS > Send Single SMS**, and **Send SMS OTP > Send OTP - Custom OTP**.
- [Legacy manual OTP request](https://2factor.in/API/DOCS/SMS_OTP.html).
- [Transactional SMS service](https://2factor.in/v3/transactional-sms-services).
