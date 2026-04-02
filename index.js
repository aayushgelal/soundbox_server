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

// Device publishes to:  {SN}/pubmsg
// Device subscribes to: /LLZN/{SN}
const toDevice = (sn) => `/LLZN/${sn}`;

const client = mqtt.connect("mqtt://127.0.0.1:1883", {
  clientId: 'BIZTRACK_MASTER_RELAY',
  username: 'aayush',
  password: 'Ankit#2059',
  clean: false
});

async function getDevice(serialNumber) {
  return prisma.device.findUnique({
    where: { serialNumber },
    include: { user: true }
  });
}

function pushHomeScreen(serialNumber, device) {
  const packet = {
    message_id: getMsgId(),
    time_stamp: getTimestamp(),
    device_sn: serialNumber,
    packet_type: "set_device_info",
    content: {
      screen_content_config: {
        main_screen_label_1_config: { txt: "Scan to Pay", hei: 24 },
        main_screen_qrcode_1_config: {
          txt: device.fonepayMerchantCode,
          hei: 180,        // reduced from 210
          col: "000000"
        },
        main_screen_label_3_config: {
          txt: device.user.businessName || "Welcome to the shop",
          hei: 24
        },
        main_screen_label_4_config: { txt: `ID: ${serialNumber}`, hei: 24 }
      }
    }
  };
  client.publish(toDevice(serialNumber), JSON.stringify(packet), { qos: 1 });
  console.log(`📤 ${toDevice(serialNumber)} set_device_info → home screen QR`);
}

function pushWaitPayment(serialNumber, device, amount) {
  const orderId = Date.now().toString();
  const packet = {
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
          x: 1, y: 1, hei: 180   // reduced from 210
        },
        wait_payment_screen_label_3_config: {
          txt: `${amount} NPR`,
          x: 1, hei: 24, col: "FF0000"
        }
      }
    }
  };
  client.publish(toDevice(serialNumber), JSON.stringify(packet), { qos: 1 });
  console.log(`📤 ${toDevice(serialNumber)} wait_payment → amount=${amount}`);
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

    console.log(`📥 ${serialNumber} | packet_type="${packetType}" | re_request_id="${reRequestId}"`);

    // ── 1. HEARTBEAT ─────────────────────────────────────────────────────
    if (reRequestId) {
      const ack = {
        re_request_id: reRequestId,
        message_id: getMsgId(),
        time_stamp: getTimestamp(),
        device_sn: serialNumber,
        packet_type: "rsp_heartbeat",
        content: { response_status: "success" }
      };
      client.publish(toDevice(serialNumber), JSON.stringify(ack), { qos: 1 });
      console.log(`📤 ${toDevice(serialNumber)} rsp_heartbeat`);

      const device = await getDevice(serialNumber);
      if (device) setTimeout(() => pushHomeScreen(serialNumber, device), 800);
      else console.warn(`⚠️  Device ${serialNumber} not in DB`);
      return;
    }

    // ── 2. SHUTDOWN ───────────────────────────────────────────────────────
    if (payload.shutdown) {
      console.log(`📴 ${serialNumber} shutdown, ignoring`);
      return;
    }

    // ── 3. REQUEST_PAYMENT ────────────────────────────────────────────────
    if (packetType === 'request_payment') {
      const amount = payload.content?.amount_due;

      const ack = {
        message_id: payload.message_id,
        time_stamp: getTimestamp(),
        device_sn: serialNumber,
        packet_type: "rsp_request_payment",
        content: { response_status: "success" }
      };
      client.publish(toDevice(serialNumber), JSON.stringify(ack), { qos: 1 });
      console.log(`📤 ${toDevice(serialNumber)} rsp_request_payment`);

      const device = await getDevice(serialNumber);
      if (device) setTimeout(() => pushWaitPayment(serialNumber, device, amount), 300);
      else console.warn(`⚠️  Device ${serialNumber} not in DB`);
      return;
    }

    // ── 4. DEVICE ACKs ────────────────────────────────────────────────────
    if (packetType?.startsWith('rsp_')) {
      console.log(`✅ ${serialNumber} device ack: ${packetType}`);
      return;
    }

    console.log(`⚠️  ${serialNumber} unhandled packet_type="${packetType}", ignoring`);

  } catch (err) {
    console.error("🔥 Relay Error:", err.message, err.stack);
  }
});