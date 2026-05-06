require('dotenv').config();
const mqtt = require('mqtt');
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 20 });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const getMsgId  = () => Math.floor(Math.random() * 10000000000).toString();
const getTimestamp = () => Math.floor(Date.now() / 1000).toString();
const toDevice  = (sn) => `/LLZN/${sn}`;

// ── MQTT Client ───────────────────────────────────────────────────────────────
const client = mqtt.connect("mqtt://127.0.0.1:1883", {
  clientId: 'BIZTRACK_MASTER_RELAY',
  username: 'aayush',
  password: 'Ankit#2059',
  clean: false
});

// ── DB Helpers ────────────────────────────────────────────────────────────────
async function getDevice(serialNumber) {
  return prisma.device.findUnique({
    where: { serialNumber },
    include: { user: true }
  });
}

// ── SMS Parsers ───────────────────────────────────────────────────────────────
// Sample: "Transaction success for Rs 160.00 from 976****005 on 2026-05-03 08:01:00
//          Remark: yyy, RRN 27211880Y5td Customer Care:01-5970499 KBL"
function parseSmsAmount(message) {
  const patterns = [
    /(?:Rs\.?\s*|NPR\s*)(\d+(?:\.\d{1,2})?)/i,
    /(?:amount|amt)[:\s]+(?:Rs\.?\s*|NPR\s*)?(\d+(?:\.\d{1,2})?)/i,
  ];
  for (const re of patterns) {
    const m = message.match(re);
    if (m) return parseFloat(m[1]);
  }
  return null;
}

function parseSmsRef(message) {
  // "RRN 27211880Y5td" or "Ref: ABC123" or "TXN Ref: FP123456"
  const m = message.match(/(?:RRN|TXN\s*Ref|Ref(?:erence)?)[:\s]+([A-Za-z0-9]+)/i);
  return m ? m[1] : `SMS_${Date.now()}`;
}

// ── Audio Announcement ────────────────────────────────────────────────────────
function playAudio(serialNumber, amount) {
  const packet = {
    message_id: getMsgId(),
    time_stamp:  getTimestamp(),
    device_sn:   serialNumber,
    packet_type: "payment",
    content: { play_payment_amount: parseFloat(amount) }
  };
  client.publish(toDevice(serialNumber), JSON.stringify(packet), { qos: 1 });
  console.log(`🔊 ${serialNumber} → audio ${amount} NPR`);
}

// ── Home Screen ───────────────────────────────────────────────────────────────
function pushHomeScreen(serialNumber, device) {
  const packet = {
    message_id: getMsgId(),
    time_stamp:  getTimestamp(),
    device_sn:   serialNumber,
    packet_type: "set_device_info",
    content: {
      screen_content_config: {
        main_screen_label_1_config:  { txt: "Scan to Pay", hei: 24 },
        main_screen_qrcode_1_config: {
          txt: device.fonepayMerchantCode,
          hei: 180, col: "000000"
        },
        main_screen_label_3_config:  {
          txt: device.user.businessName || "Welcome to the shop",
          hei: 24
        },
        main_screen_label_4_config:  { txt: `ID: ${serialNumber}`, hei: 24 }
      }
    }
  };
  client.publish(toDevice(serialNumber), JSON.stringify(packet), { qos: 1 });
  console.log(`📤 ${serialNumber} → home screen`);
}

// ── QR Payment Screen (existing flow) ────────────────────────────────────────
function pushWaitPayment(serialNumber, device, amount) {
  const orderId = Date.now().toString();
  const waitPacket = {
    message_id: getMsgId(),
    time_stamp:  getTimestamp(),
    device_sn:   serialNumber,
    packet_type: "wait_payment",
    content: {
      amount_due:      parseFloat(amount),
      order_id:        orderId,
      payment_timeout: 60,
      screen_content_config: {
        wait_payment_screen_qrcode_1_config: {
          txt: device.fonepayMerchantCode,
          x: 1, y: 1, hei: 180
        },
        wait_payment_screen_label_3_config: {
          txt: `${amount} NPR`,
          x: 1, hei: 24, col: "FF0000"
        }
      }
    }
  };
  client.publish(toDevice(serialNumber), JSON.stringify(waitPacket), { qos: 1 });
  console.log(`📤 ${serialNumber} → wait_payment amount=${amount}`);

  // After 5s: announce + record as QR/Sales
  setTimeout(async () => {
    playAudio(serialNumber, amount);
    try {
      const existing = await prisma.earningRecord.findUnique({ where: { prn: orderId } });
      if (!existing) {
        await prisma.earningRecord.create({
          data: {
            amount:        parseFloat(amount),
            currency:      "NPR",
            description:   "QR Payment received",
            category:      "Sales",
            status:        "SUCCESS",
            prn:           orderId,
            paymentMethod: "HARDWARE",
            source:        "device",
            userId:        device.userId,
            deviceId:      device.id
          }
        });
        console.log(`💾 QR Sale saved: ${amount} NPR | PRN=${orderId}`);
      }
    } catch (err) {
      console.error("🔥 QR Record Error:", err.message);
    }
  }, 5000);
}

// ── Credit User List ──────────────────────────────────────────────────────────
// Uses existing Credit model — LINA = they owe you, DINA = you owe them
async function sendCreditUserList(serialNumber, device) {
  try {
    const credits = await prisma.credit.findMany({
      where:   { userId: device.userId, status: "PENDING" },
      orderBy: { customerName: 'asc' }
    });

    const users = credits.map(c => ({
      id:      c.id,
      name:    c.customerName,
      phone:   c.customerPhone || "",
      balance: c.totalAmount   // positive = LINA (they owe you)
    }));

    const packet = {
      message_id: getMsgId(),
      time_stamp:  getTimestamp(),
      device_sn:   serialNumber,
      packet_type: "credit_users",
      content: { users }
    };
    client.publish(toDevice(serialNumber), JSON.stringify(packet), { qos: 1 });
    console.log(`📤 ${serialNumber} → credit_users (${users.length} records)`);
  } catch (err) {
    console.error("🔥 Credit List Error:", err.message);
  }
}

// ── MQTT Connect ──────────────────────────────────────────────────────────────
client.on('connect', () => {
  client.subscribe('+/pubmsg', { qos: 1 });
  console.log("✅ Server Ready. Listening on +/pubmsg");
});

// ── Message Router ────────────────────────────────────────────────────────────
client.on('message', async (topic, message) => {
  try {
    const serialNumber = topic.split('/')[0];
    const payload      = JSON.parse(message.toString());
    const packetType   = payload.packet_type;
    const msgType      = payload.type;
    const reRequestId  = payload.re_request_id;

    console.log(`📥 ${serialNumber} | packet_type="${packetType}" | type="${msgType}" | re_request_id="${reRequestId}"`);

    // ── 1. HEARTBEAT ──────────────────────────────────────────────────────
    if (reRequestId) {
      const ack = {
        re_request_id: reRequestId,
        message_id:    getMsgId(),
        time_stamp:    getTimestamp(),
        device_sn:     serialNumber,
        packet_type:   "rsp_heartbeat",
        content:       { response_status: "success" }
      };
      client.publish(toDevice(serialNumber), JSON.stringify(ack), { qos: 1 });
      console.log(`📤 ${serialNumber} → rsp_heartbeat`);

      const device = await getDevice(serialNumber);
      if (device) setTimeout(() => pushHomeScreen(serialNumber, device), 800);
      else console.warn(`⚠️  Device ${serialNumber} not in DB`);
      return;
    }

    // ── 2. SHUTDOWN ───────────────────────────────────────────────────────
    if (payload.shutdown) {
      console.log(`📴 ${serialNumber} shutdown`);
      return;
    }

    // ── 3. REQUEST_PAYMENT (existing QR flow) ─────────────────────────────
    if (packetType === 'request_payment') {
      const amount = payload.content?.amount_due;
      const ack = {
        message_id:  payload.message_id,
        time_stamp:  getTimestamp(),
        device_sn:   serialNumber,
        packet_type: "rsp_request_payment",
        content:     { response_status: "success" }
      };
      client.publish(toDevice(serialNumber), JSON.stringify(ack), { qos: 1 });
      console.log(`📤 ${serialNumber} → rsp_request_payment`);

      const device = await getDevice(serialNumber);
      if (device) setTimeout(() => pushWaitPayment(serialNumber, device, amount), 300);
      else console.warn(`⚠️  Device ${serialNumber} not in DB`);
      return;
    }

    // ── 4. RAW SMS ────────────────────────────────────────────────────────
    // Device forwards raw SMS — server parses amount, deduplicates by RRN, records + plays audio
    if (msgType === 'raw_sms') {
      const smsBody   = payload.message || '';
      const smsSender = payload.sender  || '';
      console.log(`📱 SMS | sender="${smsSender}" | body="${smsBody}"`);

      const amount = parseSmsAmount(smsBody);
      if (!amount) {
        console.warn(`⚠️  SMS amount not found — ignoring`);
        return;
      }

      const ref    = parseSmsRef(smsBody);
      const device = await getDevice(serialNumber);
      if (!device) { console.warn(`⚠️  Device ${serialNumber} not in DB`); return; }

      // Duplicate check by RRN
      const existing = await prisma.earningRecord.findUnique({ where: { prn: ref } });
      if (existing) {
        console.warn(`⚠️  Duplicate RRN ${ref} — skipping`);
        return;
      }

      await prisma.earningRecord.create({
        data: {
          amount,
          currency:      "NPR",
          description:   `SMS from ${smsSender}: ${smsBody.substring(0, 100)}`,
          category:      "Sales",
          status:        "SUCCESS",
          prn:           ref,
          paymentMethod: "HARDWARE",
          source:        "sms",
          userId:        device.userId,
          deviceId:      device.id
        }
      });
      console.log(`💾 SMS Payment saved: ${amount} NPR | RRN=${ref}`);
      playAudio(serialNumber, amount);
      return;
    }

    // ── 5. CASH ENTRY ─────────────────────────────────────────────────────
    // Enter pressed with no credit user selected
    if (msgType === 'cash_entry') {
      const amount = payload.amount;
      if (!amount) { console.warn(`⚠️  cash_entry missing amount`); return; }

      const device = await getDevice(serialNumber);
      if (!device) { console.warn(`⚠️  Device ${serialNumber} not in DB`); return; }

      const prn = `CASH_${Date.now()}`;
      await prisma.earningRecord.create({
        data: {
          amount:        parseFloat(amount),
          currency:      "NPR",
          description:   "Cash entry from device",
          category:      "Cash",
          status:        "SUCCESS",
          prn,
          paymentMethod: "CASH",
          source:        "device",
          userId:        device.userId,
          deviceId:      device.id
        }
      });
      console.log(`💾 Cash saved: ${amount} NPR | PRN=${prn}`);
      playAudio(serialNumber, amount);
      return;
    }

    // ── 6. CREDIT LIST REQUEST ────────────────────────────────────────────
    // Fn button pressed — respond with credit users via MQTT
    if (msgType === 'credit_list_request') {
      const device = await getDevice(serialNumber);
      if (!device) { console.warn(`⚠️  Device ${serialNumber} not in DB`); return; }
      await sendCreditUserList(serialNumber, device);
      return;
    }

    // ── 7. CREDIT ENTRY ───────────────────────────────────────────────────
    // Enter pressed with a credit user selected.
    // credit_id + direction ("LINA" they owe you, "DINA" you owe them) + amount
    if (msgType === 'credit_entry') {
      const { credit_id, name, amount, direction } = payload;

      if (!credit_id || !amount || !direction) {
        console.warn(`⚠️  credit_entry missing fields: credit_id, amount, or direction`);
        return;
      }

      if (!['LINA', 'DINA'].includes(direction)) {
        console.warn(`⚠️  credit_entry invalid direction "${direction}" — must be LINA or DINA`);
        return;
      }

      const device = await getDevice(serialNumber);
      if (!device) { console.warn(`⚠️  Device ${serialNumber} not in DB`); return; }

      const parsedAmount = parseFloat(amount);

      // LINA = they owe you → totalAmount increases
      // DINA = you owe them → totalAmount decreases
      const delta = direction === 'LINA' ? parsedAmount : -parsedAmount;

      try {
        // 1. Record the individual transaction in EarningRecord
        const prn = `CREDIT_${Date.now()}`;
        await prisma.earningRecord.create({
          data: {
            amount:          parsedAmount,
            currency:        "NPR",
            description:     `Credit entry — ${direction} — ${name}`,
            category:        "Credit",
            status:          "SUCCESS",
            prn,
            paymentMethod:   "CREDIT",
            source:          "device",
            creditDirection: direction,   // "LINA" | "DINA"
            creditId:        credit_id,
            userId:          device.userId,
            deviceId:        device.id
          }
        });

        // 2. Update running balance on the Credit record
        await prisma.credit.update({
          where: { id: credit_id },
          data:  { totalAmount: { increment: delta } }
        });

        console.log(`💾 Credit saved: ${direction} ${parsedAmount} NPR for ${name}`);
        playAudio(serialNumber, parsedAmount);
      } catch (err) {
        console.error("🔥 Credit Save Error:", err.message);
      }
      return;
    }

    // ── 8. DEVICE ACKs (rsp_*) ───────────────────────────────────────────
    if (packetType?.startsWith('rsp_')) {
      console.log(`✅ ${serialNumber} ack: ${packetType}`);
      return;
    }

    console.log(`⚠️  ${serialNumber} unhandled packet_type="${packetType}" type="${msgType}"`);

  } catch (err) {
    console.error("🔥 Relay Error:", err.message, err.stack);
  }
});