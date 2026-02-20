const mqtt = require('mqtt');
const WebSocket = require('ws');
const { PrismaClient } = require('@prisma/client');
const express = require('express');
const { PrismaPg } = require('@prisma/adapter-pg');
const { Pool } = require('pg');

// --- 1. PRISMA 7 INITIALIZATION (Performance Optimized) ---
const pool = new Pool({ 
  connectionString: process.env.DATABASE_URL,
  max: 20 // Allow up to 20 simultaneous DB connections
});
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => res.send('BizTrack Master Relay: Online 🚀'));
app.listen(PORT, '0.0.0.0', () => {
  console.log(`📡 Web Gateway active on port ${PORT}`);
});

// --- 2. MQTT LOGIC (Production Hardened) ---
const client = mqtt.connect("mqtt://127.0.0.1:1883", {
  clientId: 'BIZTRACK_MASTER_RELAY',
  clean: false, // Maintain session if relay restarts
  username: 'aayush',
  password: '@Newpassword@1',
  reconnectPeriod: 1000 // Reconnect quickly if Mosquitto blips
});

client.on('connect', () => {
  // The '+' is the wildcard for your 10,000 Serial Numbers
  client.subscribe('biztrack/+/request_qr', { qos: 1 });
  console.log("🚀 Connected to Mosquitto. Monitoring 10,000+ potential devices...");
});

client.on('message', async (topic, message) => {
  const serialNumber = topic.split('/')[1];
  let payload;
  
  try {
    payload = JSON.parse(message.toString());
  } catch (e) { return; }

  console.log(`[REQ] ${serialNumber} requesting NPR ${payload.amount}`);

  // DB Lookup: Find the Merchant details for this specific Soundbox
  const device = await prisma.device.findUnique({
    where: { serialNumber: serialNumber },
    include: { user: true }
  });

  if (!device) {
    console.error(`Rejected: Device ${serialNumber} not found in database.`);
    return;
  }

  try {
    // 1. Get QR Code from Payment Gateway (Fonepay/Khalti)
    const fonepay = await initiateFonepayTransaction(device, payload.amount);

    // 2. Send QR back to the specific Soundbox display
    client.publish(`biztrack/${serialNumber}/display`, JSON.stringify({
      action: "DISPLAY_QR",
      qr_content: fonepay.qrMessage,
      amount: payload.amount,
      merchantName: device.user.businessName
    }), { qos: 1 });

    // 3. Open WebSocket for real-time payment confirmation
    const ws = new WebSocket(fonepay.socketUrl);
    
    // Safety: Close socket after 5 minutes if no payment is made to save RAM
    const watchdog = setTimeout(() => {
      if (ws.readyState === WebSocket.OPEN) ws.terminate();
    }, 300000); 

    ws.on('message', async (data) => {
      const msg = JSON.parse(data.toString());
      const status = JSON.parse(msg.transactionStatus);

      if (status.paymentSuccess) {
        clearTimeout(watchdog);
        
        // Record the money in Supabase
        await prisma.earningRecord.create({
          data: {
            amount: parseFloat(payload.amount),
            prn: status.traceId.toString(),
            userId: device.userId,
            deviceId: device.id,
            description: `Payment at ${device.user.businessName}`
          }
        });

        // 4. Tell Soundbox to announce the payment in Nepali
        client.publish(`biztrack/${serialNumber}/voice`, JSON.stringify({
          action: "PLAY_AUDIO",
          amount: payload.amount
        }), { qos: 1 });

        console.log(`[PAID] NPR ${payload.amount} for ${device.user.businessName} (${serialNumber})`);
        ws.terminate();
      }
    });

    ws.on('error', () => clearTimeout(watchdog));
    ws.on('close', () => clearTimeout(watchdog));

  } catch (err) {
    console.error(`Relay Error for ${serialNumber}:`, err.message);
  }
});

async function initiateFonepayTransaction(device, amount) {
    // This is where you call the actual Fonepay Merchant API
    // For now, returning a mock response
    return { 
      qrMessage: "000201010211...", 
      socketUrl: `wss://api.fonepay.com/payment/verify?id=${device.serialNumber}` 
    };
}