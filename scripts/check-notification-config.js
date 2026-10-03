#!/usr/bin/env node
const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const { emailConfiguration } = require('../services/orderNotificationEmail');
const { whatsappConfiguration } = require('../services/orderNotificationWhatsapp');
const email = emailConfiguration(), whatsapp = whatsappConfiguration();
console.log(JSON.stringify({ email, whatsapp,
  webhookPath: '/api/notifications/whatsapp/webhook',
  note: 'Local checks only; no message sent. Verify Brevo sender, Meta token access, template approval and webhook subscription, enable channels in Admin > Settings > Order notifications, then test consenting recipients.',
}, null, 2));
if (!email.configured || !whatsapp.configured) process.exitCode = 1;
