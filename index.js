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
app.listen(PORT, '0.0.0.0', () => console.log(`📡 BIZTRACK HEMIPAY Relay: Online 🚀`));

// Protocol Helpers [cite: 27, 29, 30]
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
  console.log("✅ Server authenticated. Monitoring /LLZN/+");
});

client.on('message', async (topic, message) => {
  // Extract SN from topic like "/LLZN/2602270002" [cite: 30]
  const topicParts = topic.split('/').filter(p => p && p !== 'LLZN');
  const serialNumber = topicParts[0]; 

  let payload;
  try {
    payload = JSON.parse(message.toString());
  } catch (e) { return; }

  // --- THE FIX: Accessing the nested 'content' object ---
  // Per your RAW DATA: { content: { amount_due: 50 } } [cite: 176, 177]
  const amount = payload.content ? payload.content.amount_due : null;

  if (!serialNumber || amount === null) {
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
      console.error(`❌ Device ${serialNumber} not in Supabase.`);
      return;
    }

    const orderId = `ORD-${Date.now()}`; // [cite: 178, 207]

    // --- STEP 1: PUSH QR (wait_payment) [cite: 155, 175] ---
    const waitPaymentPacket = {
      "message_id": getMsgId(), // [cite: 172, 200]
      "time_stamp": getTimestamp(), // [cite: 173, 202]
      "device_sn": serialNumber, // [cite: 174, 203]
      "packet_type": "wait_payment", // [cite: 175, 204]
      "content": {
        "amount_due": parseFloat(amount), // 
        "order_id": orderId, // [cite: 178, 207]
        "payment_timeout": 60, // [cite: 179, 208]
        "screen_content_config": {
          "wait_payment_screen_qrcode_1_config": {
            "txt": device.fonepayMerchantCode, // [cite: 184, 212]
            "hei": 210 // [cite: 189, 213]
          },
          "wait_payment_screen_label_3_config": {
            "txt": `${amount} NPR`, // [cite: 191, 229]
            "hei": 24, // [cite: 193, 232]
            "col": "FF0000" // [cite: 194, 222]
          }
        }
      }
    };

    client.publish(`${serialNumber}/pubmsg`, JSON.stringify(waitPaymentPacket));
    console.log(`[QR_SENT] Pushed to ${serialNumber}/pubmsg`);

    // --- STEP 2: SUCCESS SIMULATION (4s) [cite: 252, 253] ---
    setTimeout(async () => {
      console.log(`🔔 Simulating success for ${serialNumber}...`);

      const paymentPacket = {
        "message_id": getMsgId(), // [cite: 256, 300]
        "time_stamp": getTimestamp(), // [cite: 257, 302]
        "device_sn": serialNumber, // [cite: 258, 303]
        "packet_type": "payment", // [cite: 259, 266]
        "content": {
          "play_payment_amount": parseFloat(amount), // [cite: 261, 267]
          "order_id": orderId // [cite: 262, 268]
        }
      };

      client.publish(`${serialNumber}/pubmsg`, JSON.stringify(paymentPacket));
    }, 4000);

  } catch (err) {
    console.error(`Relay Error:`, err.message);
  }
});