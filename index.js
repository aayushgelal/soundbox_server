require('dotenv').config(); // Load environment variables first
const mqtt = require('mqtt');
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const { Pool } = require('pg');
const express = require('express');

// --- 1. DATABASE INITIALIZATION (Supabase via Prisma 7) ---
const pool = new Pool({ 
  connectionString: process.env.DATABASE_URL, 
  max: 20 // Optimized for concurrent device requests
});
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

// --- 2. WEB INTERFACE (Health Checks) ---
const app = express();
const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('BizTrack HEMIPAY Relay: Online 🚀'));
app.listen(PORT, '0.0.0.0', () => console.log(`📡 Web Gateway active on port ${PORT}`));

// --- 3. PROTOCOL UTILITIES (Per V1.1 Specs) ---
/**
 * Generates a unique message_id. 
 * Required: Each command must have a different ID or device ignores it.
 */
const generateMsgId = () => Math.floor(Math.random() * 10000000000).toString();

/**
 * Generates Unix standard timestamp.
 * Required: Accurate to seconds only[cite: 29, 96].
 */
const getUnixTimestamp = () => Math.floor(Date.now() / 1000).toString();

// --- 4. MQTT CONNECTION (With Oracle Auth) ---
const client = mqtt.connect("mqtt://127.0.0.1:1883", {
  clientId: 'BIZTRACK_MASTER_RELAY',
  username: 'aayush',
  password: 'Ankit#2059',
  clean: false // Maintain session persistence
});

client.on('connect', () => {
  // SERVER LISTENS to /LLZN/{SN} as per manufacturer default publish topic
  client.subscribe('/LLZN/+', { qos: 1 });
  console.log("✅ Authenticated & Listening for HEMIPAY requests on /LLZN/+");
});

client.on('message', async (topic, message) => {
  const serialNumber = topic.split('/')[2]; // Extracts SN from /LLZN/2602270002
  let payload;
  
  try {
    payload = JSON.parse(message.toString());
  } catch (e) { return; }

  console.log(`[REQ] Device ${serialNumber} requesting QR for NPR ${payload.amount}`);

  try {
    // Validate device and fetch Static QR from Supabase
    const device = await prisma.device.findUnique({
      where: { serialNumber: serialNumber },
      include: { user: true }
    });

    if (!device || !device.fonepayMerchantCode) {
      console.error(`❌ Authorization Failed: Device ${serialNumber} not in DB.`);
      return;
    }

    // Generate a unique Order ID for this transaction [cite: 178, 207]
    const currentOrderId = `ORD-${Date.now()}`;

    // --- STEP 1: PUSH DYNAMIC QR (wait_payment) ---
    // Target topic: {SN}/pubmsg (where device subscribes)
    const waitPaymentPacket = {
      "message_id": generateMsgId(), // [cite: 172]
      "time_stamp": getUnixTimestamp(), // [cite: 173]
      "device_sn": serialNumber, // [cite: 174]
      "packet_type": "wait_payment", // [cite: 175]
      "content": {
        "amount_due": parseFloat(payload.amount), // [cite: 177, 206]
        "order_id": currentOrderId, // [cite: 178]
        "payment_timeout": 60, // Returns home after 60s [cite: 179, 208]
        "screen_content_config": {
          "wait_payment_screen_qrcode_1_config": {
            "txt": device.fonepayMerchantCode, // [cite: 186, 212]
            "hei": 210 // Max height [cite: 189, 213]
          },
          "wait_payment_screen_label_3_config": {
            "txt": `${payload.amount} NPR`, // [cite: 191, 229]
            "hei": 24, // Medium font [cite: 193, 232]
            "col": "FF0000" // Red text [cite: 194, 222]
          }
        }
      }
    };

    client.publish(`${serialNumber}/pubmsg`, JSON.stringify(waitPaymentPacket));
    console.log(`[QR_SENT] Wait Payment screen pushed to ${serialNumber}`);

    // --- STEP 2: SIMULATE SMS SUCCESS (After 4s) ---
    setTimeout(async () => {
      console.log(`🔔 Simulating SMS Confirmation for ${serialNumber}...`);

      // 1. Record transaction in Supabase EarningRecord table
      await prisma.earningRecord.create({
        data: {
          amount: parseFloat(payload.amount),
          prn: currentOrderId,
          userId: device.userId,
          deviceId: device.id,
          description: `Payment at ${device.user.businessName}`
        }
      });

      // 2. Send Payment Success Packet
      const paymentPacket = {
        "message_id": generateMsgId(), // [cite: 256]
        "time_stamp": getUnixTimestamp(), // [cite: 257]
        "device_sn": serialNumber, // [cite: 258]
        "packet_type": "payment", // [cite: 259]
        "content": {
          "play_payment_amount": parseFloat(payload.amount), // [cite: 261, 267]
          "order_id": currentOrderId // CRITICAL: Must match wait_payment [cite: 262, 268]
        }
      };

      client.publish(`${serialNumber}/pubmsg`, JSON.stringify(paymentPacket));
      console.log(`[PAID] Success announcement sent to ${serialNumber}`);
    }, 4000);

  } catch (err) {
    console.error(`Relay Error for ${serialNumber}:`, err.message);
  }
});

client.on('error', (err) => console.error("❌ MQTT Client Error:", err));