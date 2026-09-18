/**
 * 数据库迁移入口：建表 + 初始化管理员。
 * 运行：npm run migrate --workspace server
 */
import { applySchema, seedAdmin, closeDb } from './index.js';

applySchema();
seedAdmin();
closeDb();
console.log('✅ 数据库迁移完成');
