const mqtt = require('mqtt');
const WebSocket = require('ws');
const { PrismaClient } = require('@prisma/client');
const express = require('express'); // Added Express

const prisma = new PrismaClient();
const app = express();
const PORT = process.env.PORT || 3000;

// --- 1. THE "HEALTH CHECK" SERVER ---
// This part gives Render a web address to look at
app.get('/', (req, res) => {
  res.send('BizTrack Relay is Running 🚀');
});

app.get('/healthz', (req, res) => {
  res.status(200).send('Healthy');
});

app.listen(PORT, () => {
  console.log(`Web health-check server listening on port ${PORT}`);
});

// --- 2. MQTT LOGIC ---
// IMPORTANT: Change 'localhost' to your actual broker URL (e.g., from EMQX or HiveMQ)
const MQTT_BROKER = process.env.MQTT_URL || "mqtt://your-external-broker-url:1883"; 

const client = mqtt.connect(MQTT_BROKER, {
  clientId: 'BIZTRACK_MASTER_RELAY',
  clean: false,
  connectTimeout: 4000,
  reconnectPeriod: 1000,
  username: process.env.MQTT_USER, // Add these if your broker needs them
  password: process.env.MQTT_PASSWORD
});

client.on('connect', () => {
  client.subscribe('biztrack/+/request_qr', { qos: 1 });
  console.log("🚀 MQTT connected. Monitoring fleet...");
});

client.on('message', async (topic, message) => {
  const serialNumber = topic.split('/')[1];
  let payload;
  
  try {
    payload = JSON.parse(message.toString());
  } catch (e) { return; }

  console.log(`[REQ] ${serialNumber} requesting NPR ${payload.amount}`);

  const device = await prisma.device.findUnique({
    where: { serialNumber: serialNumber },
    include: { user: true }
  });

  if (!device || !device.fonepaySecretKey) {
    console.error(`Unauthorized device: ${serialNumber}`);
    return;
  }

  try {
    const fonepay = await initiateFonepayTransaction(device, payload.amount);

    client.publish(`biztrack/${serialNumber}/display`, JSON.stringify({
      action: "DISPLAY_QR",
      qr_content: fonepay.qrMessage,
      amount: payload.amount,
      merchantName: device.user.businessName
    }), { qos: 1 });

    const ws = new WebSocket(fonepay.socketUrl);
    const timer = setTimeout(() => ws.terminate(), 300000);

    ws.on('message', async (data) => {
      const msg = JSON.parse(data.toString());
      const status = JSON.parse(msg.transactionStatus);

      if (status.paymentSuccess) {
        clearTimeout(timer);
        
        await prisma.earningRecord.create({
          data: {
            amount: payload.amount,
            prn: status.traceId.toString(),
            userId: device.userId,
            deviceId: device.id,
            description: `Payment at ${device.name}`
          }
        });

        client.publish(`biztrack/${serialNumber}/voice`, JSON.stringify({
          action: "PLAY_AUDIO",
          amount: payload.amount
        }), { qos: 1 });

        console.log(`[SUCCESS] Payment for ${serialNumber} confirmed.`);
        ws.terminate();
      }
    });

  } catch (err) {
    console.error(`Relay Error for ${serialNumber}:`, err.message);
  }
});

async function initiateFonepayTransaction(device, amount) {
    // Replace with your real Fonepay logic
    return { qrMessage: "000201...", socketUrl: "wss://..." };
}