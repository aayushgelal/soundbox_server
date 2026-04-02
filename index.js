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

const client = mqtt.connect("mqtt://127.0.0.1:1883", {
  clientId: 'BIZTRACK_MASTER_RELAY',
  username: 'aayush',
  password: 'Ankit#2059',
  clean: false
});

async function pushStaticHomeScreen(serialNumber) {
  const device = await prisma.device.findUnique({
    where: { serialNumber },
    include: { user: true }
  });

  if (!device) {
    console.warn(`⚠️  Device ${serialNumber} not found in DB`);
    return;
  }

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

  client.publish(`${serialNumber}/submsg`, JSON.stringify(packet), { qos: 1 });
  console.log(`📤 ${serialNumber}/submsg set_device_info → static QR pushed`);
}

client.on('connect', () => {
  client.subscribe('+/pubmsg', { qos: 1 });
  console.log("✅ Server Ready. Listening on +/pubmsg");
});

client.on('message', async (topic, message) => {
  try {
    const serialNumber = topic.split('/')[0];
    const payload = JSON.parse(message.toString());
    const packetType = payload.packet_type;
    const reRequestId = payload.re_request_id;

    console.log(`📥 ${serialNumber} packet_type=${packetType ?? 'heartbeat'} re_request_id=${reRequestId ?? 'none'}`);

    // --- HEARTBEAT / BOOT PACKET ---
    // Device sends status info on connect with re_request_id instead of packet_type.
    // Must acknowledge with re_request_id echoed back, THEN push screen.
    if (reRequestId && !packetType) {
      const ack = {
        re_request_id: reRequestId,   // echo back exactly
        message_id: getMsgId(),
        time_stamp: getTimestamp(),
        device_sn: serialNumber,
        packet_type: "rsp_heartbeat",
        content: { response_status: "success" }
      };
      client.publish(`${serialNumber}/submsg`, JSON.stringify(ack), { qos: 1 });
      console.log(`📤 ${serialNumber}/submsg rsp_heartbeat (ack re_request_id)`);

      // Small delay to let device finish handshake before we push the screen
      setTimeout(() => pushStaticHomeScreen(serialNumber), 500);
      return;
    }

    // --- REQUEST_PAYMENT ---
    // Device user entered an amount. For static QR mode, just reset the screen.
    if (packetType === 'request_payment') {
      const ack = {
        message_id: payload.message_id,
        time_stamp: getTimestamp(),
        device_sn: serialNumber,
        packet_type: "rsp_request_payment",
        content: { response_status: "success" }
      };
      client.publish(`${serialNumber}/submsg`, JSON.stringify(ack), { qos: 1 });
      console.log(`📤 ${serialNumber}/submsg rsp_request_payment`);

      setTimeout(() => pushStaticHomeScreen(serialNumber), 200);
      return;
    }

    // --- ANY OTHER PACKET ---
    // Unknown packet type — just push the screen anyway
    console.log(`⚠️  Unhandled packet_type="${packetType}", pushing screen anyway`);
    await pushStaticHomeScreen(serialNumber);

  } catch (err) {
    console.error("🔥 Relay Error:", err.message);
  }
});