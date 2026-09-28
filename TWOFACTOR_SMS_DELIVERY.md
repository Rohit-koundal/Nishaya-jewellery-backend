# 2Factor: request OTP delivery through transactional SMS

## What is fixed, and what is not

The legacy `/API/V1/.../SMS/...` OTP branch has been removed from this adapter. It now has only one transport: transactional SMS. It does not request voice, use AUTOGEN, or retry through another provider. A provider SMS log marked `DELIVERED`, even with an empty fallback checkbox, was not enough to explain the reported calls; provider-side delivery traces are still needed for that historical discrepancy.

The default and only supported mode is `transactional_sms`, using the **separate transactional SMS product**: `POST https://2factor.in/API/R1/` with `module=TRANS_SMS`. 2Factor documents this endpoint for OTPs as well as other transactional messages. It needs a DLT-approved SMS format and approved sender. It uses the account's transactional SMS service/balance, not the legacy OTP product. Verify account entitlement and billing with 2Factor before deploying this version.

This implementation never falls back from that endpoint to the OTP route, voice or another vendor. It cannot guarantee handset delivery or control undocumented provider behavior. A controlled handset test is required before saying calls have stopped. The code change does not itself deploy anything or edit any production environment. Other provider transports and OTP generation remain unchanged. Customer verification now uses the same atomic single-use redemption protection as owner/scoped OTPs.

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
TWOFACTOR_SMS_SENDER_ID=<approved-3-to-6-letter-sender>
TWOFACTOR_SMS_TEMPLATE=<exact-approved-message-with-one-{otp}-placeholder>
```

The values in angle brackets are instructions, not usable credentials/content. In Render, enter the real value without surrounding quotes.

- `TWOFACTOR_SMS_TEMPLATE` is the full approved message text, **not** a template name or ID. Replace the approved OTP variable (for example `#VAR1#` in the provider form) with exactly one `{otp}` marker. Keep the remaining characters, punctuation and whitespace unchanged. Additional/unresolved `{name}` or `#VAR2#` placeholders are rejected locally. No sample message is supplied as a live default.
- The application still generates and verifies its own six-digit code; it substitutes only `{otp}`. Do not switch to AUTOGEN.
- Use a generic verification message suitable for all enabled flows: customer/admin login, phone verification and COD verification share this transport. Do not claim a different validity period from the backend's configured OTP expiry.
- Optional `TWOFACTOR_DLT_ENTITY_ID` and `TWOFACTOR_DLT_TEMPLATE_ID` are passed as `peid` and `ctid`. Supply the approved numeric IDs if required for your account; only omit them if 2Factor confirms the account-side mapping is sufficient. These values are treated as strings, never converted to numbers.
- `TWOFACTOR_TEMPLATE_NAME` is obsolete and ignored. It cannot replace `TWOFACTOR_SMS_TEMPLATE` or configure transactional SMS.
- `SMS_REQUEST_TIMEOUT_MS` remains supported (15 seconds by default, bounded to 1-30 seconds). A timeout does not trigger another send because the first message may already have been accepted.
- Only Indian mobile numbers are supported by this adapter. Input normalization, expiry, attempt limits, and owner verification requirements are preserved.

Unset/blank `TWOFACTOR_DELIVERY_MODE` defaults to `transactional_sms`; explicitly setting that value is also supported. An existing value of `otp` or `sms_otp` must be removed or changed to `transactional_sms`. Legacy and unknown values fail closed; there is no `voice`, `auto`, or `sms_only` mode and no environment switch that restores the legacy route.

## Deployment and controlled verification

1. Obtain and verify the approved transactional configuration **before deployment**. Existing OTP records remain compatible; no data migration is needed.
2. Deploy the backend for diagnostics and build/deploy the frontend for support references, accurate delivery wording and the mobile countdown fix. The API changes are additive, so an older frontend remains compatible. Remove/change any explicit legacy delivery mode. Do not place any provider key in frontend variables.
3. From the backend environment run `npm run check:otp`. It makes no network requests and sends no SMS. Expect `provider: "2factor"`, `deliveryMode: "transactional_sms"`, `ready: true`, and empty `missing`/`invalid` arrays. This checks local configuration only, not account approval, balance, credentials or handset delivery.
4. With the recipient's consent, request one OTP and confirm it arrives as **SMS** with the approved sender and correct code. Inspect **Transactional SMS** logs, not the old SMS OTP or Voice OTP log. Provider acceptance alone is not proof of SMS delivery.
5. Verify the received code, resend after the existing cooldown, and check both customer and owner/admin login. Check COD/phone-change verification if used. Do not repeatedly send test OTPs after a timeout; check the provider logs first.
6. Confirm no call accompanies the test. If a call persists on this separate endpoint, escalate the transactional request trace to 2Factor; do not claim the issue is solved or add an undocumented API flag.

Before each provider request the backend still logs `[2Factor] deliveryMode: transactional_sms`. A subsequent structured `otp.delivery` event records the safe reference and acceptance result. Keys, messages, OTPs, phone numbers, request bodies and raw provider errors are never logged. A successful adapter result includes `channel: "sms"`, indicating the requested transport, not a verified handset receipt.

Setting `otp` does **not** restore the old route. Rolling back to older backend code is a separate deployment decision and can restore the reported call behavior; it is not an SMS-only workaround. Do not enable demo OTP to get around provider failures.

## Trace an accepted request that never reaches the phone

1. In the browser, inspect the response to the actual live `/api/auth/send-otp` request. `otpMode: production` and `deliveryStatus: accepted` mean the provider accepted the request, not that the phone received it. The response includes an opaque `supportReference`; the login page displays it beside the help link. No provider reference, account identifier or credential is sent to the customer.
2. Search **the matching backend deployment's logs** for that `supportReference` and `event: otp.delivery`. The event contains `providerReference`, `accountFingerprint`, `status`, optional `reason`, UTC `attemptedAt`, and duration. A separate HTTP `requestId` is an application correlation ID, not the provider reference. HTTP `level: warn` can simply mean a slow request.
3. Run `npm run check:otp` in that backend environment. Its fingerprint should match the delivery event; a local `.env` result does not prove Render uses the same key. Privately confirm the provider dashboard belongs to that key/account. Never paste the key into support messages or command arguments. Check **Transactional SMS** logs with the matching date/time and cleared filters.
4. Use the captured provider reference for a read-only report lookup:

   ```sh
   npm run check:otp-delivery -- <providerReference> --account=<accountFingerprint>
   ```

   Use actual values from the log, without angle brackets. On Windows PowerShell with blocked npm scripts, use `npm.cmd` instead. The command reads the backend key internally, makes one HTTPS GET to the documented transactional report endpoint, has a 5-second timeout and a 64 KiB response limit, and does **not** send SMS, retry, modify OTPs or connect to the database. It prints only sanitized statuses and numeric error codes, never raw XML (which can contain recipient information).

5. Interpret the result honestly:

   | Result | Meaning / next action |
   | --- | --- |
   | `delivered` | The provider report says delivered. Confirm the destination privately and ask the customer to check the SMS spam/blocked inbox; it is not proof that the person read it. |
   | `pending` | Provider delivery is still pending. Do not repeatedly send more codes. |
   | `failed` | Use the report's numeric error code and provider reference with 2Factor support; fix the relevant account/sender/template/operator issue. |
   | `unknown`, `REPORT_NOT_FOUND` or `REPORT_UNAVAILABLE` | No usable report is available. This is **not** evidence of either delivery or failure. Some R1 accounts may not expose their references through the older documented transactional report API. Confirm with 2Factor support; no undocumented endpoint or fake status is used. |
   | `ACCOUNT_MISMATCH` | The command is using a different key from the sending deployment. Check the intended environment privately. No provider request was made. |

The command exits `0` only for a delivered report, `2` for pending/failed/unknown, and `1` for invalid command usage/unexpected local failure. It is an operator diagnostic, not a polling endpoint and does not block customer login while waiting for an SMS receipt. Verification still requires the actual valid OTP.

If the provider reference is `null` with `REFERENCE_UNAVAILABLE`, the success payload did not contain a recognized safe reference. Acceptance is retained, but raw `Details` is deliberately not logged: it might contain a secret or message. Ask support to trace the account and attempted timestamp. References from requests sent **before** this diagnostic change cannot be recovered from old application logs.

Provider diagnostics are also saved on the existing OTP record and expire with that record; they are not a permanent SMS audit archive. Keep deployment logs under the operator's normal restricted-access retention policy. A metadata-storage failure is logged safely and does not trigger a second send or block an otherwise valid code.

### Safe rejection reasons

`AUTH_OR_PERMISSION`, `INSUFFICIENT_BALANCE`, `SENDER_NOT_APPROVED`, `TEMPLATE_REJECTED`, `DLT_CONFIGURATION`, `SERVICE_INACTIVE`, and `PROVIDER_RATE_LIMIT` are allowlisted categories inferred from the send response, not raw messages. `NETWORK_OR_TIMEOUT` is an **unknown** outcome because the provider might have accepted the request before the connection failed. No automatic resend, voice fallback or provider switch is attempted.

For support, provide the provider reference, UTC/IST attempt time, sender/template approval status and numeric delivery-report error if available, through the authenticated provider support channel. Ask them to confirm R1 `TRANS_SMS` account activation, DLT entity/header/content/PE-TM mapping and where that reference is logged. Never send an API key or an OTP.

### Customer experience and security

The login page says **OTP requested** for provider acceptance, includes a support reference, and gives recovery guidance without claiming delivery. Resend timing comes from the server and is stored as an absolute deadline; refresh and mobile tab suspension do not restart it. Successful resend clears the old entered digits; the backend invalidates superseded codes. Concurrent duplicate submissions from the same page are guarded, and resend/verify controls cannot run together. Customer, owner and order-scoped production OTP verification all redeem the code atomically once; a delivery receipt never authorizes login.

## Automated regression checks

```sh
node --test --test-concurrency=1 tests/otpDeliveryDiagnostics.unit.test.js tests/twoFactorTransactional.unit.test.js tests/smsProviders.unit.test.js tests/smsFlows.test.js tests/authRecovery.unit.test.js tests/phoneUtils.test.js tests/env.test.js tests/deploymentAdmin.test.js
```

Provider requests are mocked; no paid SMS/call is made. Database-backed tests use the existing isolated MongoDB test harness. They cover the exact form-encoded API contract, backend OTP preservation, template/ID validation, missing/legacy settings, rejected legacy/unknown modes, auth/HTTP/network failures, no fallback or automatic retry, credential-safe route logging, recovery after configuration repair, customer/admin login, resend cooldown, invalid/reused codes, COD verification and compatibility with other providers.

Frontend regression coverage includes customer/admin login, profile, checkout selection/recovery, error sanitization, support references, duplicate-submit prevention, and restoring the real countdown after refresh/backgrounding.

Validation on 2026-09-28: the targeted backend command above passed 85 tests; the six related frontend suites passed 56 tests. The broader `auth.test.js` and `codVerification.test.js` run had 10 existing `SERVICE_UNAVAILABLE` (503) failures; loading the unchanged Git HEAD versions of the affected runtime modules reproduced the same 10 failures. Those separate pre-existing failures were not changed or hidden. Provider requests in regression tests are mocked; these results do not certify a live SMS delivery.

## Official references

- [2Factor API documentation](https://documenter.getpostman.com/view/301893/TWDamFGh): **Send Transactional SMS > Send Single SMS**, and **Send SMS OTP > Send OTP - Custom OTP**.
- [Legacy manual OTP request](https://2factor.in/API/DOCS/SMS_OTP.html).
- [Transactional SMS service](https://2factor.in/v3/transactional-sms-services).
- [Transactional delivery-report endpoint and XML fields](https://dial2verify.com/corp/support-system/tkt/knowledgebase.php?article=15).
