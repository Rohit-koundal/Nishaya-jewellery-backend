# Courier delivery setup

The application supports Manual courier, Blue Dart, Shiprocket, Delhivery and
Xpressbees behind one server-side provider interface. The active provider is
selected in **Settings → Orders & delivery**. Changing that setting affects new
checkout quotes and new shipment bookings; an existing shipment always keeps
the provider and AWB with which it was created.

Carrier onboarding is still required. The application cannot open a carrier
account, approve COD/reverse pickup, negotiate rates or create production API
credentials. Keep the store on Manual courier until the chosen account has been
validated.

## Security and activation

Add credentials only to `backend/.env` locally or the backend host's secret
environment. Never use `REACT_APP_` variables for courier credentials. The
readiness endpoint returns missing variable names and capability flags, never
their values. Restart the backend after changing its environment.

Production-only providers also require their `*_LIVE_BOOKING_ENABLED=true`
switch. This prevents accidental real AWBs, pickups and charges while an account
is being configured. Delhivery sandbox can be exercised from the admin shipment
screen, but checkout deliberately refuses sandbox providers because they cannot
deliver a customer order.

## Provider environment variables

### Blue Dart

| Variable | Purpose |
| --- | --- |
| `BLUEDART_MODE` | `sandbox` or `production` |
| `BLUEDART_CLIENT_ID`, `BLUEDART_CLIENT_SECRET` | Approved gateway application credentials |
| `BLUEDART_LOGIN_ID`, `BLUEDART_LICENCE_KEY` | Shipping API profile |
| `BLUEDART_JWT_TOKEN` | Optional backend token override |
| `BLUEDART_CUSTOMER_CODE`, `BLUEDART_ORIGIN_AREA` | Registered customer and origin codes |
| `BLUEDART_PRODUCT_CODE`, `BLUEDART_PACK_TYPE`, `BLUEDART_FEATURE` | Account-approved service values |
| `BLUEDART_PICKUP_SUBPRODUCT` | Pickup subproduct, default `E-Tailing`; confirm with Blue Dart |
| `BLUEDART_TRACKING_LICENCE_KEY` | Optional separate tracking licence |
| `BLUEDART_LIVE_BOOKING_ENABLED` | Enable real production booking only after validation |
| `BLUEDART_COD_ENABLED`, `BLUEDART_REVERSE_ENABLED` | Enable only when approved for the account |
| `BLUEDART_REVERSE_FEATURE` | Account-approved reverse service feature |

Blue Dart uses direct PIN serviceability, waybill, label, pickup, cancellation
and tracking APIs. Its public contract does not provide the live rate used by
this integration, so customer pricing must use Fixed or Weight rate-card mode.
Contact and address limits are enforced before booking.

### Shiprocket

| Variable | Purpose |
| --- | --- |
| `SHIPROCKET_EMAIL`, `SHIPROCKET_PASSWORD` | Dedicated Shiprocket API user |
| `SHIPROCKET_PICKUP_LOCATION` | Exact pickup-location name registered in Shiprocket |
| `SHIPROCKET_FALLBACK_EMAIL` | Valid merchant email used where the phone-only store has no customer email |
| `SHIPROCKET_LIVE_BOOKING_ENABLED` | Enables real order, AWB and pickup calls |
| `SHIPROCKET_COD_ENABLED`, `SHIPROCKET_REVERSE_ENABLED` | Account capability switches |
| `SHIPROCKET_COURIER_ID` | Optional fixed courier company ID |
| `SHIPROCKET_PREFERRED_COURIER` | Optional case-insensitive courier-name preference |
| `SHIPROCKET_SELECTION_STRATEGY` | `recommended` (default), `cheapest` or `fastest` |

Shiprocket is an aggregator. The application checks its live courier list for
the route and stores the actual courier name alongside the Shiprocket provider.
If no fixed/preferred courier is configured, the selection strategy is applied.

### Delhivery

| Variable | Purpose |
| --- | --- |
| `DELHIVERY_MODE` | `sandbox` or `production` |
| `DELHIVERY_TOKEN` | Delhivery API token |
| `DELHIVERY_CLIENT_NAME` | Case-sensitive client name issued by Delhivery |
| `DELHIVERY_WAREHOUSE_NAME` | Exact registered warehouse/pickup name |
| `DELHIVERY_LIVE_BOOKING_ENABLED` | Required for production booking |
| `DELHIVERY_COD_ENABLED`, `DELHIVERY_REVERSE_ENABLED` | Account capability switches |
| `DELHIVERY_SHIPPING_MODE` | Account-approved mode, default `Surface` |

Sandbox uses `staging-express.delhivery.com`; production uses
`track.delhivery.com`. Serviceability checks prepaid/COD and pickup flags. Rate
lookup failure does not make a serviceable PIN fail unless Settings uses live
carrier pricing, in which case checkout requires a valid rate.

### Xpressbees

| Variable | Purpose |
| --- | --- |
| `XPRESSBEES_EMAIL`, `XPRESSBEES_PASSWORD` | Xpressbees API user |
| `XPRESSBEES_WAREHOUSE_NAME` | Exact registered warehouse name |
| `XPRESSBEES_LIVE_BOOKING_ENABLED` | Enables real shipment creation |
| `XPRESSBEES_COD_ENABLED`, `XPRESSBEES_REVERSE_ENABLED` | Account capability switches |
| `XPRESSBEES_COURIER_ID` | Optional account courier/service ID |

Xpressbees shipment creation requests automatic pickup. A confirmed response is
therefore saved directly as Pickup Scheduled rather than showing a second pickup
button.

## Store settings and checkout

In **Settings → Orders & delivery**:

1. Choose the provider. Its card shows Ready, Disabled or Setup needed.
2. Enter the registered pickup contact/address and package defaults.
3. Choose Fixed charge, Destination/weight rate card, or Selected courier live
   rate. Live rate is available for Shiprocket, Delhivery and Xpressbees.
4. Configure the free-delivery threshold independently.

Checkout validates the destination PIN, payment mode, parcel weight/dimensions
and the selected provider before an order is confirmed. Provider contract cost
is kept on the backend; the storefront receives only the agreed customer charge,
selected service name and serviceability result. Product packed weights override
the store default. One outer parcel is currently booked per order.

## Fulfilment, tracking and returns

The order remains authoritative in the application's database. From the order's
Courier delivery panel, confirm the packed dimensions and pickup window, create
the shipment, download the original carrier label and request pickup when the
provider does not already request it automatically. AWB, carrier identifiers,
label availability, pickup confirmation and tracking events are saved with the
shipment.

Tracking is refreshed by the backend worker about every 15 minutes while MongoDB
is connected. Customer and admin refreshes are throttled. Confirmed production
events can move the order through Shipped, Out for Delivery and Delivered. COD
delivery never marks payment Paid; collection and remittance remain separate.

After a return is approved, reverse pickup creates a separate reverse shipment.
It does not replace the forward AWB and never auto-approves inspection, restocks
inventory, exchanges goods or refunds payment.

## Uncertain outcomes and cancellation

Write requests are not blindly retried after a timeout. An uncertain booking is
locked for reconciliation to prevent duplicate AWBs. Use **Check booking outcome**
or confirm with the carrier that no request exists before unlocking a retry.
The same rule applies to an uncertain pickup or cancellation.

Courier cancellation must be confirmed before the existing order cancellation
restores inventory or starts refund logic. A parcel already handed to a courier
must follow the return flow. Labels and cancelled AWBs remain in history.

## Provider boundary

`shippingProvider.providerFor()` selects an adapter implementing `readiness`,
`serviceability`, `book`, `pickup`, `cancel` and `track`; Blue Dart additionally
supports pickup cancellation. `deliveryService` owns persistence, locks,
reconciliation, status mapping and polling. `shippingRules` owns package and
customer-price validation. New providers can be added without changing cart,
payment or order storage.

Automated tests must use pure payload/status fixtures. They must never create a
real shipment, pickup, notification or carrier charge.

Official provider documentation:

- Blue Dart business integrations: https://api.bluedart.com/business-integrations
- Shiprocket API: https://www.postman.com/shiprocketdev/shiprocket-dev-s-public-workspace/documentation/qu05zax/shiprocket-api
- Delhivery B2C APIs: https://one.delhivery.com/developer-portal/documents/b2c/
- Xpressbees custom API: https://xb-files.s3.amazonaws.com/assets/custom_api/apidoc_v1.1.5.pdf
