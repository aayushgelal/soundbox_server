// --- UPDATED MESSAGE HANDLER ---
client.on('message', async (topic, message) => {
  const serialNumber = topic.split('/').filter(p => p && p !== 'LLZN')[0];
  let payload;
  
  try {
    payload = JSON.parse(message.toString());
  } catch (e) { return; }

  // 1. Only respond to the initial payment request
  if (payload.packet_type !== 'request_payment') return;

  const deviceMsgId = payload.message_id; // Capture the ID the device is waiting for
  const amount = payload.content ? payload.content.amount_due : null;

  if (!serialNumber || amount === null) return;

  console.log(`[REQ] ${serialNumber} requesting NPR ${amount}`);

  try {
    const device = await prisma.device.findUnique({
      where: { serialNumber: serialNumber },
      include: { user: true }
    });

    if (!device) return;

    // Use a pure numeric string for Order ID as seen in protocol examples [cite: 178, 262]
    const currentOrderId = Date.now().toString();

    // --- STEP 1: SEND RESPONSE PACKET (Clears "Connecting" Screen) ---
    // We reply using the device's original message_id to acknowledge receipt
    const rspPacket = {
      "message_id": deviceMsgId, 
      "time_stamp": getTimestamp(),
      "device_sn": serialNumber,
      "packet_type": "rsp_request_payment", 
      "content": { "response_status": "success" }
    };
    client.publish(`${serialNumber}/pubmsg`, JSON.stringify(rspPacket));

    // --- STEP 2: PUSH DYNAMIC QR (wait_payment) --- [cite: 175]
    // A small delay (200ms) ensures the device processes the RSP packet first
    setTimeout(() => {
      const waitPaymentPacket = {
        "message_id": getMsgId(), // NEW unique ID [cite: 201]
        "time_stamp": getTimestamp(),
        "device_sn": serialNumber,
        "packet_type": "wait_payment",
        "content": {
          "amount_due": parseFloat(amount),
          "order_id": currentOrderId,
          "payment_timeout": 60, // Default timeout [cite: 209]
          "screen_content_config": {
            "wait_payment_screen_qrcode_1_config": {
              "txt": device.fonepayMerchantCode, 
              "hei": 210 // Max height [cite: 213]
            },
            "wait_payment_screen_label_3_config": {
              "txt": `${amount} NPR`,
              "hei": 24, // Medium font [cite: 232]
              "col": "FF0000" // Red [cite: 245-246]
            }
          }
        }
      };
      client.publish(`${serialNumber}/pubmsg`, JSON.stringify(waitPaymentPacket));
      console.log(`[QR_SENT] Pushed wait_payment to ${serialNumber}`);
    }, 200);

    // --- STEP 3: SUCCESS ANNOUNCEMENT (payment) --- [cite: 21, 259]
    setTimeout(() => {
      const paymentPacket = {
        "message_id": getMsgId(), // NEW unique ID [cite: 27]
        "time_stamp": getTimestamp(),
        "device_sn": serialNumber,
        "packet_type": "payment",
        "content": {
          "play_payment_amount": parseFloat(amount),
          "order_id": currentOrderId // MUST match Step 2 
        }
      };
      client.publish(`${serialNumber}/pubmsg`, JSON.stringify(paymentPacket));
      console.log(`[PAID] Success announcement sent to ${serialNumber}`);
    }, 4000);

  } catch (err) {
    console.error(`Relay Error:`, err.message);
  }
});