require('dotenv').config();
const mqtt = require('mqtt');
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const { Pool } = require('pg');

// -------------------- DB --------------------
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 20 });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

// -------------------- HELPERS --------------------

// ALWAYS UNIQUE (CRITICAL FIX)
const getMsgId = () =>
  `${Date.now()}${Math.floor(Math.random() * 1000)}`;

const getTimestamp = () =>
  Math.floor(Date.now() / 1000).toString();

// Safe publish with logging
const publish = (topic, payload) => {
  console.log(`📤 ${topic}`, payload.packet_type);
  client.publish(topic, JSON.stringify(payload), { qos: 1 });
};

// -------------------- MQTT --------------------
const client = mqtt.connect("mqtt://0.0.0.0:1883", {
  clientId: 'BIZTRACK_MASTER_RELAY',
  username: 'aayush',
  password: 'Ankit#2059',
  clean: true,
  reconnectPeriod: 3000
});

client.on('connect', () => {
  console.log("✅ MQTT Connected");

  // Device publishes here
  client.subscribe('+/pubmsg', { qos: 1 }), (err) => {
    if (err) console.error("❌ Subscribe error:", err);
    else console.log("📡 Listening to devices...");
  });
});

client.on('error', (err) => {
  console.error("🔥 MQTT Error:", err.message);
});

client.on('reconnect', () => {
  console.log("🔄 Reconnecting MQTT...");
});

// -------------------- MAIN HANDLER --------------------
client.on('message', async (topic, message) => {
  try {
    const serialNumber = topic.split('/')[0];
    const payload = JSON.parse(message.toString());

    console.log(`📥 ${serialNumber}`, payload.packet_type);

    if (!serialNumber || !payload.packet_type) return;

    // -------------------- STEP 1: REQUEST PAYMENT --------------------
    if (payload.packet_type === 'request_payment') {

      const amount = payload?.content?.amount_due;
      if (!amount) return;

      const device = await prisma.device.findUnique({
        where: { serialNumber },
        include: { user: true }
      });

      if (!device) {
        console.log("❌ Device not found:", serialNumber);
        return;
      }

      const orderId = Date.now().toString();

      // -------------------- FIXED HANDSHAKE --------------------
      // IMPORTANT: NEW UNIQUE message_id (NOT SAME AS REQUEST)
      const handshakeRsp = {
        message_id: getMsgId(),  // ✅ FIXED
        time_stamp: getTimestamp(),
        device_sn: serialNumber,
        packet_type: "rsp_request_payment",
        content: { response_status: "success" }
      };

      publish(`${serialNumber}/submsg`, handshakeRsp);

      // -------------------- STEP 2: WAIT PAYMENT --------------------
      setTimeout(() => {
        const waitPayment = {
          message_id: getMsgId(),
          time_stamp: getTimestamp(),
          device_sn: serialNumber,
          packet_type: "wait_payment",
          content: {
            amount_due: parseFloat(amount),
            order_id: orderId,
            payment_timeout: 60,
            screen_content_config: {
              wait_payment_screen_qrcode_1_config: {
                txt: device.fonepayMerchantCode,
                x: 1,
                y: 1,
                hei: 210
              },
              wait_payment_screen_label_3_config: {
                txt: `${amount} NPR`,
                x: 1,
                hei: 24,
                col: "FF0000"
              }
            }
          }
        };

        publish(`${serialNumber}/submsg`, waitPayment);
      }, 300);

      // -------------------- STEP 3: PAYMENT SUCCESS --------------------
      setTimeout(() => {
        const payment = {
          message_id: getMsgId(),
          time_stamp: getTimestamp(),
          device_sn: serialNumber,
          packet_type: "payment",
          content: {
            play_payment_amount: parseFloat(amount),
            order_id: orderId // MUST MATCH
          }
        };

        publish(`${serialNumber}/submsg`, payment);
      }, 5000);

      // -------------------- STEP 4: RESET HOME SCREEN --------------------
      setTimeout(() => {
        const homeScreen = {
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
                txt: device.user?.businessName || "Welcome",
                hei: 24
              },
              main_screen_label_4_config: {
                txt: `ID: ${serialNumber}`,
                hei: 24
              }
            }
          }
        };

        publish(`${serialNumber}/submsg`, homeScreen);
      }, 9000);
    }

    // -------------------- OPTIONAL: HANDLE DEVICE ACK --------------------
    if (payload.packet_type?.startsWith("rsp_")) {
      console.log(`✅ ACK from device: ${payload.packet_type}`);
    }

  } catch (err) {
    console.error("🔥 ERROR:", err.message);
  }
});