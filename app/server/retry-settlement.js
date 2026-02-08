#!/usr/bin/env node
/**
 * Reset a failed match to PENDING for retry
 */

const { Client } = require('pg');

const MATCH_ID = 'ef4b6aaa-3547-477d-87e3-2ff30c87960d';

async function main() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: {
      rejectUnauthorized: false
    }
  });

  try {
    await client.connect();
    console.log('✓ Connected to database\n');

    // Check current status
    const current = await client.query(
      'SELECT id, settlement_status, settlement_error FROM matches WHERE id = $1',
      [MATCH_ID]
    );

    if (current.rows.length === 0) {
      console.error('❌ Match not found:', MATCH_ID);
      process.exit(1);
    }

    console.log('Current status:', current.rows[0].settlement_status);
    console.log('Error:', current.rows[0].settlement_error);
    console.log('');

    // Reset to PENDING
    const result = await client.query(
      `UPDATE matches
       SET settlement_status = 'PENDING',
           settlement_error = NULL
       WHERE id = $1
       RETURNING *`,
      [MATCH_ID]
    );

    console.log('✓ Match reset to PENDING');
    console.log('  Settlement worker will retry on next tick (~10s)');
    console.log('');

  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  } finally {
    await client.end();
  }
}

main();
