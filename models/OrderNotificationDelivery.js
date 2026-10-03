const mongoose = require('mongoose');

// Durable outbox, separate from the customer's notification inbox. Provider
// acceptance is not proof of inbox delivery, so email uses ACCEPTED, not SENT.
const schema = new mongoose.Schema({
  dedupeKey: { type: String, required: true, unique: true },
  order: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', required: true },
  storeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Store' },
  event: { type: String, enum: ['ORDER_PLACED', 'ORDER_CONFIRMED'], required: true },
  channel: { type: String, enum: ['IN_APP', 'EMAIL', 'WHATSAPP'], required: true },
  audience: { type: String, enum: ['ALL', 'CUSTOMER', 'ADMIN'], required: true },
  status: { type: String, enum: ['QUEUED', 'PROCESSING', 'SENT', 'ACCEPTED', 'DELIVERED', 'READ', 'BLOCKED', 'FAILED', 'SKIPPED', 'UNCERTAIN'], default: 'QUEUED' },
  reason: { type: String, default: '' },
  attempts: { type: Number, default: 0 },
  availableAt: { type: Date, default: Date.now },
  leaseUntil: Date,
  leaseToken: String,
  firstAttemptAt: Date,
  ambiguous: { type: Boolean, default: false },
  idempotencyKey: String,
  // Never expose recipient or email contents through delivery diagnostics.
  email: { type: new mongoose.Schema({ to: String, subject: String, htmlContent: String, textContent: String }, { _id: false }), select: false },
  providerMessageId: String,
  whatsappPhoneNumberId: String,
  providerErrorCode: Number,
  completedAt: Date,
}, { timestamps: true });
schema.index({ status: 1, availableAt: 1, leaseUntil: 1 });
schema.index({ storeId: 1, createdAt: -1 });
schema.index({ order: 1 });
schema.index({ channel: 1, providerMessageId: 1 });
schema.index({ idempotencyKey: 1 }, { sparse: true });
module.exports = mongoose.model('OrderNotificationDelivery', schema);
