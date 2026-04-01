require('dotenv').config();
const mqtt = require('mqtt');
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const { Pool } = require('pg');
const express = require('express');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 20 });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const app = express();
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`📡 HEMIPAY Relay: Active 🚀`));

const getMsgId = () => Math.floor(Math.random() * 10000000000).toString();
const getTimestamp = () => Math.floor(Date.now() / 1000).toString();

const client = mqtt.connect("mqtt://127.0.0.1:1883", {
  clientId: 'BIZTRACK_MASTER_RELAY',
  username: 'aayush',
  password: 'Ankit#2059',
  clean: false
});

client.on('connect', () => {
  client.subscribe('/LLZN/+', { qos: 1 });
  console.log("✅ Server authenticated. Listening for hardware on /LLZN/+");
});

client.on('message', async (topic, message) => {
  // --- 1. ROBUST TOPIC PARSING ---
  // If topic is "/LLZN/2602270002", this filters out empty parts and finds the SN
  const topicParts = topic.split('/').filter(p => p && p !== 'LLZN');
  const serialNumber = topicParts[0]; 

  // --- 2. DEBUG PAYLOAD ---
  let payload;
  try {
    payload = JSON.parse(message.toString());
    console.log(`--- RAW DATA FROM ${serialNumber} ---`);
    console.log(payload); // This will show us the real keys (amount? money? amt?)
  } catch (e) { 
    console.error("❌ Received non-JSON message");
    return; 
  }

  // Handle case where "amount" might be nested or named differently
  const amount = payload.amount || payload.pay_amount || payload.money;

  if (!serialNumber || !amount) {
    console.error(`⚠️ Missing data. SN: ${serialNumber}, Amount: ${amount}`);
    return;
  }

  console.log(`[REQ] ${serialNumber} requesting QR for NPR ${amount}`);

  try {
    const device = await prisma.device.findUnique({
      where: { serialNumber: serialNumber },
      include: { user: true }
    });

    if (!device) {
      console.error(`❌ Device ${serialNumber} not found in database.`);
      return;
    }

    const orderId = `ORD-${Date.now()}`;

    // --- STEP 1: PUSH QR (Wait Payment) ---
    const waitPaymentPacket = {
      "message_id": getMsgId(), // [cite: 27, 94]
      "time_stamp": getTimestamp(), // [cite: 29, 96]
      "device_sn": serialNumber, // [cite: 30, 97]
      "packet_type": "wait_payment", // [cite: 175, 204]
      "content": {
        "amount_due": parseFloat(amount), // [cite: 177, 206]
        "order_id": orderId, // [cite: 178, 207]
        "payment_timeout": 60, // [cite: 179, 208]
        "screen_content_config": {
          "wait_payment_screen_qrcode_1_config": {
            "txt": device.fonepayMerchantCode, // [cite: 186, 212]
            "hei": 210 // [cite: 189, 213]
          },
          "wait_payment_screen_label_3_config": {
            "txt": `${amount} NPR`, // [cite: 191, 229]
            "hei": 24, // Medium font [cite: 232]
            "col": "FF0000" // Red [cite: 245]
          }
        }
      }
    };

    client.publish(`${serialNumber}/pubmsg`, JSON.stringify(waitPaymentPacket));
    console.log(`[QR_SENT] Pushed to ${serialNumber}/pubmsg`);

    // --- STEP 2: SIMULATED SUCCESS (4s) ---
    setTimeout(async () => {
      console.log(`🔔 Simulating success for ${serialNumber}...`);

      const paymentPacket = {
        "message_id": getMsgId(), // [cite: 18, 256]
        "time_stamp": getTimestamp(), // [cite: 19, 257]
        "device_sn": serialNumber, // [cite: 20, 258]
        "packet_type": "payment", // [cite: 21, 259]
        "content": {
          "play_payment_amount": parseFloat(amount), // [cite: 23, 261]
          "order_id": orderId // Must match wait_payment [cite: 262, 268]
        }
      };

      client.publish(`${serialNumber}/pubmsg`, JSON.stringify(paymentPacket));
    }, 4000);

  } catch (err) {
    console.error(`Relay Error:`, err.message);
  }
});