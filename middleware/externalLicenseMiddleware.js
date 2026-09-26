const Product = require('../models/Product');
const Order = require('../models/Order');
const { ApiError } = require('../utils/apiError');
const { licenseStatus } = require('../services/controlPlaneClient');

const FEATURE_ROUTES = [
  [/^\/(?:admin\/reports|seller\/(?:reports|analytics))/, 'analytics'],
  [/^\/admin\/products\/(?:smart-fill|quick-analyze)/, 'aiProduct'],
  [/^\/admin\/(?:social-imports|reel-imports)/, 'socialImport'],
  [/^\/(?:social|admin\/social|seller\/(?:social|instagram|inbox))/, 'socialStudio'],
  [/^\/(?:admin|seller)\/business\/assistant/, 'businessAssistant'],
  [/^\/(?:admin|seller)\/business\/abandoned-carts/, 'abandonedCart'],
  [/^\/(?:admin|seller)\/business\/customer-offers|^\/seller\/crm/, 'crm'],
  [/^\/(?:admin\/business|seller\/business)\/festival/, 'festival'],
  [/^\/(?:admin\/customization|seller\/design)/, 'advancedCustomization'],
  [/\/delivery(?:\/|$)/, 'shippingAutomation'],
];

function apiPath(req) {
  return String(req.originalUrl || req.url || '').split('?')[0].replace(/^\/api/, '') || '/';
}

function shouldSkip(path) {
  return /^\/(?:platform|master|system)(?:\/|$)/.test(path)
    || /^\/auth(?:\/|$)/.test(path)
    || /^\/social\/(?:webhook|oauth|deauthorize|data-deletion|deletion-status)/.test(path);
}

function isCommerceWrite(method, path) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return false;
  return !/^\/(?:contact|newsletter)(?:\/|$)/.test(path);
}

async function assertCapacity(status, path, method, req) {
  if (method !== 'POST') return;
  const productLimit = Number(status.limits?.products);
  const productCreation = path === '/admin/products' || path === '/seller/products'
    || path === '/admin/product-drafts/publish-selected' || /^\/admin\/(?:social-imports|reel-imports)\/[^/]+\/(?:publish|draft)$/.test(path);
  if (productCreation && Number.isFinite(productLimit)) {
    const current = await Product.countDocuments({ isArchived: { $ne: true } });
    const requested = Array.isArray(req?.body?.ids) ? req.body.ids.length : 1;
    if (current + requested > productLimit) throw new ApiError('PLAN_LIMIT_REACHED', `This plan allows ${productLimit} active products`);
  }
  const orderLimit = Number(status.limits?.ordersPerMonth);
  if (['/orders', '/orders/cod', '/create-order', '/payments/create-order'].includes(path) && Number.isFinite(orderLimit)) {
    const monthStart = new Date(); monthStart.setUTCDate(1); monthStart.setUTCHours(0, 0, 0, 0);
    const current = await Order.countDocuments({ createdAt: { $gte: monthStart }, orderStatus: { $ne: 'Cancelled' } });
    if (current >= orderLimit) throw new ApiError('PLAN_LIMIT_REACHED', `This plan allows ${orderLimit} orders per month`);
  }
}

module.exports = async function externalLicenseMiddleware(req, _res, next) {
  const path = apiPath(req);
  if (shouldSkip(path)) return next();
  if (isCommerceWrite(req.method, path) && !req.user) return next();
  let status;
  try { status = await licenseStatus(); }
  catch (error) {
    if (!isCommerceWrite(req.method, path)) return next();
    return next(error);
  }
  if (!status.managed) return next();
  req.platformLicense = status;
  if (isCommerceWrite(req.method, path) && ['EXPIRED', 'SUSPENDED', 'REVOKED'].includes(status.status)) {
    return next(new ApiError('SUBSCRIPTION_REQUIRED', status.status === 'REVOKED' ? 'This installation has been revoked by the platform owner' : 'Renew the store subscription to make changes and accept orders'));
  }
  const requiredFeature = FEATURE_ROUTES.find(([pattern]) => pattern.test(path))?.[1];
  if (requiredFeature && req.user && !status.features?.includes(requiredFeature)) return next(new ApiError('PLAN_FEATURE_REQUIRED', 'This feature is not included in the current plan'));
  try { await assertCapacity(status, path, req.method, req); return next(); }
  catch (error) { return next(error); }
};
