#!/usr/bin/env node
const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
require('dotenv').config();

// Local configuration only. Never print credentials or contact the provider.
const keyId = process.env.RAZORPAY_KEY_ID || '';
const secret = process.env.RAZORPAY_KEY_SECRET || '';
const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET || '';
const missing = ['RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET'].filter(key => !String(process.env[key] || '').trim());
const invalid = [];
if (keyId && !/^rzp_(test|live)_[A-Za-z0-9]+$/.test(keyId)) invalid.push('RAZORPAY_KEY_ID');
if (secret && (secret !== secret.trim() || /^https?:\/\//i.test(secret))) invalid.push('RAZORPAY_KEY_SECRET');
if (webhookSecret && (!webhookSecret.trim() || /^https?:\/\//i.test(webhookSecret.trim()))) invalid.push('RAZORPAY_WEBHOOK_SECRET');
const mock = process.env.RAZORPAY_MOCK === '1';
const configured = missing.length === 0 && !invalid.some(key => key !== 'RAZORPAY_WEBHOOK_SECRET');
const warnings = [];
if (!webhookSecret || invalid.includes('RAZORPAY_WEBHOOK_SECRET')) warnings.push('Set a separate webhook signing secret matching the Razorpay dashboard; a webhook URL is not a secret.');
if (mock) warnings.push('RAZORPAY_MOCK=1 bypasses Razorpay. Remove it before a real test-mode or live checkout.');
if (keyId.startsWith('rzp_test_')) warnings.push('Test mode only: these keys cannot collect real money.');
console.log(JSON.stringify({
  provider: 'Razorpay', configured, missing, invalid,
  mode: keyId.startsWith('rzp_test_') ? 'test' : keyId.startsWith('rzp_live_') ? 'live' : 'unknown',
  mock, webhookConfigured: Boolean(webhookSecret) && !invalid.includes('RAZORPAY_WEBHOOK_SECRET'),
  createOrder: '/api/payments/create-order', verifyPayment: '/api/payments/verify',
  warnings,
  note: 'Local checks only. Enable online payments in admin settings, restart the backend, and complete a Razorpay test checkout to verify credentials and delivery.',
}, null, 2));
if (!configured || invalid.length || mock) process.exitCode = 1;
