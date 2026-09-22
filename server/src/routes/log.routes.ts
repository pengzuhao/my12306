import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import { currentUser } from './auth.routes.js';
import { redact } from '../logger.js';
const schema = z.object({
  page: z.coerce.number().int().min(1).max(1000000).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(30),
  level: z.enum(['', 'debug', 'info', 'warn', 'error']).optional(), category: z.string().max(60).optional(),
  keyword: z.string().max(200).optional(), userId: z.string().max(100).optional(),
  from: z.string().datetime({ offset: true }).optional(), to: z.string().datetime({ offset: true }).optional(),
  format: z.enum(['csv', 'json']).default('csv'),
});
function clean(row: Record<string, unknown>): Record<string, unknown> {
  let detail: unknown = row.detail;
  try { if (typeof detail === 'string') detail = JSON.parse(detail); } catch { /* 兼容旧日志 */ }
  return { ...row, message: redact(row.message), detail: redact(detail) };
}
export const logRoutes: FastifyPluginAsync = async app => {
  for (const exporting of [false, true]) app.get(exporting ? '/api/logs/export' : '/api/logs', async (request, reply) => {
    const parsed = schema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: '筛选参数不正确' });
    const q = parsed.data, user = currentUser(request), where: string[] = [], values: (string | number)[] = [];
    const userId = user.role === 'admin' ? q.userId : user.id;
    if (userId) { where.push('user_id = ?'); values.push(userId); }
    if (q.level) { where.push('level = ?'); values.push(q.level); }
    if (q.category) { where.push('category = ?'); values.push(q.category); }
    if (q.keyword) { where.push("(message LIKE ? ESCAPE '\\' OR detail LIKE ? ESCAPE '\\')"); const key = '%' + q.keyword.replace(/[\\%_]/g, '\\$&') + '%'; values.push(key, key); }
    if (q.from) { where.push('julianday(created_at) >= julianday(?)'); values.push(q.from); }
    if (q.to) { where.push('julianday(created_at) <= julianday(?)'); values.push(q.to); }
    if (q.from && q.to && Date.parse(q.from) > Date.parse(q.to)) return reply.code(400).send({ error: '开始时间不能晚于结束时间' });
    const clause = where.length ? ` WHERE ${where.join(' AND ')}` : '';
    const db = getDb(), total = (db.prepare(`SELECT count(*) AS n FROM logs${clause}`).get(...values) as { n: number }).n;
    if (exporting && total > 50000) return reply.code(400).send({ error: '匹配超过 5 万条，请缩小时间范围后导出' });
    const rows = db.prepare(`SELECT * FROM logs${clause} ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`).all(...values, exporting ? 50000 : q.pageSize, exporting ? 0 : (q.page - 1) * q.pageSize) as Record<string, unknown>[];
    const items = rows.map(clean);
    if (!exporting) return { items, total, page: q.page, pageSize: q.pageSize };
    reply.header('Content-Disposition', `attachment; filename="my12306-logs-${new Date().toISOString().slice(0, 10)}.${q.format}"`);
    if (q.format === 'json') return reply.type('application/json; charset=utf-8').send(JSON.stringify(items, null, 2));
    const cell = (v: unknown) => { let s = typeof v === 'object' && v ? JSON.stringify(v) : String(v ?? ''); if (/^[\s]*[=+@-]/.test(s)) s = "'" + s; return '"' + s.replace(/"/g, '""') + '"'; };
    const lines = [['时间（北京时间）', '级别', '分类', '用户', '内容', '详情'], ...items.map(r => [new Date(String(r.created_at).replace(' ', 'T') + (/[Zz]|[+-]\d\d:\d\d$/.test(String(r.created_at)) ? '' : 'Z')).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }), r.level, r.category, r.user_id, r.message, r.detail])];
    return reply.type('text/csv; charset=utf-8').send('\uFEFF' + lines.map(r => r.map(cell).join(',')).join('\r\n'));
  });
};
