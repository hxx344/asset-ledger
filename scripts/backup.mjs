import { DatabaseSync, backup } from 'node:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
const source = resolve(process.env.ASSET_DATA_DIR || '.data', 'ledger.sqlite');
const target = process.argv[2];
if (!target) throw new Error('Provide a backup destination');
if (existsSync(source)) {
  mkdirSync(dirname(resolve(target)), { recursive: true });
  const database = new DatabaseSync(source, { readOnly: true });
  try { await backup(database, resolve(target)); } finally { database.close(); }
  console.log('数据库备份完成。');
}
