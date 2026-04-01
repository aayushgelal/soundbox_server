require('dotenv').config();
const mqtt = require('mqtt');
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 20 });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

// --- PROTOCOL HELPERS ---
// Every server command must have a unique message_id [cite: 27-28, 94-95, 201, 301].
const getMsgId = () => Math.floor(Math.random() * 10000000000).toString();
const getTimestamp = () => Math.floor(Date.now() / 1000).toString();

const client = mqtt.connect("mqtt://127.0.0.1:1883", {
  clientId: 'BIZTRACK_MASTER_RELAY',
  username: 'aayush',
  password: 'Ankit#2059',
  clean: false
});

client.on('connect', () => {
  // THE FIX: Server listens to the topic where the hardware PUBLISHES (/LLZN/SN).
  client.subscribe('/LLZN/+', { qos: 1 });
  console.log("✅ Server Ready. Protocol V1.1 Implementation Active.");
});

client.on('message', async (topic, message) => {
  try {
    const serialNumber = topic.split('/').filter(p => p && p !== 'LLZN')[0];
    const payload = JSON.parse(message.toString());

    // --- STEP 0: THE HANDSHAKE (Clear "Connecting" Spinner) ---
    // Process only when the device sends a 'request_payment' packet.
    if (payload.packet_type === 'request_payment') {
      const deviceMsgId = payload.message_id; // Capture original ID to acknowledge.
      const amount = payload.content ? payload.content.amount_due : null; // [cite: 177, 206]

      if (!serialNumber || amount === null) return;

      const device = await prisma.device.findUnique({
        where: { serialNumber: serialNumber },
        include: { user: true }
      });
      if (!device) return;

      // Unique Order ID for transaction matching[cite: 178, 207, 262].
      const currentOrderId = Date.now().toString();

      // --- PACKET A: HANDSHAKE RESPONSE ---
      // Uses the device's message_id to acknowledge receipt and stop the spinner.
      const handshakeRsp = {
        "message_id": deviceMsgId, 
        "time_stamp": getTimestamp(),
        "device_sn": serialNumber,
        "packet_type": "rsp_request_payment", 
        "content": { "response_status": "success" }
      };
      client.publish(`${serialNumber}/pubmsg`, JSON.stringify(handshakeRsp));

      // --- PACKET B: STEP 1 - PUSH QR (wait_payment) [cite: 151-155] ---
      setTimeout(() => {
        const waitPaymentPacket = {
          "message_id": getMsgId(), 
          "time_stamp": getTimestamp(),
          "device_sn": serialNumber,
          "packet_type": "wait_payment", // [cite: 175, 204]
          "content": {
            "amount_due": parseFloat(amount), // [cite: 177, 206]
            "order_id": currentOrderId, // [cite: 178, 207]
            "payment_timeout": 60, // [cite: 179, 208-209]
            "screen_content_config": { // [cite: 100, 183, 210]
              "wait_payment_screen_qrcode_1_config": { // [cite: 158-161, 211]
                "txt": device.fonepayMerchantCode, // [cite: 186, 212]
                "x": 1, "y": 1, "hei": 210 // Mandatory coordinates [cite: 187-189, 213-219]
              },
              "wait_payment_screen_label_3_config": { // [cite: 162, 171, 228]
                "txt": `${amount} NPR`, // [cite: 191, 229]
                "x": 1, "hei": 24, "col": "FF0000" // Red color [cite: 194, 222, 245-246]
              }
            }
          }
        };
        client.publish(`${serialNumber}/pubmsg`, JSON.stringify(waitPaymentPacket));
        console.log(`[QR_SENT] Handshake cleared. Pushed wait_payment to ${serialNumber}`);
      }, 200);

      // --- PACKET C: STEP 2 - ANNOUNCE SUCCESS (payment) [cite: 10, 252-253] ---
      setTimeout(() => {
        const paymentPacket = {
          "message_id": getMsgId(), 
          "time_stamp": getTimestamp(),
          "device_sn": serialNumber,
          "packet_type": "payment", // [cite: 14, 21, 259, 266]
          "content": {
            "play_payment_amount": parseFloat(amount), // [cite: 23, 261, 267]
            "order_id": currentOrderId // MUST match Step 1 [cite: 262, 268-269]
          }
        };
        client.publish(`${serialNumber}/pubmsg`, JSON.stringify(paymentPacket));
        console.log(`[PAID] Audio announcement triggered.`);
      }, 4500);

      // --- PACKET D: UPDATE HOME SCREEN (set_device_info) [cite: 55, 70, 98] ---
      setTimeout(() => {
        const setDeviceInfoPacket = {
          "message_id": getMsgId(), 
          "time_stamp": getTimestamp(),
          "device_sn": serialNumber,
          "packet_type": "set_device_info", // [cite: 70, 98, 291, 306]
          "content": {
            "screen_content_config": { // [cite: 73, 100, 210, 294, 309]
              "main_screen_label_1_config": { // [cite: 39, 57, 75, 101]
                "txt": "Scan to Pay", // [cite: 77, 101]
                "hei": 24 // Medium font [cite: 78, 106, 232]
              },
              "main_screen_qrcode_1_config": { // [cite: 40, 58, 79, 125, 296, 310]
                "txt": device.fonepayMerchantCode, // [cite: 81, 126]
                "hei": 210, // Max height [cite: 82, 127]
                "col": "000000" // Black [cite: 83, 121, 226, 248]
              },
              "main_screen_label_3_config": { // [cite: 41, 58, 84, 129]
                "txt": device.user.businessName || "Welcome to the shop", // [cite: 86, 130]
                "hei": 24 // [cite: 87, 131]
              },
              "main_screen_label_4_config": { // [cite: 41, 61, 88, 133]
                "txt": `ID: ${serialNumber}`, // [cite: 90, 134]
                "hei": 24 // [cite: 91, 135]
              }
            }
          }
        };
        client.publish(`${serialNumber}/pubmsg`, JSON.stringify(setDeviceInfoPacket));
        console.log(`[HOME] Home screen updated via set_device_info.`);
      }, 9000);
    }
  } catch (err) {
    console.error("🔥 Critical Relay Error:", err.message);
  }
});