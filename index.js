require('dotenv').config();
const mqtt = require('mqtt');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// ---------- HELPERS ----------
const getMsgId = () =>
  `${Date.now()}${Math.floor(Math.random() * 1000)}`;

const getTimestamp = () =>
  Math.floor(Date.now() / 1000).toString();

const publish = (topic, payload) => {
  console.log(`📤 ${topic}`, payload.packet_type);
  client.publish(topic, JSON.stringify(payload), { qos: 1 });
};

// ---------- MQTT ----------
const client = mqtt.connect("mqtt://0.0.0.0:1883", {
  username: 'aayush',
  password: 'Ankit#2059',
  clean: true,
  reconnectPeriod: 3000
});

client.on('connect', () => {
  console.log("✅ MQTT Connected");

  // listen to device messages
  client.subscribe('+/pubmsg', { qos: 1 });
});

// ---------- STATIC QR FUNCTION ----------
const sendStaticQR = (serialNumber, device) => {
  const packet = {
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
          txt: device.fonepayMerchantCode, // ✅ YOUR STATIC QR STRING
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

  publish(`${serialNumber}/submsg`, packet);
};

// ---------- MAIN ----------
client.on('message', async (topic, message) => {
  try {
    const serialNumber = topic.split('/')[0];
    console.log(`📥 ${serialNumber} message received`);

    const device = await prisma.device.findUnique({
      where: { serialNumber },
      include: { user: true }
    });

    if (!device) {
      console.log("❌ Device not found:", serialNumber);
      return;
    }

    // ✅ ALWAYS SEND STATIC QR (this is key)
    sendStaticQR(serialNumber, device);

  } catch (err) {
    console.error("🔥 Error:", err.message);
  }
});