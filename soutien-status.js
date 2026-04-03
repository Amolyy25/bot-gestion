const { EmbedBuilder } = require('discord.js');

// ─── Configuration ───────────────────────────────────────────────
const ROLE_SOUTIEN_ID = '1489729337191305439';      // ID du rôle "Soutien"
const GENERAL_CHANNEL_ID = '1483231963308494920';   // ID du salon général
const GUILD_ID = '1483226900016009427';             // ID du serveur
const SCAN_INTERVAL = 5 * 60 * 1000;       // 5 minutes

// Regex pour capturer les codes d'invitation Discord
const INVITE_REGEX = /(?:discord\.gg|discord\.com\/invite|discordapp\.com\/invite)\/([a-zA-Z0-9-]+)/gi;

/**
 * Extrait les codes d'invitation du texte d'un statut personnalisé.
 */
function extractInviteCodes(text) {
    if (!text) return [];
    const codes = [];
    let match;
    while ((match = INVITE_REGEX.exec(text)) !== null) {
        codes.push(match[1]);
    }
    INVITE_REGEX.lastIndex = 0;
    return codes;
}

/**
 * Récupère le texte du Custom Status d'un membre à partir de sa presence.
 */
function getCustomStatusText(presence) {
    if (!presence || !presence.activities) return null;
    const customStatus = presence.activities.find(a => a.type === 4);
    return customStatus?.state || null;
}

/**
 * Vérifie si au moins un code d'invitation pointe vers notre serveur.
 */
async function hasValidInvite(client, codes) {
    for (const code of codes) {
        try {
            const invite = await client.fetchInvite(code);
            if (invite.guild && invite.guild.id === GUILD_ID) {
                return true;
            }
        } catch {
            // Invitation invalide ou expirée, on ignore
        }
    }
    return false;
}

/**
 * Traite un membre : attribue ou retire le rôle Soutien.
 * @param {boolean} announce - Si true, envoie un embed de félicitations.
 */
async function processMember(client, member, announce = true) {
    const statusText = getCustomStatusText(member.presence);
    const codes = extractInviteCodes(statusText);
    const hasRole = member.roles.cache.has(ROLE_SOUTIEN_ID);

    if (codes.length > 0) {
        const valid = await hasValidInvite(client, codes);
        if (valid && !hasRole) {
            await member.roles.add(ROLE_SOUTIEN_ID).catch(console.error);
            if (announce) {
                const channel = client.channels.cache.get(GENERAL_CHANNEL_ID);
                if (channel) {
                    const embed = new EmbedBuilder()
                        .setColor(0x57F287)
                        .setTitle('Merci pour ton soutien !')
                        .setDescription(`${member} a ajouté un lien d'invitation du serveur dans son statut et obtient le rôle <@&${ROLE_SOUTIEN_ID}> ! Rend toi ici <#1489729747901743195> pour avoir des nudes gratuit de <@1172869002670903422> et <@1285621421304971285>`)
                        .setThumbnail(member.user.displayAvatarURL({ dynamic: true }))
                        .setTimestamp();
                    channel.send({ embeds: [embed] }).catch(console.error);
                }
            }
            console.log(`[Soutien] Rôle ajouté à ${member.user.tag}`);
        } else if (!valid && hasRole) {
            await member.roles.remove(ROLE_SOUTIEN_ID).catch(console.error);
            console.log(`[Soutien] Rôle retiré de ${member.user.tag} (invitation invalide)`);
        }
    } else if (hasRole) {
        await member.roles.remove(ROLE_SOUTIEN_ID).catch(console.error);
        console.log(`[Soutien] Rôle retiré de ${member.user.tag} (plus de lien dans le statut)`);
    }
}

/**
 * Scan tous les membres du serveur.
 */
async function scanAllMembers(client) {
    const guild = client.guilds.cache.get(GUILD_ID);
    if (!guild) return;

    console.log('[Soutien] Scan des membres en cours...');
    const members = await guild.members.fetch({ withPresences: true });

    for (const [, member] of members) {
        if (member.user.bot) continue;
        await processMember(client, member, false);
    }
    console.log('[Soutien] Scan terminé.');
}

/**
 * Point d'entrée du module. À appeler depuis le fichier principal.
 */
function init(client) {
    // Écouter les changements de présence
    client.on('presenceUpdate', async (oldPresence, newPresence) => {
        if (!newPresence || !newPresence.member) return;
        if (newPresence.guild?.id !== GUILD_ID) return;
        if (newPresence.member.user.bot) return;

        const oldText = getCustomStatusText(oldPresence);
        const newText = getCustomStatusText(newPresence);

        // Ne traiter que si le Custom Status a changé
        if (oldText === newText) return;

        await processMember(client, newPresence.member, true);
    });

    // Scan initial au démarrage + scan périodique
    client.once('ready', () => {
        console.log('[Soutien] Module initialisé.');
        scanAllMembers(client);
        setInterval(() => scanAllMembers(client), SCAN_INTERVAL);
    });
}

module.exports = { init };
