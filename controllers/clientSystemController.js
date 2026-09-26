const { asyncHandler } = require('../middleware/validate');
const service = require('../services/controlPlaneClient');
const { STORE_PLANS } = require('../config/storePlans');
const Product = require('../models/Product');
const Order = require('../models/Order');

async function localUsage() {
  const monthStart = new Date(); monthStart.setUTCDate(1); monthStart.setUTCHours(0, 0, 0, 0);
  const [products, ordersPerMonth] = await Promise.all([
    Product.countDocuments({ isArchived: { $ne: true } }),
    Order.countDocuments({ createdAt: { $gte: monthStart }, orderStatus: { $ne: 'Cancelled' } }),
  ]);
  return { products, ordersPerMonth };
}

async function sendStatus(res, force) {
  res.setHeader('Cache-Control', 'no-store');
  const status = service.publicStatus(await service.licenseStatus({ force }));
  return res.json({ ...status, plans: status.plans.length ? status.plans : Object.values(STORE_PLANS), usage: status.managed ? await localUsage() : {}, checkout: { configured: status.managed && status.checkoutConfigured } });
}

exports.status = asyncHandler(async (_req, res) => sendStatus(res, false));
exports.refresh = asyncHandler(async (_req, res) => sendStatus(res, true));

exports.checkout = asyncHandler(async (req, res) => res.json(await service.subscriptionCheckout(req.body || {})));
exports.verify = asyncHandler(async (req, res) => {
  const result = await service.subscriptionVerify(req.body || {});
  await service.licenseStatus({ force: true }).catch(() => null);
  res.json(result);
});
