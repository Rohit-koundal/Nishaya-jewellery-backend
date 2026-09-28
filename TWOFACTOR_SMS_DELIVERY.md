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
- **Optional, not an extra setup requirement:** `TWOFACTOR_DLT_ENTITY_ID` and `TWOFACTOR_DLT_TEMPLATE_ID` are passed as `peid` and `ctid` only when supplied, matching R1's official contract. The previously added mandatory-ID policy has been removed at the owner's request. Leave them unset unless 2Factor provides/requires explicit mapping for the account. Supplied non-numeric IDs still fail validation; never invent IDs or use `NISHAYA_VERIFY` as the numeric Content Template ID. IDs remain digit strings (1-64 digits), not JavaScript numbers. Omission does not bypass provider-side DLT validation.
- Keep these existing `TWOFACTOR_DLT_*` names. `TWOFACTOR_ENTITY_ID`, `TWOFACTOR_TEMPLATE_ID`, and generic `SMS_ENTITY_ID`/`SMS_TEMPLATE_ID` are **not** aliases in this adapter.
- `TWOFACTOR_TEMPLATE_NAME` is obsolete and ignored. It cannot replace `TWOFACTOR_SMS_TEMPLATE` or configure transactional SMS.
- `SMS_REQUEST_TIMEOUT_MS` remains supported (15 seconds by default, bounded to 1-30 seconds). A timeout does not trigger another send because the first message may already have been accepted.
- Only Indian mobile numbers are supported by this adapter. Input normalization, expiry, attempt limits, and owner verification requirements are preserved.

Unset/blank `TWOFACTOR_DELIVERY_MODE` defaults to `transactional_sms`; explicitly setting that value is also supported. An existing value of `otp` or `sms_otp` must be removed or changed to `transactional_sms`. Legacy and unknown values fail closed; there is no `voice`, `auto`, or `sms_only` mode and no environment switch that restores the legacy route.

## DLT-CNT-REJECT investigation (2026-09-28)

The reported failure is a delivery-time content rejection, not evidence of a voice request. **The owner's latest APPROVED template table revealed a concrete text mismatch:** it starts `XXXX is your OTP to verify your phone number at Nishaya Jewellery.`, while the local configuration and previously reported outgoing SMS started `Your verification code for Nishaya Jewellery is ...`. The earlier comparison used a different message supplied in the conversation. The latest table supersedes it. The local `.env` message has now been aligned with the latest approved text, replacing only `XXXX` with `{otp}`. Sender remains `NISHAY`, mode remains `transactional_sms`, and DLT IDs remain optional. Render's actual environment has not been accessed or changed.

Missing IDs are **not a proven cause of the operator rejection**. The official API permits omission, and the actual provider-side entity/header/content mapping is not available locally. Exact content can still be rejected if the operator is validating a different/unmapped template. Removing a local configuration gate does not resolve `DLT-CNT-REJECT`: 2Factor must confirm/fix the existing sender/content mapping or provide a documented provider-managed, SMS-only alternative. Do not start another registration solely because the IDs are absent locally. Only test fixtures, not real DLT IDs, are present in the inspected repository/local configuration.

For the approved `NISHAYA_VERIFY` template, configure these exact Render values (no surrounding quotes):

```dotenv
TWOFACTOR_SMS_SENDER_ID=NISHAY
TWOFACTOR_SMS_TEMPLATE={otp} is your OTP to verify your phone number at Nishaya Jewellery. Please do not share this OTP with anyone.
```

The latest approved table's `XXXX` is represented by this application's `{otp}` marker. No other character changes, and the backend still generates its existing six-digit OTP. The template name is a dashboard label, not a `msg` value and not a `ctid`. Update the exact message in Render as well: local `.env` changes are not deployed and inherited Render env values take precedence. There is no new live default or hardcoded ID in the implementation. The APPROVED table alone does not independently prove operator-DLT/R1 approval; if rejection continues after correcting the message, 2Factor must confirm that route's mapping.

No extra mandatory DLT variables are needed for the application to submit a request. If 2Factor specifically supplies explicit mapping IDs, configure them in the backend environment only. Otherwise ask support to resolve any continuing `DLT-CNT-REJECT` against the existing `NISHAY` / `NISHAYA_VERIFY` entry and request reference. Only the message line in the local backend `.env` was updated from the latest owner-provided approval details; keys and other private configuration were untouched. No production environment has been edited.

The public OTP endpoint documentation does not provide a verified no-voice switch, and the provider's developer portal describes automatic voice fallback. Therefore the app has **not** been switched back to that endpoint, AUTOGEN, or an invented `sms_only` API parameter. A support-confirmed SMS-only contract/account setting is needed before changing transports. The current implementation remains on the dedicated transactional SMS product, with no voice or cross-provider fallback in application code.

### Inspected execution/configuration map

| Files | Role / finding |
| --- | --- |
| `server.js`, `config/env.js` | Load `backend/.env`, then cwd `.env`, with dotenv's default `override: false`; inherited Render environment wins, even if set to an empty string. `OTP_MODE` must be explicitly `production` (default is demo). |
| `routes/authRoutes.js`, `controllers/authController.js` | Send and resend share `sendOtp`; phone-change verification shares the same SMS sender. Production failure invalidates the unsent code rather than falling back. Rate limits/cooldown remain unchanged. |
| `services/otpService.js`, `models/Otp.js`, `utils/phoneUtils.js` | Backend creates/hashes/expires/consumes the six-digit OTP. Indian numbers normalize to ten subscriber digits; adapter sends `91` + those digits, without `+`. No provider verification/voice endpoint is called. |
| `services/smsService.js`, `services/providers/smsProviderRegistry.js` | Resolve the selected provider from `SMS_PROVIDER` at call time. `2factor`, `twofactor`, `two-factor` select the same adapter. Other installed providers are not fallback routes. |
| `services/providers/smsProviderUtils.js`, `services/providers/twoFactorProvider.js` | `getConfiguration()` reads process.env at send time. `readConfiguration()` marks required missing fields; `requireConfiguration()` rejects missing/invalid config. Only `POST /API/R1/`, `module=TRANS_SMS`, can send a 2Factor OTP. Numeric DLT fields are optional and sent only when supplied. Message whitespace is preserved. |
| `services/otpDeliveryDiagnostics.js`, `services/providers/twoFactorDeliveryReport.js` | Safe acceptance/rejection logs; read-only report lookup distinguishes later DLT rejection from acceptance. `/API/V1/.../RPT/TSMS/...` is a GET report endpoint, not an OTP/voice send. |
| `scripts/check-otp-config.js`, `scripts/check-otp-delivery.js` | Local readiness and optional read-only provider report tools; neither sends a code. Config check mirrors backend dotenv loading. |
| `services/codVerificationService.js`, `controllers/orderController.js`, `routes/orderRoutes.js` | Order verification shares SMS sending. Inspected only; no order/controller/auth changes in this patch. |
| `services/emailService.js`, `services/clientHandoverService.js` | Separate email OTP transport and provider readiness consumer; unchanged. |
| `src/context/AuthContext.jsx`, `src/store/apiSlice.js`, `src/services/api.js`, `src/utils/loginOtpStorage.js`, customer `Login.jsx`, `ProfileDetails.jsx`, `Checkout.jsx`, `OrderDetail.jsx`, admin `AdminLogin.jsx` | Frontend callers/OTP UI inspected for request paths; no frontend changes in this patch. |

For the current DLT-only patch, changed runtime files are `services/providers/twoFactorProvider.js`, `services/otpDeliveryDiagnostics.js`, `services/providers/twoFactorDeliveryReport.js`, and `scripts/check-otp-config.js`. Tests and this guide are the only other tracked changes. No authentication, OTP lifetime, verification, frontend, order, retry or provider-selection behavior is modified.

## Deployment and controlled verification

1. Obtain and verify the approved transactional configuration **before deployment**. Existing OTP records remain compatible; no data migration is needed.
2. Deploy the **backend only**. No additional mandatory DLT IDs, frontend build/deployment, migration or dependency installation are introduced. Remove/change any explicit legacy delivery mode. Do not place any provider key in frontend variables. Deployment alone does not resolve an outstanding provider rejection.
3. From the backend environment run `npm run check:otp`. It makes no network requests and sends no SMS. Expect `provider: "2factor"`, `deliveryMode: "transactional_sms"`, `ready: true`, and empty `missing`/`invalid` arrays. This checks local configuration only, not account approval, balance, credentials or handset delivery.
4. With the recipient's consent, request one OTP and confirm it arrives as **SMS** with the approved sender and correct code. Inspect **Transactional SMS** logs, not the old SMS OTP or Voice OTP log. Provider acceptance alone is not proof of SMS delivery.
5. Verify the received code, resend after the existing cooldown, and check both customer and owner/admin login. Check COD/phone-change verification if used. Do not repeatedly send test OTPs after a timeout; check the provider logs first.
6. Confirm no call accompanies the test. If a call persists on this separate endpoint, escalate the transactional request trace to 2Factor; do not claim the issue is solved or add an undocumented API flag.

Before each provider request the backend still logs `[2Factor] deliveryMode: transactional_sms`. A subsequent structured `otp.delivery` event records the safe reference and acceptance result. Keys, messages, OTPs, phone numbers, request bodies and raw provider errors are never logged. A successful adapter result includes `channel: "sms"`, indicating the requested transport, not a verified handset receipt.

An immediate rejection now also logs `httpStatus`, allowlisted `providerStatus`, `providerCode` (including exact `DLT-CNT-REJECT`), safe recognized `providerDetails`, and `providerDetailsRedacted`. Free-form/unknown details, echoed secrets and extra response fields are omitted, not dumped. `DLT-CNT-REJECT` yields `reason: "DLT_CONTENT_REJECTED"` and never counts as acceptance, even if HTTP is 200. These provider-only fields do not go to the customer API response. A later asynchronous operator rejection cannot appear in the original send response: trace its reference in Transactional SMS logs or use the read-only report command. This patch does not add automatic polling/retries or fabricate a receipt.

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
   | `failed` | Use the report's numeric error code and provider reference with 2Factor support; fix the relevant account/sender/template/operator issue. `DLT-CNT-REJECT` in a report is now explicitly `failed`, with that exact code and `DLT_CONTENT_REJECTED`, not `unknown`. |
   | `unknown`, `REPORT_NOT_FOUND` or `REPORT_UNAVAILABLE` | No usable report is available. This is **not** evidence of either delivery or failure. Some R1 accounts may not expose their references through the older documented transactional report API. Confirm with 2Factor support; no undocumented endpoint or fake status is used. |
   | `ACCOUNT_MISMATCH` | The command is using a different key from the sending deployment. Check the intended environment privately. No provider request was made. |

The command exits `0` only for a delivered report, `2` for pending/failed/unknown, and `1` for invalid command usage/unexpected local failure. It is an operator diagnostic, not a polling endpoint and does not block customer login while waiting for an SMS receipt. Verification still requires the actual valid OTP.

If the provider reference is `null` with `REFERENCE_UNAVAILABLE`, the success payload did not contain a recognized safe reference. Acceptance is retained, but raw `Details` is deliberately not logged: it might contain a secret or message. Ask support to trace the account and attempted timestamp. References from requests sent **before** this diagnostic change cannot be recovered from old application logs.

Provider diagnostics are also saved on the existing OTP record and expire with that record; they are not a permanent SMS audit archive. Keep deployment logs under the operator's normal restricted-access retention policy. A metadata-storage failure is logged safely and does not trigger a second send or block an otherwise valid code.

### Safe rejection reasons

`AUTH_OR_PERMISSION`, `INSUFFICIENT_BALANCE`, `SENDER_NOT_APPROVED`, `TEMPLATE_REJECTED`, `DLT_CONTENT_REJECTED`, `DLT_CONFIGURATION`, `SERVICE_INACTIVE`, and `PROVIDER_RATE_LIMIT` are allowlisted categories inferred from the send response, not raw messages. `NETWORK_OR_TIMEOUT` is an **unknown** outcome because the provider might have accepted the request before the connection failed. No automatic resend, voice fallback or provider switch is attempted.

For support, provide the provider reference, UTC/IST attempt time, sender/template approval status and numeric delivery-report error if available, through the authenticated provider support channel. Ask them to confirm R1 `TRANS_SMS` account activation, DLT entity/header/content/PE-TM mapping and where that reference is logged. Never send an API key or an OTP.

### Customer experience and security

The login page says **OTP requested** for provider acceptance, includes a support reference, and gives recovery guidance without claiming delivery. Resend timing comes from the server and is stored as an absolute deadline; refresh and mobile tab suspension do not restart it. Successful resend clears the old entered digits; the backend invalidates superseded codes. Concurrent duplicate submissions from the same page are guarded, and resend/verify controls cannot run together. Customer, owner and order-scoped production OTP verification all redeem the code atomically once; a delivery receipt never authorizes login.

## Automated regression checks

```sh
node --test --test-concurrency=1 tests/otpDeliveryDiagnostics.unit.test.js tests/twoFactorTransactional.unit.test.js tests/smsProviders.unit.test.js tests/smsFlows.test.js tests/authRecovery.unit.test.js tests/phoneUtils.test.js tests/env.test.js tests/deploymentAdmin.test.js
```

Provider requests are mocked; no paid SMS/call is made. Database-backed tests use the existing isolated MongoDB test harness. They cover the exact form-encoded API contract, backend OTP preservation, template/ID validation, missing/legacy settings, rejected legacy/unknown modes, auth/HTTP/network failures, no fallback or automatic retry, credential-safe route logging, recovery after configuration repair, customer/admin login, resend cooldown, invalid/reused codes, COD verification and compatibility with other providers.

Frontend regression coverage includes customer/admin login, profile, checkout selection/recovery, error sanitization, support references, duplicate-submit prevention, and restoring the real countdown after refresh/backgrounding.

Regression coverage for the simplified configuration includes byte-for-byte approved Nishaya content, SMS send/resend without optional DLT IDs, rejection of malformed supplied IDs, immediate/later DLT rejection, and secret-safe diagnostics. Local readiness is not a live delivery test. Only the local message template was updated from the latest approval table; no secrets were changed and no SMS was sent.

Simplification validation on 2026-09-28: **91 targeted backend tests passed, 0 failed**. The local read-only `check:otp` reports `ready: true`, `transactional_sms`, and empty missing/invalid lists without DLT IDs. Syntax and whitespace checks passed. Live delivery remains unverified until the corrected message is applied in Render and tested; if it still fails, provider mapping needs confirmation. No production deployment or live SMS test was performed.

Historical baseline from the preceding OTP diagnostics work: six related frontend suites passed 56 tests; broader `auth.test.js` and `codVerification.test.js` had 10 existing `SERVICE_UNAVAILABLE` (503) failures, reproduced against unchanged runtime sources at that time. Those broader/frontend suites were not rerun for this backend-only DLT patch. Targeted mocked tests do not certify live SMS delivery or constitute a full-suite pass.

## Official references

- [2Factor API documentation](https://documenter.getpostman.com/view/301893/TWDamFGh): **Send Transactional SMS > Send Single SMS**, and **Send SMS OTP > Send OTP - Custom OTP**.
- [Legacy manual OTP request](https://2factor.in/API/DOCS/SMS_OTP.html).
- [Transactional SMS service](https://2factor.in/v3/transactional-sms-services).
- [Transactional delivery-report endpoint and XML fields](https://dial2verify.com/corp/support-system/tkt/knowledgebase.php?article=15).
- [2Factor developer portal](https://docs-dev.2factor.in/): describes automatic voice fallback; not evidence of an account-specific no-voice setting.
