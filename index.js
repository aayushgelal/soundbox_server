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

app.get('/', (req, res) => res.send('BizTrack Static-QR Relay: Active 🚀'));
app.listen(PORT, '0.0.0.0', () => console.log(`📡 API Gateway on port ${PORT}`));

// --- 2. MQTT CONFIG ---
const client = mqtt.connect("mqtt://127.0.0.1:1883", {
  clientId: 'BIZTRACK_MASTER_RELAY',
  // Note: Using anonymous for your testing phase as requested
});

client.on('connect', () => {
  client.subscribe('biztrack/+/request_qr', { qos: 1 });
  console.log("🚀 Connected. Listening for 10,000 devices (Static QR Mode)...");
});

client.on('message', async (topic, message) => {
  const serialNumber = topic.split('/')[1];
  let payload;
  
  try {
    payload = JSON.parse(message.toString());
  } catch (e) { return; }

  console.log(`[REQ] ${serialNumber} fetching static QR for NPR ${payload.amount}`);

  try {
    // --- 3. DATABASE LOOKUP (Static QR) ---
    const device = await prisma.device.findUnique({
      where: { serialNumber: serialNumber },
      include: { user: true }
    });

    if (!device || !device.fonepayMerchantCode) {
      console.error(`❌ Missing merchant code for: ${serialNumber}`);
      return;
    }

    // --- 4. SEND STATIC QR TO DISPLAY ---
    client.publish(`biztrack/${serialNumber}/display`, JSON.stringify({
      action: "DISPLAY_QR",
      qr_content: device.fonepayMerchantCode, // From your DB column
      amount: payload.amount,
      merchantName: device.user.businessName
    }), { qos: 1 });

    // --- 5. SIMULATE PAYMENT (SMS PARSING MOCK) ---
    console.log(`⏳ Waiting 4 seconds to simulate SMS payment confirmation...`);
    
    setTimeout(async () => {
      console.log(`🔔 Simulating Success for ${serialNumber}...`);

      // Record transaction in Supabase
      await prisma.earningRecord.create({
        data: {
          amount: parseFloat(payload.amount),
          prn: `SIM-${Date.now()}`, // Simulated PRN
          userId: device.userId,
          deviceId: device.id,
          description: `Static QR Payment - ${device.user.businessName}`
        }
      });

      // Trigger the soundbox voice
      client.publish(`biztrack/${serialNumber}/voice`, JSON.stringify({
        action: "PLAY_AUDIO",
        amount: payload.amount
      }), { qos: 1 });

      console.log(`[PAID] Simulated success sent to ${serialNumber}`);
    }, 4000);

  } catch (err) {
    console.error(`Relay Error for ${serialNumber}:`, err.message);
  }
});