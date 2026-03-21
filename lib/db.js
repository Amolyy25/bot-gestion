const { Pool } = require('pg');
require('dotenv').config();

const connectionString = process.env.DATABASE_URL || process.env.INTERNAL_DATABASE_URL;

if (!connectionString) {
    console.error("⚠️ CRITICAL: DATABASE_URL is not defined in environment variables.");
    console.error("Please check your Railway dashboard and ensure the database is linked to the bot service.");
} else {
    console.log("Database connection string found.");
}

const pool = new Pool({
    connectionString: connectionString,
    ssl: connectionString && (connectionString.includes('localhost') || connectionString.includes('127.0.0.1')) ? false : {
        rejectUnauthorized: false
    }
});

const initDb = async () => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        // Table for Invites
        await client.query(`
            CREATE TABLE IF NOT EXISTS invites (
                inviter_id VARCHAR(255),
                invited_member_id VARCHAR(255),
                PRIMARY KEY (inviter_id, invited_member_id)
            )
        `);

        // Table for VIP Codes
        await client.query(`
            CREATE TABLE IF NOT EXISTS vip_codes (
                code VARCHAR(255) PRIMARY KEY,
                claimed BOOLEAN DEFAULT FALSE,
                timestamp BIGINT
            )
        `);

        // Table for Ticket Queue
        await client.query(`
            CREATE TABLE IF NOT EXISTS ticket_queue (
                user_id VARCHAR(255) PRIMARY KEY,
                type VARCHAR(50),
                timestamp BIGINT
            )
        `);

        // Table for Soumis Roles & Nicknames
        await client.query(`
            CREATE TABLE IF NOT EXISTS soumis_data (
                user_id VARCHAR(255) PRIMARY KEY,
                roles JSONB,
                nickname VARCHAR(255)
            )
        `);

        // Table for Staff Quotas (Tracking actions)
        await client.query(`
            CREATE TABLE IF NOT EXISTS staff_quotas (
                id SERIAL PRIMARY KEY,
                staff_id VARCHAR(255),
                action_type VARCHAR(50),
                timestamp BIGINT
            )
        `);

        await client.query('COMMIT');
        console.log("Database tables initialized successfully.");
    } catch (err) {
        await client.query('ROLLBACK');
        console.error("Error initializing database tables:", err);
        throw err;
    } finally {
        client.release();
    }
};

module.exports = {
    pool,
    initDb,
    query: (text, params) => pool.query(text, params),
};
