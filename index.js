require('dotenv').config();
const mqtt = require('mqtt');
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 20 });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

// --- PROTOCOL HELPERS ---
// Every command MUST have a unique message_id or the device ignores it[cite: 27, 94, 200, 300].
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
  console.log("✅ Server Online. Protocol V1.1 Implementation Active.");
});

client.on('message', async (topic, message) => {
  try {
    const serialNumber = topic.split('/').filter(p => p && p !== 'LLZN')[0];
    const payload = JSON.parse(message.toString());

    // --- STEP 0: HANDLE INITIAL PAYMENT REQUEST ---
    if (payload.packet_type === 'request_payment') {
      const amount = payload.content ? payload.content.amount_due : null;
      if (!serialNumber || amount === null) return;

      const device = await prisma.device.findUnique({
        where: { serialNumber: serialNumber },
        include: { user: true }
      });
      if (!device) return;

      const currentOrderId = Date.now().toString();

      // --- STEP 1: PUSH DYNAMIC QR (wait_payment) ---
      // This switches the device to the payment waiting screen[cite: 151, 155, 175].
      const waitPaymentPacket = {
        "message_id": getMsgId(), 
        "time_stamp": getTimestamp(),
        "device_sn": serialNumber,
        "packet_type": "wait_payment", // [cite: 175, 204]
        "content": {
          "amount_due": parseFloat(amount), // [cite: 177, 206]
          "order_id": currentOrderId, // [cite: 178, 207]
          "payment_timeout": 60, // [cite: 179, 208]
          "screen_content_config": {
            "wait_payment_screen_qrcode_1_config": { // [cite: 161, 211]
              "txt": device.fonepayMerchantCode, 
              "x": 1, "y": 1, "hei": 210 // [cite: 187, 188, 189]
            },
            "wait_payment_screen_label_3_config": { // [cite: 162, 228]
              "txt": `${amount} NPR`,
              "x": 1, "hei": 24, "col": "FF0000" // [cite: 192, 193, 194]
            }
          }
        }
      };
      client.publish(`${serialNumber}/pubmsg`, JSON.stringify(waitPaymentPacket));

      // --- STEP 2: ANNOUNCE SUCCESS (payment) ---
      // This triggers the voice and clears the QR screen if order_id matches[cite: 7, 252, 259, 268].
      setTimeout(() => {
        const paymentPacket = {
          "message_id": getMsgId(), 
          "time_stamp": getTimestamp(),
          "device_sn": serialNumber,
          "packet_type": "payment", // Fixed packet type [cite: 21, 259, 266]
          "content": {
            "play_payment_amount": parseFloat(amount), // [cite: 23, 261, 267]
            "order_id": currentOrderId // MUST match Step 1 to return home [cite: 262, 268, 269]
          }
        };
        client.publish(`${serialNumber}/pubmsg`, JSON.stringify(paymentPacket));
        console.log(`[PAID] Audio triggered for ${serialNumber}`);
      }, 4000);

      // --- STEP 3: UPDATE HOME SCREEN (set_device_info) ---
      // Optional: Updates the default labels shown on the homepage[cite: 55, 70].
      setTimeout(() => {
        const setDeviceInfoPacket = {
          "message_id": getMsgId(), 
          "time_stamp": getTimestamp(),
          "device_sn": serialNumber,
          "packet_type": "set_device_info", // [cite: 70, 98, 306]
          "content": {
            "screen_content_config": {
              "main_screen_label_1_config": { // [cite: 39, 75, 101]
                "txt": "Scan to Pay",
                "hei": 24 // [cite: 77, 78, 106]
              },
              "main_screen_qrcode_1_config": { // [cite: 40, 79, 125]
                "txt": device.fonepayMerchantCode, // Use merchant URL or static QR [cite: 81, 126]
                "hei": 210, // [cite: 82, 127]
                "col": "000000" // [cite: 83, 121]
              },
              "main_screen_label_3_config": { // [cite: 41, 84, 129]
                "txt": device.user.businessName || "Welcome to the shop", // [cite: 86, 130]
                "hei": 24 // [cite: 87, 131]
              },
              "main_screen_label_4_config": { // [cite: 41, 88, 133]
                "txt": `ID: ${serialNumber}`, // [cite: 90, 134]
                "hei": 24 // [cite: 91, 135]
              }
            }
          }
        };
        client.publish(`${serialNumber}/pubmsg`, JSON.stringify(setDeviceInfoPacket));
      }, 8000);
    }
  } catch (err) {
    console.error("Relay Error:", err.message);
  }
});