require('dotenv').config();
const mqtt = require('mqtt');
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 20 });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

// HELPER: Generates unique message IDs 
const getMsgId = () => Math.floor(Math.random() * 10000000000).toString();
// HELPER: Accurate Unix timestamp to seconds only [cite: 29, 96, 202, 302]
const getTimestamp = () => Math.floor(Date.now() / 1000).toString();

const client = mqtt.connect("mqtt://127.0.0.1:1883", {
  clientId: 'BIZTRACK_MASTER_RELAY',
  username: 'aayush',
  password: 'Ankit#2059',
  clean: false // Maintain persistent session
});

client.on('connect', () => {
  client.subscribe('/LLZN/+', { qos: 1 });
  console.log("✅ Server online. Strictly following Protocol V1.1.");
});

client.on('message', async (topic, message) => {
  try {
    const serialNumber = topic.split('/').filter(p => p && p !== 'LLZN')[0];
    let payload;
    
    try {
      payload = JSON.parse(message.toString());
    } catch (e) { return; }

    // ONLY process if the device sends 'request_payment'
    if (payload.packet_type !== 'request_payment') return;

    // Correct JSON Path per your raw logs: payload.content.amount_due
    const amount = payload.content ? payload.content.amount_due : null;
    if (!serialNumber || amount === null) return;

    const device = await prisma.device.findUnique({
      where: { serialNumber: serialNumber },
      include: { user: true }
    });

    if (!device) return;

    // Use a numeric string for Order ID [cite: 178, 262]
    const currentOrderId = Date.now().toString();

    // --- STEP 1: Push Dynamic QR (wait_payment) [cite: 151-155] ---
    const waitPaymentPacket = {
      "message_id": getMsgId(), // Unique ID [cite: 200-201]
      "time_stamp": getTimestamp(), // [cite: 202]
      "device_sn": serialNumber, // [cite: 203]
      "packet_type": "wait_payment", // [cite: 175, 204]
      "content": { // [cite: 176, 205]
        "amount_due": parseFloat(amount), // [cite: 177, 206]
        "order_id": currentOrderId, // [cite: 178, 207]
        "payment_timeout": 60, // [cite: 179, 208]
        "screen_content_config": { // [cite: 183, 210]
          "wait_payment_screen_qrcode_1_config": { // [cite: 184, 211]
            "txt": device.fonepayMerchantCode, // QR data [cite: 186, 212]
            "hei": 210 // Max height [cite: 189, 213]
          },
          "wait_payment_screen_label_3_config": { // [cite: 190, 228]
            "txt": `${amount} NPR`, // [cite: 191, 229]
            "hei": 24, // Medium font [cite: 106, 193, 232]
            "col": "FF0000" // Red [cite: 118-119, 194, 222, 245-246]
          }
        }
      }
    };

    client.publish(`${serialNumber}/pubmsg`, JSON.stringify(waitPaymentPacket));
    console.log(`[QR_SENT] Serial: ${serialNumber} | Amount: ${amount}`);

    // --- STEP 2: Send Result Result (payment) [cite: 151, 154, 252-253] ---
    setTimeout(async () => {
      const paymentPacket = {
        "message_id": getMsgId(), // Unique ID [cite: 27-28]
        "time_stamp": getTimestamp(), // [cite: 257]
        "device_sn": serialNumber, // [cite: 258]
        "packet_type": "payment", // [cite: 21, 259, 266]
        "content": { // [cite: 260]
          "play_payment_amount": parseFloat(amount), // [cite: 23, 261, 267]
          "order_id": currentOrderId // MUST match Step 1 [cite: 262, 268-269]
        }
      };

      client.publish(`${serialNumber}/pubmsg`, JSON.stringify(paymentPacket));
      console.log(`[PAID_SENT] Audio triggered for ${serialNumber}`);
    }, 4000);

  } catch (err) {
    // This block prevents the 'Socket error' by catching errors before they kill the script
    console.error("🔥 CRITICAL SERVER ERROR:", err.message);
  }
});