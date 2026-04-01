require('dotenv').config();
const mqtt = require('mqtt');
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 20 });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

// Helpers per V1.1 Specs
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
  const parts = topic.split('/').filter(p => p && p !== 'LLZN');
  const serialNumber = parts[0]; 

  let payload;
  try {
    payload = JSON.parse(message.toString());
  } catch (e) { return; }

  // --- THE LOOP FIX: FILTER BY PACKET TYPE ---
  // The device sends responses (like 'rsp_set_device_info') [cite: 142]
  // We ONLY want to react to 'request_payment'
  if (payload.packet_type !== 'request_payment') {
    console.log(`[IGNORE] Received ${payload.packet_type} from ${serialNumber}`);
    return; 
  }

  const amount = payload.content ? payload.content.amount_due : null;

  if (!serialNumber || amount === null) {
    console.error(`⚠️ Request from ${serialNumber} is missing amount data.`);
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

    // --- STEP 1: PUSH QR (wait_payment) [cite: 175] ---
    const waitPaymentPacket = {
      "message_id": getMsgId(), // Required [cite: 201]
      "time_stamp": getTimestamp(), // Required [cite: 202]
      "device_sn": serialNumber, // Required [cite: 203]
      "packet_type": "wait_payment", // Required [cite: 204]
      "content": {
        "amount_due": parseFloat(amount), // [cite: 206]
        "order_id": orderId, // [cite: 207]
        "payment_timeout": 60, // [cite: 208]
        "screen_content_config": {
          "wait_payment_screen_qrcode_1_config": {
            "txt": device.fonepayMerchantCode, // [cite: 212]
            "hei": 210 // Max height [cite: 213]
          },
          "wait_payment_screen_label_3_config": {
            "txt": `${amount} NPR`, // [cite: 229]
            "hei": 24, // Medium font [cite: 232]
            "col": "FF0000" // Red [cite: 222]
          }
        }
      }
    };

    client.publish(`${serialNumber}/pubmsg`, JSON.stringify(waitPaymentPacket));
    console.log(`[QR_SENT] Pushed wait_payment to ${serialNumber}/pubmsg`);

    // --- STEP 2: SIMULATE SUCCESS (4s) ---
    setTimeout(async () => {
      const paymentPacket = {
        "message_id": getMsgId(), // [cite: 201]
        "time_stamp": getTimestamp(), // [cite: 202]
        "device_sn": serialNumber, // [cite: 203]
        "packet_type": "payment", // [cite: 266]
        "content": {
          "play_payment_amount": parseFloat(amount), // [cite: 267]
          "order_id": orderId // MUST match wait_payment [cite: 268]
        }
      };

      client.publish(`${serialNumber}/pubmsg`, JSON.stringify(paymentPacket));
      console.log(`[PAID] Success announcement sent to ${serialNumber}`);
    }, 4000);

  } catch (err) {
    console.error(`Relay Error for ${serialNumber}:`, err.message);
  }
});