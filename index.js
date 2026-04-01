require('dotenv').config();
const mqtt = require('mqtt');
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 20 });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

// Protocol Helpers
const getMsgId = () => Math.floor(Math.random() * 10000000000).toString(); // [cite: 27, 200]
const getTimestamp = () => Math.floor(Date.now() / 1000).toString(); // [cite: 29, 202]

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
  const serialNumber = topic.split('/').filter(p => p && p !== 'LLZN')[0]; // [cite: 203]
  
  let payload;
  try {
    payload = JSON.parse(message.toString());
  } catch (e) { return; }

  // Trigger: Process only when the device sends a 'request_payment'
  if (payload.packet_type !== 'request_payment') return;

  const amount = payload.content ? payload.content.amount_due : null; // [cite: 206]
  if (!serialNumber || amount === null) return;

  try {
    const device = await prisma.device.findUnique({
      where: { serialNumber: serialNumber },
      include: { user: true }
    });

    if (!device) return;

    // Generate a unique Order ID for matching Step 1 and Step 2 [cite: 207, 268]
    const currentOrderId = Date.now().toString();

    // --- STEP 1: SERVER PUSH DYNAMIC QR (wait_payment) --- [cite: 150-155]
    const waitPaymentPacket = {
      "message_id": getMsgId(), // [cite: 200]
      "time_stamp": getTimestamp(), // [cite: 202]
      "device_sn": serialNumber, // [cite: 203]
      "packet_type": "wait_payment", // [cite: 204]
      "content": {
        "amount_due": parseFloat(amount), // [cite: 206]
        "order_id": currentOrderId, // [cite: 207]
        "payment_timeout": 60, // 
        "screen_content_config": { // [cite: 210]
          "wait_payment_screen_qrcode_1_config": { // [cite: 211]
            "txt": device.fonepayMerchantCode, // [cite: 212]
            "hei": 210 // [cite: 213]
          },
          "wait_payment_screen_label_3_config": { // [cite: 228]
            "txt": `${amount} NPR`, // [cite: 229]
            "hei": 24, // [cite: 232]
            "col": "FF0000" // [cite: 245, 246]
          }
        }
      }
    };

    client.publish(`${serialNumber}/pubmsg`, JSON.stringify(waitPaymentPacket));
    console.log(`[QR_PUSHED] Topic: ${serialNumber}/pubmsg | Amount: ${amount}`);

    // --- STEP 2: SERVER SEND PAYMENT RESULT (payment) --- [cite: 252, 253]
    setTimeout(async () => {
      const paymentPacket = {
        "message_id": getMsgId(), // [cite: 18, 94]
        "time_stamp": getTimestamp(), // [cite: 19, 96]
        "device_sn": serialNumber, // [cite: 20, 97]
        "packet_type": "payment", // [cite: 21, 259, 266]
        "content": {
          "play_payment_amount": parseFloat(amount), // [cite: 23, 261, 267]
          "order_id": currentOrderId // [cite: 262, 268, 269]
        }
      };

      client.publish(`${serialNumber}/pubmsg`, JSON.stringify(paymentPacket));
      console.log(`[PAID] Announcement sent to ${serialNumber}`);
    }, 4000);

  } catch (err) {
    console.error(`Relay Error:`, err.message);
  }
});