require('dotenv').config();
const mqtt = require('mqtt');
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const { Pool } = require('pg');
const express = require('express');

// --- 1. DB INITIALIZATION ---
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 20 });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const app = express();
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`📡 HEMIPAY Gateway active on port ${PORT}`));

// --- 2. HELPER FUNCTIONS ---
// Generates unique message_id as required by the protocol [cite: 5, 39, 67]
const getMsgId = () => Math.floor(Math.random() * 10000000000).toString();
// Generates current Unix timestamp in seconds 
const getTimestamp = () => Math.floor(Date.now() / 1000).toString();

// --- 3. MQTT LOGIC ---
const client = mqtt.connect("mqtt://127.0.0.1:1883", {
  clientId: 'BIZTRACK_MASTER_RELAY'
});

client.on('connect', () => {
  // Subscribing to dynamic device messages [User Protocol Info]
  client.subscribe('+/pubmsg', { qos: 1 });
  console.log("🚀 HEMIPAY Relay Connected. Monitoring +/pubmsg...");
});

client.on('message', async (topic, message) => {
  // Extract Serial Number from Topic (SN/pubmsg) [User Protocol Info]
  const serialNumber = topic.split('/')[0];
  let payload;
  
  try {
    payload = JSON.parse(message.toString());
  } catch (e) { return; }

  console.log(`[REQ] ${serialNumber} requesting NPR ${payload.amount}`);

  try {
    // Database lookup for static QR code
    const device = await prisma.device.findUnique({
      where: { serialNumber: serialNumber },
      include: { user: true }
    });

    if (!device || !device.fonepayMerchantCode) {
      console.error(`❌ Merchant code missing for ${serialNumber}`);
      return;
    }

    const orderId = `ORD-${Date.now()}`; // Unique transaction ID [cite: 43, 64]

    // --- STEP 1: PUSH DYNAMIC QR SCREEN  ---
    const waitPaymentPacket = {
      "message_id": getMsgId(),
      "time_stamp": getTimestamp(),
      "device_sn": serialNumber,
      "packet_type": "wait_payment",
      "content": {
        "amount_due": parseFloat(payload.amount),
        "order_id": orderId,
        "payment_timeout": 60, // Returns to home after 60s 
        "screen_content_config": {
          "wait_payment_screen_qrcode_1_config": {
            "txt": device.fonepayMerchantCode, // QR data [cite: 46]
            "hei": 210 // Max height [cite: 47]
          },
          "wait_payment_screen_label_3_config": {
            "txt": `${payload.amount} NPR`,
            "hei": 24, // Medium font [cite: 54]
            "col": "FF0000" // Red text [cite: 52]
          }
        }
      }
    };

    client.publish(`/LLZN/${serialNumber}`, JSON.stringify(waitPaymentPacket));
    console.log(`[QR_SENT] Pushed wait_payment screen to ${serialNumber}`);

    // --- STEP 2: SIMULATE PAYMENT SUCCESS AFTER 4s ---
    setTimeout(async () => {
      console.log(`🔔 Simulating success for ${serialNumber}...`);

      // Record in Supabase
      await prisma.earningRecord.create({
        data: {
          amount: parseFloat(payload.amount),
          prn: orderId,
          userId: device.userId,
          deviceId: device.id,
          description: `Static QR Payment at ${device.user.businessName}`
        }
      });

      // Send payment announcement and trigger audio [cite: 2, 4, 62]
      const paymentPacket = {
        "message_id": getMsgId(),
        "time_stamp": getTimestamp(),
        "device_sn": serialNumber,
        "packet_type": "payment",
        "content": {
          "play_payment_amount": parseFloat(payload.amount),
          "order_id": orderId // Must match original order_id to clear screen 
        }
      };

      client.publish(`/LLZN/${serialNumber}`, JSON.stringify(paymentPacket));
      console.log(`[PAID] Success command sent to ${serialNumber}`);
    }, 4000);

  } catch (err) {
    console.error(`Relay Error for ${serialNumber}:`, err.message);
  }
});