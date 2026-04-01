// index.js
require('dotenv').config();
const mqtt = require('mqtt');
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 20 });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

// Protocol Helpers [cite: 29, 96, 202, 302]
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
  console.log("✅ Server Ready. Protocol V1.1 Active.");
});

client.on('message', async (topic, message) => {
  try {
    const serialNumber = topic.split('/').filter(p => p && p !== 'LLZN')[0];
    const payload = JSON.parse(message.toString());

    // --- STEP 0: HANDSHAKE (Clear "Connecting" screen) ---
    // We send an immediate response to the device's payment request
    if (payload.packet_type === 'request_payment') {
      const deviceMsgId = payload.message_id; // Original ID from device
      const amount = payload.content ? payload.content.amount_due : null;

      if (!serialNumber || amount === null) return;

      const device = await prisma.device.findUnique({
        where: { serialNumber: serialNumber },
        include: { user: true }
      });
      if (!device) return;

      const currentOrderId = Date.now().toString(); //

      // --- PACKET A: Response to Device ---
      const rspPacket = {
        "message_id": deviceMsgId, // Acknowledge their specific ID
        "time_stamp": getTimestamp(),
        "device_sn": serialNumber,
        "packet_type": "rsp_request_payment", // Standard protocol response naming
        "content": { "response_status": "success" }
      };
      client.publish(`${serialNumber}/pubmsg`, JSON.stringify(rspPacket));

      // --- PACKET B: Step 1 - Server Send QR Code [cite: 155, 168-180] ---
      setTimeout(() => {
        const waitPaymentPacket = {
          "message_id": getMsgId(), // NEW unique identifier [cite: 200-201]
          "time_stamp": getTimestamp(),
          "device_sn": serialNumber,
          "packet_type": "wait_payment",
          "content": {
            "amount_due": parseFloat(amount),
            "order_id": currentOrderId,
            "payment_timeout": 60,
            "screen_content_config": {
              "wait_payment_screen_qrcode_1_config": {
                "txt": device.fonepayMerchantCode,
                "x": 1, "y": 1, "hei": 210 // Max height [cite: 127]
              },
              "wait_payment_screen_label_3_config": {
                "txt": `${amount} NPR`,
                "x": 1, "hei": 24, "col": "FF0000" // Red text [cite: 194, 245]
              }
            }
          }
        };
        client.publish(`${serialNumber}/pubmsg`, JSON.stringify(waitPaymentPacket));
        console.log(`[QR_SENT] To ${serialNumber} for NPR ${amount}`);
      }, 150);

      // --- PACKET C: Step 2 - Server Send Payment Result [cite: 252-264] ---
      setTimeout(() => {
        const paymentPacket = {
          "message_id": getMsgId(), // NEW unique ID [cite: 256]
          "time_stamp": getTimestamp(),
          "device_sn": serialNumber,
          "packet_type": "payment",
          "content": {
            "play_payment_amount": parseFloat(amount),
            "order_id": currentOrderId // MUST match Step 1 
          }
        };
        client.publish(`${serialNumber}/pubmsg`, JSON.stringify(paymentPacket));
        console.log(`[PAID_SENT] Audio announcement sent.`);
      }, 4000);
    }
  } catch (err) {
    console.error("🔥 Error handling protocol handshake:", err.message);
  }
});