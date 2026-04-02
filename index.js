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

// Push static QR home screen to a device (Protocol Doc Section 4)
async function pushStaticHomeScreen(serialNumber) {
  const device = await prisma.device.findUnique({
    where: { serialNumber },
    include: { user: true }
  });

  if (!device) {
    console.warn(`⚠️  Device ${serialNumber} not found in DB`);
    return;
  }

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

  const pubTopic = `${serialNumber}/submsg`;
  client.publish(pubTopic, JSON.stringify(setDeviceInfoPacket), { qos: 1 });
  console.log(`📤 ${pubTopic} set_device_info → static QR pushed`);
}

client.on('connect', () => {
  client.subscribe('+/pubmsg', { qos: 1 });
  console.log("✅ Server Ready. Listening on +/pubmsg");
});

client.on('message', async (topic, message) => {
  try {
    const serialNumber = topic.split('/')[0];
    const payload = JSON.parse(message.toString());
    console.log(`📥 ${serialNumber} ${payload.packet_type}`);

    // For static QR mode: whenever the device sends ANY packet (boot, request_payment, etc.)
    // just push the static home screen back. This clears "Connecting..." and shows the QR.
    await pushStaticHomeScreen(serialNumber);

  } catch (err) {
    console.error("🔥 Relay Error:", err.message);
  }
});