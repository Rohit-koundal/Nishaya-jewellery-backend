# 2Factor: configurable SMS delivery modes

## Current support-directed message configuration (2026-09-28)

The owner reports that 2Factor support instructed them to use the following exact message for SMS delivery, and explicitly requested that it be applied unchanged. This supersedes the earlier Nishaya-worded message for this installation:

```text
[HELLO] Your OTP for Phone
Verification is XXXX. Valid for 5 mins
-[Southern Express]
```

The local `.env` had this text in `TWOFACTOR_SMS_TEMPLATE`, but selected `sms_otp` (the `otp_sms` alias). That mode sends only the OTP/template name, not the configured full message. In addition, the pasted text still used literal `XXXX`, whereas the transactional adapter requires `{otp}`. The local configuration now selects the existing full-message transactional route and substitutes only that placeholder; brackets, casing, words, line breaks and `Southern Express` are retained as instructed. The existing `NISHAY` sender and API key are unchanged. No DLT IDs are invented. Existing `OTP_EXPIRY_MINUTES=5` matches the stated validity.

Local `.env` (quoted multiline value is supported by the existing dotenv loader):

```dotenv
TWOFACTOR_DELIVERY_MODE=transactional_sms
TWOFACTOR_SMS_SENDER_ID=NISHAY
TWOFACTOR_SMS_TEMPLATE="[HELLO] Your OTP for Phone
Verification is {otp}. Valid for 5 mins
-[Southern Express]"
OTP_EXPIRY_MINUTES=5
```

For Render, set `TWOFACTOR_DELIVERY_MODE` to `transactional_sms` and paste the following **three-line value without surrounding quotes** into `TWOFACTOR_SMS_TEMPLATE`. Keep the API key and sender unchanged, and ensure `OTP_EXPIRY_MINUTES=5`:

```text
[HELLO] Your OTP for Phone
Verification is {otp}. Valid for 5 mins
-[Southern Express]
```

Restart locally or save/redeploy the Render backend after updating its environment. `.env` is git-ignored: committing tests/docs does not apply local configuration to Render. Inactive OTP-mode template-name/confirmation fields can remain; they are ignored by transactional mode. The dynamic provider code, authentication, resend and verification logic are unchanged. A mocked regression test checks the exact outgoing R1 `TRANS_SMS` form, decoded message bytes, unchanged sender, and no retries or secrets in logs. No real SMS/call or production change was performed. Provider delivery must still be checked with one authorized handset test and the corresponding **Transactional SMS** delivery log; no outcome is claimed from the support message or local readiness alone.

Validation for this configuration update: **111 targeted backend tests passed, 0 failed**; syntax and whitespace checks passed. The read-only local readiness check reports `transactional_sms`, `ready: true`, and empty `missing`/`invalid` lists. A separate local assertion confirms the exact three-line template and five-minute expiry without making network requests.

## What is fixed, and what is not

The adapter supports two explicitly selected SMS products. It resolves the mode and its configuration from the backend environment on every send/resend; it never caches another mode's settings or automatically switches transports after a failure.

| Backend delivery mode | Provider request | Mode-specific required settings | Dashboard logs |
| --- | --- | --- | --- |
| `transactional_sms` (unchanged default) | `POST /API/R1/`, `module=TRANS_SMS` | Approved sender and full message with one `{otp}` placeholder | Transactional SMS |
| `otp_sms` (`sms_otp` alias) | `GET /API/V1/{key}/SMS/{phone}/{otp}/{templateName}` | Approved SMS OTP template name and explicit SMS-only account confirmation | SMS OTP |

Both modes retain backend-generated six-digit OTPs and existing local verification, expiry, cooldown and single-use protection. There is no AUTOGEN, provider-side verification, voice endpoint, automatic retry or cross-mode/provider fallback. Mode selection is server-side only, not controlled by the customer's request. Provider acceptance is not handset delivery. This change does not deploy anything or edit production configuration.

## Approval gate -- do this before changing production

**The SMS OTP API name does not itself guarantee no calls.** The public developer portal describes automatic voice fallback, and the documented manual OTP request provides no verified no-voice parameter. Before enabling `otp_sms`, get 2Factor to confirm that automatic voice fallback is disabled for this account/route. An approved OTP template alone does not establish that.

Ask 2Factor support, using the authenticated dashboard:

> We use the SMS OTP product with approved template NISHAYA_VERIFY and manually generated six-digit OTPs. Users previously received voice calls. Please disable automatic voice fallback for our account and confirm that the documented manual SMS OTP endpoint will use SMS only, including when delivery is delayed or fails. Please trace the affected session IDs and confirm template activation and the appropriate SMS OTP balance.

`TWOFACTOR_OTP_SMS_ONLY_CONFIRMED` is a local operator attestation, **not a 2Factor API flag**. It cannot disable provider calls or independently verify an account setting. Until provider confirmation is obtained, leave it unset/false; `otp_sms` deliberately fails configuration validation before making any provider request. If 2Factor cannot offer SMS-only delivery on that route, do not mark it confirmed. Use `transactional_sms` only with that separate product's approvals and provider-confirmed delivery behavior.

The API key or wallet balance alone does not demonstrate those approvals. Do not invent a sender ID/template or copy sample identifiers. Do not paste secrets, phone numbers or OTPs into support screenshots or ordinary application logs. Rotate previously exposed API keys through the provider and update the backend secret store.

## Backend configuration

Common settings in the **Nishaya backend** hosting environment:

```dotenv
OTP_MODE=production
SMS_PROVIDER=2factor
TWOFACTOR_API_KEY=<current-private-provider-key>
```

For the approved **SMS OTP** template shown in the dashboard:

```dotenv
TWOFACTOR_DELIVERY_MODE=otp_sms
TWOFACTOR_TEMPLATE_NAME=NISHAYA_VERIFY
# Keep false until 2Factor confirms SMS-only delivery; then explicitly set true.
TWOFACTOR_OTP_SMS_ONLY_CONFIRMED=false
```

The `false` example is intentionally not ready for sending. With provider confirmation recorded as `true`, this mode needs no local sender, full-message or DLT-ID fields. 2Factor selects the approved sender/content using the template name. The app sends its existing six-digit OTP as the manual OTP value, not the literal `XXXX`, and does not rewrite the provider's message.

For **Transactional SMS**, instead choose:

```dotenv
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
- `TWOFACTOR_TEMPLATE_NAME` applies only to `otp_sms`; it is neither a full message nor a numeric DLT Content Template ID. `TWOFACTOR_SMS_TEMPLATE` and sender/DLT fields apply only to `transactional_sms`. Inactive-mode settings do not affect readiness or the outgoing request.
- `SMS_REQUEST_TIMEOUT_MS` remains supported (15 seconds by default, bounded to 1-30 seconds). A timeout does not trigger another send because the first message may already have been accepted.
- Only Indian mobile numbers are supported by this adapter. Input normalization, expiry, attempt limits, and owner verification requirements are preserved.

Unset/blank `TWOFACTOR_DELIVERY_MODE` defaults to `transactional_sms` for existing installations. `sms_otp` normalizes to `otp_sms`; case and surrounding whitespace are normalized. Ambiguous `otp`, unknown values, `voice`, `auto`, and `sms_only` fail closed. Missing/invalid selected-mode settings return `OTP_PROVIDER_NOT_CONFIGURED` without sending or falling back.

Configuration is read from `process.env`, not continuously reloaded from `.env`. Restart the backend after local `.env` edits; save/redeploy the backend after Render environment changes. Inherited Render env values take precedence over dotenv files. No code edit, migration or frontend deployment is needed to switch supported modes. Already-issued OTPs remain locally verifiable regardless of a subsequent mode change; resends use the newly selected mode while retaining the existing cooldown and invalidating superseded codes.

## DLT-CNT-REJECT investigation (2026-09-28)

The reported `DLT-CNT-REJECT` is a delivery-time content rejection, not evidence of a voice request. The latest screenshot also establishes a product mismatch: `NISHAYA_VERIFY` is approved under **SMS OTP > OTP Templates**, while the backend previously supported only the separate `TRANS_SMS` product. Earlier outgoing wording differed from the latest approved message as well. SMS OTP approval cannot be assumed to authorize an R1 transactional message, even with identical wording. The precise operator mapping failure still requires the provider's delivery trace; it is not proven solely by an HTTP 200 or missing IDs.

Missing IDs are **not a proven cause of the operator rejection**. The official API permits omission, and the actual provider-side entity/header/content mapping is not available locally. Exact content can still be rejected if the operator is validating a different/unmapped template. Removing a local configuration gate does not resolve `DLT-CNT-REJECT`: 2Factor must confirm/fix the existing sender/content mapping or provide a documented provider-managed, SMS-only alternative. Do not start another registration solely because the IDs are absent locally. Only test fixtures, not real DLT IDs, are present in the inspected repository/local configuration.

Only if 2Factor confirms that the same content is approved/mapped for **Transactional SMS**, its full-message configuration would be (no surrounding quotes in Render):

```dotenv
TWOFACTOR_SMS_SENDER_ID=NISHAY
TWOFACTOR_SMS_TEMPLATE={otp} is your OTP to verify your phone number at Nishaya Jewellery. Please do not share this OTP with anyone.
```

For that transactional configuration only, the approved `XXXX` placeholder becomes the application's `{otp}` marker. All other characters stay unchanged. In `otp_sms`, configure `TWOFACTOR_TEMPLATE_NAME=NISHAYA_VERIFY` instead; the name is passed to the documented SMS OTP endpoint, not as `msg` or `ctid`. There is no hardcoded live sender, message, template name or ID in runtime code.

No extra mandatory DLT variables are added. If 2Factor supplies explicit mapping IDs for R1, configure them in the backend environment only. Otherwise ask support to resolve any continuing rejection against the existing entry and request reference. No local `.env` or production environment was changed by the dynamic-mode patch.

The manual SMS OTP transport is now available as an explicit opt-in with the confirmation guard above. It has not been enabled on Render or tested with a real handset. No invented `sms_only`, `no_voice`, or AUTOGEN variant is sent to the provider.

### Inspected execution/configuration map

| Files | Role / finding |
| --- | --- |
| `server.js`, `config/env.js` | Load `backend/.env`, then cwd `.env`, with dotenv's default `override: false`; inherited Render environment wins, even if set to an empty string. `OTP_MODE` must be explicitly `production` (default is demo). |
| `routes/authRoutes.js`, `controllers/authController.js` | Send and resend share `sendOtp`; phone-change verification shares the same SMS sender. Production failure invalidates the unsent code rather than falling back. Rate limits/cooldown remain unchanged. |
| `services/otpService.js`, `models/Otp.js`, `utils/phoneUtils.js` | Backend creates/hashes/expires/consumes the six-digit OTP. Indian numbers normalize to ten subscriber digits; R1 sends `91` + digits, manual SMS OTP uses URL-encoded `+91` + digits. No provider verification/voice endpoint is called. |
| `services/smsService.js`, `services/providers/smsProviderRegistry.js` | Resolve the selected provider from `SMS_PROVIDER` at call time. `2factor`, `twofactor`, `two-factor` select the same adapter. Other installed providers are not fallback routes. |
| `services/providers/smsProviderUtils.js`, `services/providers/twoFactorProvider.js` | Read selected-mode settings at send time; missing/invalid settings fail before network. Exactly one documented mode-specific request, no retry/redirect. R1 preserves message whitespace; manual OTP uses the approved template name. |
| `services/otpDeliveryDiagnostics.js`, `services/providers/twoFactorDeliveryReport.js` | Safe acceptance/rejection logs retain the mode chosen at send time. `/API/V1/.../RPT/TSMS/...` is a read-only transactional report endpoint; the report tool blocks other modes rather than inventing an OTP report API. |
| `scripts/check-otp-config.js`, `scripts/check-otp-delivery.js` | Local readiness and optional read-only provider report tools; neither sends a code. Config check mirrors backend dotenv loading. |
| `services/codVerificationService.js`, `controllers/orderController.js`, `routes/orderRoutes.js` | Order verification shares SMS sending. Inspected only; no order/controller/auth changes in this patch. |
| `services/emailService.js`, `services/clientHandoverService.js` | Separate email OTP transport and provider readiness consumer; unchanged. |
| `src/context/AuthContext.jsx`, `src/store/apiSlice.js`, `src/services/api.js`, `src/utils/loginOtpStorage.js`, customer `Login.jsx`, `ProfileDetails.jsx`, `Checkout.jsx`, `OrderDetail.jsx`, admin `AdminLogin.jsx` | Frontend callers/OTP UI inspected for request paths; no frontend changes in this patch. |

The dynamic-mode patch changes only the 2Factor adapter, its safe readiness/diagnostic/report tooling, tests and configuration documentation. No authentication/controller, OTP lifetime, verification, frontend, order or other provider transport code is modified.

## Deployment and controlled verification

1. Verify the chosen product's configuration **before changing production**. For `otp_sms`, obtain the SMS-only provider confirmation first. Existing OTP records remain compatible; no data migration is needed.
2. Deploy the **backend only**, save the selected mode's environment settings and restart/redeploy. No new dependencies, frontend build or mandatory DLT IDs. Never place keys in frontend variables. Deployment alone does not resolve provider rejection or disable provider voice fallback.
3. From that backend environment run `npm run check:otp` (`npm.cmd` in PowerShell if needed). It makes no network requests or sends. Expect `provider: "2factor"`, the selected `deliveryMode`, `ready: true`, and empty `missing`/`invalid` arrays only after configuration is complete. Both supported modes appear in `supportedDeliveryModes`. This checks local configuration, not account approval, balance, credentials, voice settings or handset delivery.
4. With the recipient's consent, request one OTP and confirm it arrives as **SMS** with the approved sender and correct code. Inspect **SMS OTP** logs for `otp_sms`, or **Transactional SMS** logs for `transactional_sms`. Provider acceptance alone is not proof of delivery.
5. Verify the received code, resend after the existing cooldown, and check both customer and owner/admin login. Check COD/phone-change verification if used. Do not repeatedly send test OTPs after a timeout; check the provider logs first.
6. Confirm no call accompanies the test. If a call occurs in OTP mode, withdraw the local confirmation (`false`) and escalate the selected route's trace to 2Factor. Do not claim the issue is solved or add an undocumented API flag. No automatic mode switch is performed.

Before each provider request the backend logs `[2Factor] deliveryMode:` with the normalized selected mode. A structured `otp.delivery` event records that same mode, safe reference and acceptance result, even if environment settings change while the request is in flight. Keys, messages, OTPs, phone numbers, request bodies, sensitive OTP request URLs and raw provider errors are never logged. A successful result's `channel: "sms"` means the requested transport, not a verified handset receipt.

An immediate rejection now also logs `httpStatus`, allowlisted `providerStatus`, `providerCode` (including exact `DLT-CNT-REJECT`), safe recognized `providerDetails`, and `providerDetailsRedacted`. Free-form/unknown details, echoed secrets and extra response fields are omitted, not dumped. `DLT-CNT-REJECT` yields `reason: "DLT_CONTENT_REJECTED"` and never counts as acceptance, even if HTTP is 200. These provider-only fields do not go to the customer API response. A later asynchronous operator rejection cannot appear in the original send response: trace its reference in the selected product's dashboard logs, or use the read-only report command for transactional references only. This patch does not add automatic polling/retries or fabricate a receipt.

Setting `otp` does **not** select a supported mode. Use the explicit documented mode and its required configuration. Do not enable demo OTP or bypass the confirmation guard to get around provider failures.

## Trace an accepted request that never reaches the phone

1. In the browser, inspect the response to the actual live `/api/auth/send-otp` request. `otpMode: production` and `deliveryStatus: accepted` mean the provider accepted the request, not that the phone received it. The response includes an opaque `supportReference`; the login page displays it beside the help link. No provider reference, account identifier or credential is sent to the customer.
2. Search **the matching backend deployment's logs** for that `supportReference` and `event: otp.delivery`. The event contains `providerReference`, `accountFingerprint`, `status`, optional `reason`, UTC `attemptedAt`, and duration. A separate HTTP `requestId` is an application correlation ID, not the provider reference. HTTP `level: warn` can simply mean a slow request.
3. Run `npm run check:otp` in that backend environment. Its fingerprint should match the delivery event; a local `.env` result does not prove Render uses the same key. Privately confirm the provider dashboard belongs to that key/account. Never paste the key into support messages or command arguments. Check the **log matching the event's delivery mode** with the matching date/time and cleared filters. After switching modes, older references still belong to their original product.
4. For **transactional references only**, while configured in transactional mode, use the captured reference for a read-only report lookup. For OTP-mode references use SMS OTP dashboard logs instead; this tool does not support OTP delivery reports:

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
   | `REPORT_MODE_UNSUPPORTED` | Backend is not configured for transactional SMS. No provider request was made; use the dashboard log for the original sending mode. |

The command exits `0` only for a delivered report, `2` for pending/failed/unknown, and `1` for invalid command usage/unexpected local failure. It is an operator diagnostic, not a polling endpoint and does not block customer login while waiting for an SMS receipt. Verification still requires the actual valid OTP.

If the provider reference is `null` with `REFERENCE_UNAVAILABLE`, the success payload did not contain a recognized safe reference. Acceptance is retained, but raw `Details` is deliberately not logged: it might contain a secret or message. Ask support to trace the account and attempted timestamp. References from requests sent **before** this diagnostic change cannot be recovered from old application logs.

Provider diagnostics are also saved on the existing OTP record and expire with that record; they are not a permanent SMS audit archive. Keep deployment logs under the operator's normal restricted-access retention policy. A metadata-storage failure is logged safely and does not trigger a second send or block an otherwise valid code.

### Safe rejection reasons

`AUTH_OR_PERMISSION`, `INSUFFICIENT_BALANCE`, `SENDER_NOT_APPROVED`, `TEMPLATE_REJECTED`, `DLT_CONTENT_REJECTED`, `DLT_CONFIGURATION`, `SERVICE_INACTIVE`, and `PROVIDER_RATE_LIMIT` are allowlisted categories inferred from the send response, not raw messages. `NETWORK_OR_TIMEOUT` is an **unknown** outcome because the provider might have accepted the request before the connection failed. No automatic resend, voice fallback or provider switch is attempted.

For support, provide the selected mode, provider reference, UTC/IST attempt time, template approval status and safe delivery error through the authenticated provider support channel. For R1 ask about transactional activation and DLT mapping; for OTP mode ask about template activation and SMS-only account routing. Never send an API key or an OTP.

### Customer experience and security

The login page says **OTP requested** for provider acceptance, includes a support reference, and gives recovery guidance without claiming delivery. Resend timing comes from the server and is stored as an absolute deadline; refresh and mobile tab suspension do not restart it. Successful resend clears the old entered digits; the backend invalidates superseded codes. Concurrent duplicate submissions from the same page are guarded, and resend/verify controls cannot run together. Customer, owner and order-scoped production OTP verification all redeem the code atomically once; a delivery receipt never authorizes login.

## Automated regression checks

```sh
node --test --test-concurrency=1 tests/twoFactorModes.unit.test.js tests/otpDeliveryDiagnostics.unit.test.js tests/twoFactorTransactional.unit.test.js tests/smsProviders.unit.test.js tests/smsFlows.test.js tests/authRecovery.unit.test.js tests/phoneUtils.test.js tests/env.test.js tests/deploymentAdmin.test.js
```

Provider requests are mocked; no paid SMS/call is made. Database-backed tests use the existing isolated MongoDB test harness. They cover the exact form-encoded API contract, backend OTP preservation, template/ID validation, missing/legacy settings, rejected legacy/unknown modes, auth/HTTP/network failures, no fallback or automatic retry, credential-safe route logging, recovery after configuration repair, customer/admin login, resend cooldown, invalid/reused codes, COD verification and compatibility with other providers.

Frontend regression coverage includes customer/admin login, profile, checkout selection/recovery, error sanitization, support references, duplicate-submit prevention, and restoring the real countdown after refresh/backgrounding.

Dynamic-mode coverage includes switching modes without re-importing the adapter, selected-mode validation, the explicit confirmation guard, exact manual OTP URL with backend-generated code, alias normalization, in-flight diagnostic consistency, unsupported report modes, provider failures without retry/fallback, and secret-safe logging. Integration tests switch modes in both directions between send/resend, preserve cooldown, reject superseded/reused codes, ignore customer-supplied mode overrides and verify the current code locally even if provider configuration later becomes invalid. Existing transactional content/DLT tests remain in place.

Dynamic-mode validation on 2026-09-28: **109 targeted backend tests passed, 0 failed**. Changed JavaScript syntax and diff whitespace checks passed. No real `.env`, secret, database migration or production deployment was changed. Live SMS delivery and provider-side no-voice behavior remain unverified; mock tests cannot certify them.

Historical baseline from the preceding OTP diagnostics work: six related frontend suites passed 56 tests; broader `auth.test.js` and `codVerification.test.js` had 10 existing `SERVICE_UNAVAILABLE` (503) failures, reproduced against unchanged runtime sources at that time. Those broader/frontend suites were not rerun for this backend-only dynamic-mode patch. Targeted mocked tests do not certify live SMS delivery or constitute a full-suite pass.

## Official references

- [2Factor API documentation](https://documenter.getpostman.com/view/301893/TWDamFGh): **Send Single SMS**, and **Send OTP ( Manual Generation )**.
- [Legacy manual OTP request](https://2factor.in/API/DOCS/SMS_OTP.html).
- [Transactional SMS service](https://2factor.in/v3/transactional-sms-services).
- [Transactional delivery-report endpoint and XML fields](https://dial2verify.com/corp/support-system/tkt/knowledgebase.php?article=15).
- [2Factor developer portal](https://docs-dev.2factor.in/): describes automatic voice fallback; not evidence of an account-specific no-voice setting.
