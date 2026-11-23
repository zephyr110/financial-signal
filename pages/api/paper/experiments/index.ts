import type { NextApiRequest, NextApiResponse } from 'next'
import { ensureMethod, ensureSameOrigin, sendError } from '../../../../lib/cockpit/api'
import { getDb } from '../../../../lib/db'
import { bodyObject, sendPaperData, sendPaperError } from '../../../../lib/paper/api'
import {
  createDefaultPaperExperiment,
  listPaperExperimentHistory,
} from '../../../../lib/paper/experiment'
import { getCurrentPaperExperiment } from '../../../../lib/paper/repo'

/** GET /api/paper/experiments —— 实验列表；POST —— 锁定协议并开始新实验。 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!ensureMethod(req, res, ['GET', 'POST'])) return
  try {
    if (req.method === 'GET') {
      const db = await getDb()
      const [current, rows] = await Promise.all([
        getCurrentPaperExperiment(),
        db.execute({
          sql: `SELECT id, name, status, protocol_version, policy_version, benchmark_code,
                       initial_cash_cents, valid_days, reset_count, reset_of, pause_reason,
                       started_at, planned_end_at, ended_at, created_at, updated_at
                FROM paper_experiments ORDER BY created_at DESC`,
          args: [],
        }),
      ])
      const experiments = rows.rows.map((row) => ({
        id: String(row.id),
        name: String(row.name),
        status: String(row.status),
        protocolVersion: String(row.protocol_version),
        policyVersion: String(row.policy_version),
        benchmarkCode: String(row.benchmark_code),
        initialCashCents: Number(row.initial_cash_cents),
        validDays: Number(row.valid_days),
        resetCount: Number(row.reset_count),
        resetOf: row.reset_of == null ? null : String(row.reset_of),
        pauseReason: row.pause_reason == null ? null : String(row.pause_reason),
        startedAt: row.started_at == null ? null : String(row.started_at),
        plannedEndAt: row.planned_end_at == null ? null : String(row.planned_end_at),
        endedAt: row.ended_at == null ? null : String(row.ended_at),
        createdAt: String(row.created_at),
        updatedAt: String(row.updated_at),
      }))
      return sendPaperData(res, 200, {
        currentId: current?.id ?? null,
        experiments,
        history: current ? await listPaperExperimentHistory(current.id) : [],
      })
    }

    if (!ensureSameOrigin(req)) return sendError(req, res, 403, 'ORIGIN_MISMATCH', '拒绝跨站写入')
    const body = bodyObject(req.body)
    if (body.protocol !== undefined) {
      return sendError(req, res, 400, 'INVALID_INPUT', '协议由服务端锁定，不能自带')
    }
    const created = await createDefaultPaperExperiment({
      name: typeof body.name === 'string' ? body.name : undefined,
      initialCashCents: body.initialCashCents == null ? undefined : Number(body.initialCashCents),
      benchmarkCode: typeof body.benchmarkCode === 'string' ? body.benchmarkCode : undefined,
      plannedTradingDays: body.plannedTradingDays == null ? undefined : Number(body.plannedTradingDays),
      protocolVersion: typeof body.protocolVersion === 'string' ? body.protocolVersion : undefined,
      protocolNote: typeof body.protocolNote === 'string' ? body.protocolNote : undefined,
    })
    return sendPaperData(res, 201, created)
  } catch (err) {
    return sendPaperError(req, res, err)
  }
}
