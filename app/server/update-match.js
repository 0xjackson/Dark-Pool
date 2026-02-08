#!/usr/bin/env node
/**
 * Update match status to PENDING for retry
 */
const { Client } = require('pg');

const MATCH_ID = 'ef4b6aaa-3547-477d-87e3-2ff30c87960d';
const DATABASE_URL = 'postgresql://postgres:WOpqgAvjmMjRXzgMPmOiRPQtnBMRCQVg@interchange.proxy.rlwy.net:22517/railway';

async function main() {
  const client = new Client({
    connectionString: DATABASE_URL,
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

    console.log('Before:');
    console.log('  Status:', current.rows[0].settlement_status);
    console.log('  Error:', current.rows[0].settlement_error);
    console.log('');

    // Reset to PENDING
    await client.query(
      `UPDATE matches
       SET settlement_status = 'PENDING',
           settlement_error = NULL
       WHERE id = $1`,
      [MATCH_ID]
    );

    // Verify update
    const after = await client.query(
      'SELECT id, settlement_status, settlement_error FROM matches WHERE id = $1',
      [MATCH_ID]
    );

    console.log('After:');
    console.log('  Status:', after.rows[0].settlement_status);
    console.log('  Error:', after.rows[0].settlement_error);
    console.log('');
    console.log('✓ Match reset to PENDING');
    console.log('  Settlement worker will retry within 2 seconds!');

  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  } finally {
    await client.end();
  }
}

main();
