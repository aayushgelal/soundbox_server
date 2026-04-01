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
const getMsgId = () => Math.floor(Math.random() * 10000000000).toString();
const getTimestamp = () => Math.floor(Date.now() / 1000).toString();

// --- 3. MQTT LOGIC WITH AUTHENTICATION ---
const client = mqtt.connect("mqtt://127.0.0.1:1883", {
  clientId: 'BIZTRACK_MASTER_RELAY',
  username: 'aayush',       // Added
  password: 'Ankit#2059',   // Added
  clean: false
});

client.on('connect', () => {
  // Subscribe to device messages (SN/pubmsg)
  client.subscribe('+/pubmsg', { qos: 1 });
  console.log("✅ HEMIPAY Relay Connected with Auth. Monitoring +/pubmsg...");
});

client.on('message', async (topic, message) => {
  const serialNumber = topic.split('/')[0];
  let payload;
  
  try {
    payload = JSON.parse(message.toString());
  } catch (e) { return; }

  console.log(`[REQ] ${serialNumber} requesting NPR ${payload.amount}`);

  try {
    const device = await prisma.device.findUnique({
      where: { serialNumber: serialNumber },
      include: { user: true }
    });

    if (!device || !device.fonepayMerchantCode) {
      console.error(`❌ Merchant code missing for ${serialNumber}`);
      return;
    }

    const orderId = `ORD-${Date.now()}`;

    // --- STEP 1: PUSH DYNAMIC QR SCREEN ---
    const waitPaymentPacket = {
      "message_id": getMsgId(),
      "time_stamp": getTimestamp(),
      "device_sn": serialNumber,
      "packet_type": "wait_payment",
      "content": {
        "amount_due": parseFloat(payload.amount),
        "order_id": orderId,
        "payment_timeout": 60,
        "screen_content_config": {
          "wait_payment_screen_qrcode_1_config": {
            "txt": device.fonepayMerchantCode,
            "hei": 210 
          },
          "wait_payment_screen_label_3_config": {
            "txt": `${payload.amount} NPR`,
            "hei": 24,
            "col": "FF0000"
          }
        }
      }
    };

    client.publish(`/LLZN/${serialNumber}`, JSON.stringify(waitPaymentPacket));
    console.log(`[QR_SENT] Pushed to /LLZN/${serialNumber}`);

    // --- STEP 2: SIMULATE PAYMENT SUCCESS AFTER 4s ---
    setTimeout(async () => {
      console.log(`🔔 Simulating success for ${serialNumber}...`);

      await prisma.earningRecord.create({
        data: {
          amount: parseFloat(payload.amount),
          prn: orderId,
          userId: device.userId,
          deviceId: device.id,
          description: `Static QR Payment at ${device.user.businessName}`
        }
      });

      const paymentPacket = {
        "message_id": getMsgId(),
        "time_stamp": getTimestamp(),
        "device_sn": serialNumber,
        "packet_type": "payment",
        "content": {
          "play_payment_amount": parseFloat(payload.amount),
          "order_id": orderId 
        }
      };

      client.publish(`/LLZN/${serialNumber}`, JSON.stringify(paymentPacket));
      console.log(`[PAID] Success command sent to /LLZN/${serialNumber}`);
    }, 4000);

  } catch (err) {
    console.error(`Relay Error:`, err.message);
  }
});

client.on('error', (err) => {
  console.error("❌ MQTT Connection Error:", err);
});