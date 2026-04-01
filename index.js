require('dotenv').config();
const mqtt = require('mqtt');
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 20 });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

// Protocol Helpers
const getMsgId = () => Math.floor(Math.random() * 10000000000).toString(); // 
const getTimestamp = () => Math.floor(Date.now() / 1000).toString(); // [cite: 29, 96, 202]

const client = mqtt.connect("mqtt://127.0.0.1:1883", {
  clientId: 'BIZTRACK_MASTER_RELAY',
  username: 'aayush',
  password: 'Ankit#2059',
  clean: false
});

client.on('connect', () => {
  // THE FIX: Subscribe to the topic the device PUBLISHES on (/LLZN/SN)
  client.subscribe('/LLZN/+', { qos: 1 });
  console.log("✅ Relay Online. Listening for hardware on /LLZN/+");
});

client.on('message', async (topic, message) => {
  try {
    // Correct Topic Parsing for /LLZN/2602270002
    const parts = topic.split('/').filter(p => p && p !== 'LLZN');
    const serialNumber = parts[0]; 
    
    const payload = JSON.parse(message.toString());

    // Only process payment requests to avoid loops
    if (payload.packet_type !== 'request_payment') return;

    const amount = payload.content ? payload.content.amount_due : null; 
    if (!serialNumber || amount === null) return;

    console.log(`[REQ] ${serialNumber} requesting NPR ${amount}`);

    const device = await prisma.device.findUnique({
      where: { serialNumber: serialNumber },
      include: { user: true }
    });

    if (!device) return;

    // Numeric-style Order ID for matching [cite: 178, 262]
    const currentOrderId = Date.now().toString();

    // --- STEP 1: PUSH DYNAMIC QR (wait_payment) [cite: 151-155] ---
    // THE FIX: Publish to the topic the device SUBSCRIBES to (SN/pubmsg)
    const waitPaymentPacket = {
      "message_id": getMsgId(), // [cite: 200, 201]
      "time_stamp": getTimestamp(), // [cite: 202]
      "device_sn": serialNumber, // [cite: 203]
      "packet_type": "wait_payment", // [cite: 204]
      "content": {
        "amount_due": parseFloat(amount), // [cite: 206]
        "order_id": currentOrderId, // [cite: 207]
        "payment_timeout": 60, // [cite: 208, 209]
        "screen_content_config": {
          "wait_payment_screen_qrcode_1_config": {
            "txt": device.fonepayMerchantCode, // [cite: 186, 212]
            "x": 1, // MANDATORY COORDINATE [cite: 187, 214]
            "y": 1, // MANDATORY COORDINATE [cite: 188, 217]
            "hei": 210 // [cite: 189, 213]
          },
          "wait_payment_screen_label_3_config": {
            "txt": `${amount} NPR`, // [cite: 191, 229]
            "x": 1, // MANDATORY COORDINATE [cite: 192, 236]
            "hei": 24, // [cite: 193, 232]
            "col": "FF0000" // [cite: 194, 222, 245]
          }
        }
      }
    };

    client.publish(`${serialNumber}/pubmsg`, JSON.stringify(waitPaymentPacket));
    console.log(`[QR_SENT] Pushed wait_payment to ${serialNumber}/pubmsg`);

    // --- STEP 2: ANNOUNCE SUCCESS (payment) [cite: 252-254] ---
    setTimeout(() => {
      const paymentPacket = {
        "message_id": getMsgId(), // [cite: 256]
        "time_stamp": getTimestamp(), // [cite: 257]
        "device_sn": serialNumber, // [cite: 258]
        "packet_type": "payment", // [cite: 259, 266]
        "content": {
          "play_payment_amount": parseFloat(amount), // [cite: 261, 267]
          "order_id": currentOrderId // MUST match Step 1 [cite: 262, 268, 269]
        }
      };

      client.publish(`${serialNumber}/pubmsg`, JSON.stringify(paymentPacket));
      console.log(`[PAID] Success sent to ${serialNumber}/pubmsg`);
    }, 4000);

  } catch (err) {
    console.error("Relay processing error:", err.message);
  }
});