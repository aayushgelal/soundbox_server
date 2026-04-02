require('dotenv').config();
const mqtt = require('mqtt');
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 20 });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

// --- PROTOCOL HELPERS ---
const getMsgId = () => Math.floor(Math.random() * 10000000000).toString();
const getTimestamp = () => Math.floor(Date.now() / 1000).toString();

const client = mqtt.connect("mqtt://127.0.0.1:1883", {
  clientId: 'BIZTRACK_MASTER_RELAY',
  username: 'aayush',
  password: 'Ankit#2059',
  clean: false
});

client.on('connect', () => {
  // Device publishes to: {SN}/pubmsg — subscribe with wildcard
  client.subscribe('+/pubmsg', { qos: 1 });
  console.log("✅ Server Ready. Listening on +/pubmsg");
});

client.on('message', async (topic, message) => {
  try {
    // topic = "2602270002/pubmsg" → parts[0] is the serial number
    const parts = topic.split('/');
    const serialNumber = parts[0];

    const payload = JSON.parse(message.toString());
    console.log(`📥 ${serialNumber} ${payload.packet_type}`);

    if (payload.packet_type === 'request_payment') {
      const deviceMsgId = payload.message_id;
      const amount = payload.content ? payload.content.amount_due : null;

      if (!serialNumber || amount === null) return;

      const device = await prisma.device.findUnique({
        where: { serialNumber },
        include: { user: true }
      });
      if (!device) {
        console.warn(`⚠️  Device ${serialNumber} not found in DB`);
        return;
      }

      const currentOrderId = Date.now().toString();
      const pubTopic = `${serialNumber}/submsg`;

      // --- PACKET A: HANDSHAKE RESPONSE ---
      const handshakeRsp = {
        message_id: deviceMsgId,          // echo device's own message_id
        time_stamp: getTimestamp(),
        device_sn: serialNumber,
        packet_type: "rsp_request_payment",
        content: { response_status: "success" }
      };
      client.publish(pubTopic, JSON.stringify(handshakeRsp), { qos: 1 });
      console.log(`📤 ${pubTopic} rsp_request_payment`);

      // --- PACKET B: WAIT_PAYMENT (show QR) ---
      setTimeout(() => {
        const waitPaymentPacket = {
          message_id: getMsgId(),
          time_stamp: getTimestamp(),
          device_sn: serialNumber,
          packet_type: "wait_payment",
          content: {
            amount_due: parseFloat(amount),
            order_id: currentOrderId,
            payment_timeout: 60,
            screen_content_config: {
              wait_payment_screen_qrcode_1_config: {
                txt: device.fonepayMerchantCode,
                x: 1, y: 1, hei: 210
              },
              wait_payment_screen_label_3_config: {
                txt: `${amount} NPR`,
                x: 1, hei: 24, col: "FF0000"
              }
            }
          }
        };
        client.publish(pubTopic, JSON.stringify(waitPaymentPacket), { qos: 1 });
        console.log(`📤 ${pubTopic} wait_payment`);
      }, 200);

      // --- PACKET C: PAYMENT (audio announcement) ---
      setTimeout(() => {
        const paymentPacket = {
          message_id: getMsgId(),
          time_stamp: getTimestamp(),
          device_sn: serialNumber,
          packet_type: "payment",
          content: {
            play_payment_amount: parseFloat(amount),
            order_id: currentOrderId          // MUST match wait_payment order_id
          }
        };
        client.publish(pubTopic, JSON.stringify(paymentPacket), { qos: 1 });
        console.log(`📤 ${pubTopic} payment`);
      }, 4500);

      // --- PACKET D: RESTORE HOME SCREEN ---
      setTimeout(() => {
        const setDeviceInfoPacket = {
          message_id: getMsgId(),
          time_stamp: getTimestamp(),
          device_sn: serialNumber,
          packet_type: "set_device_info",
          content: {
            screen_content_config: {
              main_screen_label_1_config: {
                txt: "Scan to Pay",
                hei: 24
              },
              main_screen_qrcode_1_config: {
                txt: device.fonepayMerchantCode,
                hei: 210,
                col: "000000"
              },
              main_screen_label_3_config: {
                txt: device.user.businessName || "Welcome to the shop",
                hei: 24
              },
              main_screen_label_4_config: {
                txt: `ID: ${serialNumber}`,
                hei: 24
              }
            }
          }
        };
        client.publish(pubTopic, JSON.stringify(setDeviceInfoPacket), { qos: 1 });
        console.log(`📤 ${pubTopic} set_device_info`);
      }, 9000);
    }
  } catch (err) {
    console.error("🔥 Critical Relay Error:", err.message);
  }
});