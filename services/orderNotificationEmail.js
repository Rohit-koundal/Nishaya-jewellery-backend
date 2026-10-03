const { getAdminEmail } = require('../config/deploymentAdmin');
const Settings = require('../models/Settings');
const Store = require('../models/Store');
const User = require('../models/User');

const validEmail = value => /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(String(value || ''));
const scopeFor = (storeId, isDefault = false) => isDefault && storeId ? { $or: [{ storeId }, { storeId: null }] } : { storeId: storeId || null };
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const money = value => `INR ${Number(value || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function emailConfiguration() {
  const missing = [];
  if (!String(process.env.BREVO_API_KEY || '').trim()) missing.push('BREVO_API_KEY');
  if (!validEmail(process.env.BREVO_SENDER_EMAIL)) missing.push('BREVO_SENDER_EMAIL');
  return { provider: 'Brevo', configured: !missing.length, missing };
}

async function notificationSettings(storeId) {
  const store = await (storeId ? Store.findById(storeId) : Store.findOne({ isDefault: true })).select('owner isDefault name slug').lean();
  const settings = await Settings.findOne(scopeFor(store?._id || storeId, store?.isDefault)).lean();
  let adminEmail = settings?.orderNotificationEmail || '';
  if (!adminEmail && (!storeId || store?.isDefault)) adminEmail = getAdminEmail();
  if (!adminEmail && store?.owner) {
    const owner = await User.findById(store.owner).select('email isEmailVerified isBlocked').lean();
    if (owner?.isEmailVerified && !owner.isBlocked) adminEmail = owner.email;
  }
  return { settings: settings || {}, adminEmail: validEmail(adminEmail) ? adminEmail : '', store };
}

function orderLink(order, audience, store) {
  try {
    const base = new URL(process.env.FRONTEND_URL);
    if (base.username || base.password || (base.protocol !== 'https:' && !(process.env.NODE_ENV !== 'production' && base.protocol === 'http:'))) return '';
    // A tenant must open its own storefront, never another store's order page.
    if (order.storeId && !store?.isDefault) return ''; // Tenant routing varies; use signed-in order history.
    return new URL(`${audience === 'ADMIN' ? '/admin/orders/detail' : '/order-detail'}?id=${order._id}`, base.origin).href;
  } catch { return ''; }
}

function buildOrderEmail(order, audience, settings = {}, store) {
  const admin = audience === 'ADMIN';
  const brand = String(order.invoiceSeller?.storeName || settings.storeName || store?.name || 'Nishaya Jewellery').replace(/[\r\n]/g, ' ');
  const reference = order.invoiceNumber || String(order._id).slice(-8).toUpperCase();
  const pendingCod = order.paymentMethod === 'COD' && order.codVerification?.status === 'PENDING';
  const heading = admin ? 'New order received' : 'Thank you for your order';
  const intro = pendingCod
    ? (admin ? 'The order is placed. Customer COD verification is still pending; check the order before dispatch.' : 'Your order is placed. Please complete COD verification in your account before we can process it.')
    : (admin ? 'A new order is ready to review in your admin workspace.' : 'Your order has been received. You can follow its progress in My Orders.');
  const payment = order.paymentMethod === 'COD' ? 'Cash on delivery — payment due on delivery' : 'Online payment confirmed';
  const rows = (order.orderItems || []).map(item => {
    const variant = [item.size, item.color].filter(Boolean).join(' / ');
    return `${item.productName || item.name || 'Product'}${variant ? ` (${variant})` : ''} × ${item.quantity} — ${money(Number(item.price) * Number(item.quantity))}`;
  });
  const link = orderLink(order, audience, store);
  const total = money(order.finalAmount);
  const textContent = [brand, heading, `Order ${reference}`, intro, payment, ...rows, `Order total: ${total}`, 'Total includes applicable checkout charges and discounts.', link || (admin ? 'Sign in to your admin workspace to review this order.' : 'Sign in to your account and open My Orders.'), 'This is an automated order update. We will never ask for your OTP or payment PIN.'].join('\n\n');
  return {
    subject: `${admin ? 'New order' : 'Order received'} ${reference} | ${brand}`,
    textContent,
    htmlContent: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;color:#263238;line-height:1.6"><p>${escapeHtml(brand)}</p><h1 style="font-size:24px">${heading}</h1><p><strong>Order ${escapeHtml(reference)}</strong></p><p>${escapeHtml(intro)}</p><p>${escapeHtml(payment)}</p><ul>${rows.map(row => `<li>${escapeHtml(row)}</li>`).join('')}</ul><p><strong>Order total: ${escapeHtml(total)}</strong><br><small>Includes applicable checkout charges and discounts.</small></p>${link ? `<p><a href="${escapeHtml(link)}">${admin ? 'Review order' : 'View your order'}</a></p>` : `<p>Sign in to ${admin ? 'your admin workspace' : 'your account and open My Orders'} for details.</p>`}<hr><small>This is an automated order update. We will never ask for your OTP or payment PIN.</small></div>`,
  };
}

module.exports = { buildOrderEmail, emailConfiguration, notificationSettings, scopeFor, validEmail };
