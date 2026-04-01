require('dotenv').config();
const mqtt = require('mqtt');
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 20 });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const getMsgId = () => Math.floor(Math.random() * 10000000000).toString();
const getTimestamp = () => Math.floor(Date.now() / 1000).toString();

// To prevent the "Infinite Loop," we track active requests
const pendingRequests = new Set();

const client = mqtt.connect("mqtt://127.0.0.1:1883", {
  clientId: 'BIZTRACK_MASTER_RELAY',
  username: 'aayush',
  password: 'Ankit#2059',
  clean: false
});

client.on('connect', () => {
  client.subscribe('/LLZN/+', { qos: 1 });
  console.log("✅ Server Listening on /LLZN/+");
});

client.on('message', async (topic, message) => {
  // 1. Extract Serial Number properly
  const serialNumber = topic.split('/').filter(p => p && p !== 'LLZN')[0];
  
  let payload;
  try {
    payload = JSON.parse(message.toString());
  } catch (e) { return; }

  // --- THE LOOP FIX: Filter by Packet Type ---
  // The device sends heartbeats/acks that don't have an amount.
  // We ONLY process 'request_payment' [cite: 5, 21, 175]
  if (payload.packet_type !== 'request_payment') {
    return; // Silently ignore heartbeats and acks
  }

  // Prevent duplicate processing if the device spam-clicks the button
  if (pendingRequests.has(serialNumber)) return;
  pendingRequests.add(serialNumber);

  const amount = payload.content ? payload.content.amount_due : null; [cite: 177, 206]

  if (!serialNumber || amount === null) {
    console.error(`⚠️ Request from ${serialNumber} missing amount.`);
    pendingRequests.delete(serialNumber);
    return;
  }

  console.log(`[REQ] ${serialNumber} requesting QR for NPR ${amount}`);

  try {
    const device = await prisma.device.findUnique({
      where: { serialNumber: serialNumber },
      include: { user: true }
    });

    if (!device) {
      console.error(`❌ Device ${serialNumber} not found in DB.`);
      pendingRequests.delete(serialNumber);
      return;
    }

    // Protocol uses numeric order IDs in examples [cite: 178, 262]
    const orderId = Date.now().toString(); 

    // --- STEP 1: PUSH QR (wait_payment) ---
    const waitPaymentPacket = {
      "message_id": getMsgId(), [cite: 27, 200]
      "time_stamp": getTimestamp(), [cite: 29, 202]
      "device_sn": serialNumber, [cite: 30, 203]
      "packet_type": "wait_payment", [cite: 175, 204]
      "content": {
        "amount_due": parseFloat(amount), [cite: 177, 206]
        "order_id": orderId, [cite: 178, 207]
        "payment_timeout": 60, [cite: 179, 208]
        "screen_content_config": {
          "wait_payment_screen_qrcode_1_config": {
            "txt": device.fonepayMerchantCode, [cite: 186, 212]
            "hei": 210 [cite: 189, 213]
          },
          "wait_payment_screen_label_3_config": {
            "txt": `${amount} NPR`, [cite: 191, 229]
            "hei": 24, [cite: 193, 232]
            "col": "FF0000" [cite: 194, 222, 245]
          }
        }
      }
    };

    client.publish(`${serialNumber}/pubmsg`, JSON.stringify(waitPaymentPacket));
    console.log(`[QR_SENT] Pushed to ${serialNumber}/pubmsg`);

    // --- STEP 2: SIMULATE SUCCESS (4s) ---
    setTimeout(async () => {
      const paymentPacket = {
        "message_id": getMsgId(), [cite: 256]
        "time_stamp": getTimestamp(), [cite: 257]
        "device_sn": serialNumber, [cite: 258]
        "packet_type": "payment", [cite: 259, 266]
        "content": {
          "play_payment_amount": parseFloat(amount), [cite: 261, 267]
          "order_id": orderId [cite: 262, 268]
        }
      };

      client.publish(`${serialNumber}/pubmsg`, JSON.stringify(paymentPacket));
      console.log(`[PAID] Success sent to ${serialNumber}`);
      
      // Clear the lock so the device can request again later
      pendingRequests.delete(serialNumber); 
    }, 4000);

  } catch (err) {
    console.error(`Relay Error:`, err.message);
    pendingRequests.delete(serialNumber);
  }
});