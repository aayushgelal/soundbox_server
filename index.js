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
  const serialNumber = topic.split('/').filter(p => p && p !== 'LLZN')[0];
  let payload;
  
  try {
    payload = JSON.parse(message.toString());
  } catch (e) { return; }

  // 1. Only act on 'request_payment' packets
  if (payload.packet_type !== 'request_payment') return;

  const deviceMsgId = payload.message_id; // Capture the ID the device is waiting on
  const amount = payload.content ? payload.content.amount_due : null;

  if (!serialNumber || amount === null) return;

  try {
    const device = await prisma.device.findUnique({
      where: { serialNumber: serialNumber },
      include: { user: true }
    });

    if (!device) return;

    // Use numeric-only string for Order ID (as seen in protocol examples)
    const currentOrderId = Date.now().toString();

    // --- STEP 1: SEND RESPONSE (Stop "Connecting" Spinner) ---
    const ackPacket = {
      "message_id": deviceMsgId, // Use the device's original ID to acknowledge receipt
      "time_stamp": getTimestamp(),
      "device_sn": serialNumber,
      "packet_type": "rsp_request_payment", // Acknowledges 'request_payment'
      "content": { "response_status": "success" }
    };
    client.publish(`${serialNumber}/pubmsg`, JSON.stringify(ackPacket));

    // --- STEP 2: PUSH DYNAMIC QR (wait_payment) --- [cite: 151, 155]
    setTimeout(() => {
      const waitPaymentPacket = {
        "message_id": getMsgId(), // Brand new unique ID [cite: 27, 28]
        "time_stamp": getTimestamp(),
        "device_sn": serialNumber,
        "packet_type": "wait_payment", // [cite: 175, 204]
        "content": {
          "amount_due": parseFloat(amount), // [cite: 177, 206]
          "order_id": currentOrderId, // [cite: 178, 207]
          "payment_timeout": 60, // [cite: 179, 209]
          "screen_content_config": {
            "wait_payment_screen_qrcode_1_config": {
              "txt": device.fonepayMerchantCode, // [cite: 186, 212]
              "hei": 210 // Max height [cite: 189, 213]
            },
            "wait_payment_screen_label_3_config": {
              "txt": `${amount} NPR`,
              "hei": 24, // Medium font [cite: 193, 232]
              "col": "FF0000" // Red [cite: 194, 222]
            }
          }
        }
      };
      client.publish(`${serialNumber}/pubmsg`, JSON.stringify(waitPaymentPacket));
      console.log(`[QR_PUSHED] ${serialNumber} | NPR ${amount}`);
    }, 150); // Small delay to let the ACK process first

    // --- STEP 3: SUCCESS ANNOUNCEMENT (payment) --- [cite: 154, 252]
    setTimeout(() => {
      const paymentPacket = {
        "message_id": getMsgId(), // New unique ID [cite: 27, 28]
        "time_stamp": getTimestamp(),
        "device_sn": serialNumber,
        "packet_type": "payment", // [cite: 21, 259]
        "content": {
          "play_payment_amount": parseFloat(amount), // [cite: 23, 261]
          "order_id": currentOrderId // MUST match Step 2 [cite: 262, 268, 269]
        }
      };
      client.publish(`${serialNumber}/pubmsg`, JSON.stringify(paymentPacket));
      console.log(`[PAID] Announcement sent to ${serialNumber}`);
    }, 4000);

  } catch (err) {
    console.error(`Relay Error:`, err.message);
  }
});