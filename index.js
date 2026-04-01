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
  const serialNumber = topic.split('/').filter(p => p && p !== 'LLZN')[0];
  
  let payload;
  try {
    payload = JSON.parse(message.toString());
  } catch (e) { return; }

  // Only process the actual payment request
  if (payload.packet_type !== 'request_payment') return;

  const deviceMsgId = payload.message_id; // Capture the device's message ID
  const amount = payload.content ? payload.content.amount_due : null;

  if (!serialNumber || amount === null) return;

  console.log(`[REQ] ${serialNumber} requesting QR for NPR ${amount}`);

  try {
    const device = await prisma.device.findUnique({
      where: { serialNumber: serialNumber },
      include: { user: true }
    });

    if (!device) return;

    const currentOrderId = `BIZ${Date.now()}`;

    // --- STEP 1: SEND ACKNOWLEDGMENT (Clear "Connecting" Spinner) ---
    // We reply to the device using ITS OWN message_id to confirm receipt
    const ackPacket = {
      "message_id": deviceMsgId, 
      "time_stamp": getTimestamp(),
      "device_sn": serialNumber,
      "packet_type": "rsp_request_payment", // Common protocol response type
      "content": { "response_status": "success" }
    };
    client.publish(`${serialNumber}/pubmsg`, JSON.stringify(ackPacket));

    // --- STEP 2: PUSH QR (wait_payment) ---
    const waitPaymentPacket = {
      "message_id": getMsgId(), // NEW unique ID for this command [cite: 27]
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
            "hei": 210 // Max height [cite: 189, 213]
          },
          "wait_payment_screen_label_3_config": {
            "txt": `${amount} NPR`,
            "hei": 24, // Medium font [cite: 232]
            "col": "FF0000" // Red [cite: 194, 222]
          }
        }
      }
    };

    // Small delay to ensure ACK is processed first
    setTimeout(() => {
      client.publish(`${serialNumber}/pubmsg`, JSON.stringify(waitPaymentPacket));
      console.log(`[QR_SENT] Pushed wait_payment to ${serialNumber}`);
    }, 200);

    // --- STEP 3: SUCCESS ANNOUNCEMENT (4s) ---
    setTimeout(() => {
      const paymentPacket = {
        "message_id": getMsgId(), // NEW unique ID [cite: 94]
        "time_stamp": getTimestamp(),
        "device_sn": serialNumber,
        "packet_type": "payment", 
        "content": {
          "play_payment_amount": parseFloat(amount), 
          "order_id": currentOrderId // MUST match Step 2 [cite: 268]
        }
      };

      client.publish(`${serialNumber}/pubmsg`, JSON.stringify(paymentPacket));
      console.log(`[PAID] Success sent to ${serialNumber}`);
    }, 4000);

  } catch (err) {
    console.error(`Relay Error:`, err.message);
  }
});
  