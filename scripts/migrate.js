const fs = require('fs');
const path = require('path');
const { initDb, query } = require('../lib/db');

async function migrate() {
    console.log("Starting migration...");
    await initDb();

    // 1. Migrate Invites
    const invitesPath = path.join(__dirname, '../invites.json');
    if (fs.existsSync(invitesPath)) {
        const invitesData = JSON.parse(fs.readFileSync(invitesPath, 'utf8'));
        console.log(`Migrating ${Object.keys(invitesData).length} inviters...`);
        for (const [inviterId, invitedIds] of Object.entries(invitesData)) {
            for (const invitedId of invitedIds) {
                await query(
                    'INSERT INTO invites (inviter_id, invited_member_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
                    [inviterId, invitedId]
                );
            }
        }
    }

    // 2. Migrate Codes
    const codesPath = path.join(__dirname, '../codes.json');
    if (fs.existsSync(codesPath)) {
        const codesData = JSON.parse(fs.readFileSync(codesPath, 'utf8'));
        if (codesData.codes) {
            console.log(`Migrating ${codesData.codes.length} codes...`);
            for (const item of codesData.codes) {
                await query(
                    'INSERT INTO vip_codes (code, claimed, timestamp) VALUES ($1, $2, $3) ON CONFLICT (code) DO UPDATE SET claimed = EXCLUDED.claimed, timestamp = EXCLUDED.timestamp',
                    [item.code, item.claimed, item.timestamp]
                );
            }
        }
    }

    // 3. Migrate Tickets
    const ticketsPath = path.join(__dirname, '../tickets.json');
    if (fs.existsSync(ticketsPath)) {
        const ticketsData = JSON.parse(fs.readFileSync(ticketsPath, 'utf8'));
        if (ticketsData.queue) {
            console.log(`Migrating ${ticketsData.queue.length} ticket queue items...`);
            for (const item of ticketsData.queue) {
                await query(
                    'INSERT INTO ticket_queue (user_id, type, timestamp) VALUES ($1, $2, $3) ON CONFLICT (user_id) DO NOTHING',
                    [item.userId, item.type, item.timestamp || Date.now()]
                );
            }
        }
    }

    // 4. Migrate Soumis Roles
    const soumisPath = path.join(__dirname, '../soumis_roles.json');
    if (fs.existsSync(soumisPath)) {
        const soumisData = JSON.parse(fs.readFileSync(soumisPath, 'utf8'));
        console.log(`Migrating ${Object.keys(soumisData).length} soumis users...`);
        for (const [userId, data] of Object.entries(soumisData)) {
            await query(
                'INSERT INTO soumis_data (user_id, roles, nickname) VALUES ($1, $2, $3) ON CONFLICT (user_id) DO UPDATE SET roles = EXCLUDED.roles, nickname = EXCLUDED.nickname',
                [userId, JSON.stringify(data.roles), data.nickname]
            );
        }
    }

    console.log("Migration completed successfully.");
    process.exit(0);
}

migrate().catch(err => {
    console.error("Migration failed:", err);
    process.exit(1);
});
