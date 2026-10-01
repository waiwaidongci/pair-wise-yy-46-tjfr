import { buildSnapshot, computeReserve, firstSignedApprovalIndex, nextBatchNo, nowText, INIT_BATCH_NO } from './batch'
import type { BatchCommitBody, BatchConflict, ClaimCase, LossBatch } from './models'

export type EngineResult = { status: number; body: unknown }

export type RequestLog = Map<string, { status: number; body: unknown }>

/** 案件列表（分页/过滤） */
export function engineList(
  claims: ClaimCase[],
  filters: { query: string; status: string; risk: string; page: number; pageSize: number },
): EngineResult {
  const filtered = claims.filter(
    (item) =>
      (!filters.query || `${item.id}${item.insured}${item.policyNo}`.toLowerCase().includes(filters.query.toLowerCase())) &&
      (!filters.status || item.status === filters.status) &&
      (!filters.risk || item.riskLevel === filters.risk),
  )
  const start = (filters.page - 1) * filters.pageSize
  return {
    status: 200,
    body: { items: filtered.slice(start, start + filters.pageSize), total: filtered.length, page: filters.page, pageSize: filters.pageSize },
  }
}

export function engineGet(claims: ClaimCase[], id: string): EngineResult | null {
  const item = claims.find((claim) => claim.id === id)
  return item ? { status: 200, body: item } : null
}

/** 取批次号：调整报价或责任比例前先取号 */
export function engineOpenBatch(claims: ClaimCase[], id: string): EngineResult {
  const claim = claims.find((c) => c.id === id)
  if (!claim) return { status: 404, body: { ok: false, error: '案件不存在' } }
  const { batchNo, version } = nextBatchNo(claim)
  const batch: LossBatch = {
    batchNo,
    claimId: claim.id,
    version,
    status: '草稿',
    createdAt: nowText(),
    createdBy: '当前用户',
    changes: [],
    invalidatedApprovals: [],
    snapshot: buildSnapshot(claim),
  }
  claim.batches = [...(claim.batches ?? []), batch]
  return { status: 201, body: { batchNo, version, claimId: claim.id } }
}

/**
 * 批次提交：损失科目、准备金、附件版本、会签状态一起提交。
 * - 按请求编号幂等：重试沿用第一次结果，不重复追加附件、审计或准备金。
 * - 先到先得：同一科目只放行先到的一笔，后到的一笔列出被改对象并保留草稿。
 * - 科目、报价或附件版本一变，受影响的已完成会签立即失效，从首个受影响档位重签。
 */
export function engineCommit(claims: ClaimCase[], id: string, batchNo: string, body: BatchCommitBody, requestLog: RequestLog): EngineResult {
  // 幂等：同一请求编号重试，沿用第一次结果
  if (requestLog.has(body.requestId)) {
    const logged = requestLog.get(body.requestId)!
    return { status: logged.status, body: { ...(logged.body as object), deduped: logged.status === 200 } }
  }

  const claim = claims.find((c) => c.id === id)
  const batch = claim?.batches?.find((b) => b.batchNo === batchNo)
  if (!claim || !batch) return { status: 404, body: { ok: false, error: '批次不存在' } }

  // 先到先得冲突校验
  const conflicts: BatchConflict[] = []
  for (const change of body.items.filter((item) => item.changed)) {
    const serverItem = claim.lossItems.find((item) => item.id === change.itemId)
    if (!serverItem) continue
    if (serverItem.baselineBatchNo !== change.baseBatchNo || serverItem.repairQuotes.length !== change.baseQuoteVersion) {
      conflicts.push({
        itemId: serverItem.id,
        category: serverItem.category,
        batchNo: serverItem.baselineBatchNo ?? INIT_BATCH_NO,
        modifiedBy: serverItem.lastModifiedBy ?? '初始版本',
        modifiedAt: serverItem.lastModifiedAt ?? '—',
      })
    }
  }
  if (conflicts.length > 0) {
    const result = { ok: false, conflict: true, batchNo, conflicts }
    requestLog.set(body.requestId, { status: 409, body: result })
    return { status: 409, body: result }
  }

  // 应用批次变更
  const changes: string[] = []
  for (const change of body.items) {
    const serverItem = claim.lossItems.find((item) => item.id === change.itemId)
    if (!serverItem) continue

    if (change.newQuote) {
      serverItem.repairQuotes.push({
        version: serverItem.repairQuotes.length + 1,
        amount: change.newQuote.amount,
        reason: change.newQuote.reason,
        operator: body.operator,
        createdAt: nowText(),
      })
      changes.push(`${serverItem.category} 报价调整为 ${change.newQuote.amount.toLocaleString('zh-CN')} 元（${change.newQuote.reason}）`)
    }
    if (change.changed && change.liability !== serverItem.liability) {
      changes.push(`${serverItem.category} 责任比例由 ${serverItem.liability} 调整为 ${change.liability}`)
      serverItem.liability = change.liability
    }
    if (change.changed && change.salvage !== serverItem.salvage) {
      changes.push(`${serverItem.category} 残值由 ${serverItem.salvage.toLocaleString('zh-CN')} 调整为 ${change.salvage.toLocaleString('zh-CN')} 元`)
      serverItem.salvage = change.salvage
    }
    // 附件版本只增不减
    for (const attachmentChange of change.attachmentVersions) {
      const serverAttachment = serverItem.attachments.find((a) => a.id === attachmentChange.attachmentId)
      if (serverAttachment && attachmentChange.version > serverAttachment.version) {
        changes.push(`${serverItem.category} 附件 ${serverAttachment.name} 版本 V${serverAttachment.version} → V${attachmentChange.version}`)
        serverAttachment.version = attachmentChange.version
      }
    }
    if (change.changed) {
      serverItem.baselineBatchNo = batchNo
      serverItem.lastModifiedBy = body.operator
      serverItem.lastModifiedAt = nowText()
    }
  }

  // 准备金随批次重算
  const oldReserve = claim.reserve
  claim.reserve = computeReserve(claim)
  if (claim.reserve !== oldReserve) {
    changes.push(`准备金由 ${oldReserve.toLocaleString('zh-CN')} 元调整为 ${claim.reserve.toLocaleString('zh-CN')} 元`)
  }

  // 会签失效：从首个受影响档位起全部作废，需重签
  const invalidatedApprovals: string[] = []
  const firstSigned = firstSignedApprovalIndex(claim)
  if (firstSigned >= 0) {
    for (let i = firstSigned; i < claim.approvals.length; i++) {
      const step = claim.approvals[i]
      if (step.status === '已通过') {
        invalidatedApprovals.push(step.role)
        step.status = '待处理'
        step.operator = undefined
        step.comment = undefined
        step.completedAt = undefined
        step.signedBatchNo = undefined
        step.invalidated = true
      }
    }
    claim.audit.push({
      id: `A-${Date.now()}-inv`,
      at: nowText(),
      operator: '系统',
      action: '会签失效',
      detail: `批次 ${batchNo} 变更生效，已完成会签自首个受影响档位「${claim.approvals[firstSigned].role}」起失效，请重新会签。`,
    })
  }

  for (const text of changes) {
    claim.audit.push({
      id: `A-${Date.now()}-${claim.audit.length}`,
      at: nowText(),
      operator: body.operator,
      action: '批次变更',
      detail: `${batchNo}：${text}`,
    })
  }

  claim.baselineBatchNo = batchNo
  batch.status = '已提交'
  batch.requestId = body.requestId
  batch.changes = changes
  batch.invalidatedApprovals = invalidatedApprovals
  batch.snapshot = buildSnapshot(claim)

  const result = { ok: true, deduped: false, batchNo, version: batch.version, claim, invalidatedApprovals, conflicts: [] }
  requestLog.set(body.requestId, { status: 200, body: result })
  return { status: 200, body: result }
}

/** 会签：按批次顺序从首个受影响档位重签，通过时记录所依据的批次号 */
export function engineApprove(
  claims: ClaimCase[],
  id: string,
  body: { role: string; result: string; comment: string; batchNo: string },
): EngineResult {
  const claim = claims.find((c) => c.id === id)
  const stepIndex = claim?.approvals.findIndex((approval) => approval.role === body.role)
  if (!claim || stepIndex === undefined || stepIndex < 0) return { status: 404, body: { ok: false, error: '会签档位不存在' } }

  const firstPending = claim.approvals.findIndex((approval) => approval.status === '待处理')
  if (stepIndex > firstPending) {
    return { status: 409, body: { ok: false, error: '请从首个受影响档位重签', firstRole: claim.approvals[firstPending].role } }
  }

  const step = claim.approvals[stepIndex]
  step.status = body.result === '已通过' ? '已通过' : '已退回'
  step.operator = '当前用户'
  step.comment = body.comment
  step.completedAt = nowText()
  step.invalidated = false
  if (body.result === '已通过') step.signedBatchNo = body.batchNo
  claim.audit.push({
    id: `A-${Date.now()}`,
    at: nowText(),
    operator: '当前用户',
    action: `会签${step.status}`,
    detail: `${body.comment}（依据批次 ${body.batchNo}）`,
  })
  claim.status = body.result === '已通过' ? '审批中' : '退回补件'
  return { status: 200, body: { ok: true, claim } }
}
