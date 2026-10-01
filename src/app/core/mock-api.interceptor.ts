import { HttpErrorResponse, HttpInterceptorFn, HttpResponse } from '@angular/common/http'
import { delay, of, throwError } from 'rxjs'
import {
  calculateReserve,
  cloneClaim,
  invalidateApprovals,
  makeBaselineBatch,
  nextBatchNo,
  normalizeClaim,
  nowText,
} from './baseline'
import { seedClaims } from './seed'
import type {
  BaselineBatch,
  BatchCommitResult,
  BatchConflict,
  BatchConflictItem,
  BatchHistoryEntry,
  BatchSaveRequest,
  ClaimCase,
  LegacyClaim,
  LossItem,
} from './models'

let claims: ClaimCase[] = (seedClaims as LegacyClaim[]).map(normalizeClaim)
const batchesByNo = new Map<string, BaselineBatch>()
const activeBatchNoByClaim: Record<string, string> = {}
const commitResultsByRequest = new Map<string, BatchCommitResult>()

function json<T>(body: T, status = 200, delayMs = 180) {
  return of(new HttpResponse<T>({ status, body: structuredClone(body) })).pipe(delay(delayMs))
}

function error(status: number, code: string, message: string, extra: Record<string, unknown> = {}) {
  return throwError(() => new HttpErrorResponse({ status, error: { code, message, ...extra } }))
}

function findClaim(id: string | undefined) {
  return claims.find((claim) => claim.id === id)
}

function changedFields(base: BaselineBatch['items'][number], submitted: BatchSaveRequest['items'][number], item: LossItem) {
  const fields: string[] = []
  if (base.damage !== submitted.damage) fields.push('损失事实')
  if (base.salvage !== submitted.salvage) fields.push('残值')
  if (base.liability !== submitted.liability) fields.push('责任比例')
  if (submitted.newQuote || base.quoteVersion !== item.latestQuoteVersion) fields.push('修复报价')
  if (base.evidenceVersion !== item.evidenceVersion || submitted.attachments.length !== base.attachmentIds.length) fields.push('附件版本')
  return fields
}

function addHistory(
  claim: ClaimCase,
  entry: Omit<BatchHistoryEntry, 'snapshot' | 'source'> & { source?: 'legacy' | 'batch' },
  before: ClaimCase,
) {
  const snapshot = cloneClaim(before)
  snapshot.batchHistory = []
  claim.batchHistory.push({ ...entry, source: entry.source ?? 'batch', snapshot })
}

function commitBatch(claim: ClaimCase, batch: BaselineBatch, body: BatchSaveRequest): BatchCommitResult {
  const previousBatchNo = claim.batchNo
  const reserveBefore = claim.reserve
  const newBatchNo = batch.batchNo
  const before = cloneClaim(claim)
  const changedItemIds: string[] = []
  let addedAttachmentIds: string[] = []

  for (const submitted of body.items) {
    const item = claim.lossItems.find((candidate) => candidate.id === submitted.itemId)
    const base = batch.items.find((candidate) => candidate.itemId === submitted.itemId)
    if (!item || !base) continue

    const fields: string[] = []
    if (base.damage !== submitted.damage) fields.push('损失事实')
    if (base.salvage !== submitted.salvage) fields.push('残值')
    if (base.liability !== submitted.liability) fields.push('责任比例')

    let changedQuote = false
    if (submitted.newQuote) {
      const version = item.repairQuotes.length + 1
      item.repairQuotes.push({
        id: `Q-${claim.id}-${version}`,
        version,
        amount: submitted.newQuote.amount,
        reason: submitted.newQuote.reason,
        operator: submitted.newQuote.operator,
        createdAt: submitted.newQuote.createdAt,
        batchNo: newBatchNo,
        requestId: body.requestId,
      })
      item.latestQuoteVersion = version
      changedQuote = true
      fields.push('修复报价')
    } else if (base.quoteVersion !== item.latestQuoteVersion) {
      changedQuote = true
      fields.push('修复报价')
    }

    const existingAttachmentIds = new Set(item.attachments.map((file) => file.id))
    const newAttachments = submitted.attachments.filter((file) => !existingAttachmentIds.has(file.id))
    if (newAttachments.length) {
      let nextVersion = item.evidenceVersion
      newAttachments.forEach((file, index) => {
        nextVersion += 1
        const finalFile = {
          ...file,
          id: `AT-${claim.id.replaceAll('CLM-', '')}-${Date.now()}-${index}`,
          version: nextVersion,
        }
        item.attachments.push(finalFile)
        addedAttachmentIds.push(finalFile.id)
      })
      fields.push('附件版本')
    } else if (base.evidenceVersion !== item.evidenceVersion) {
      fields.push('附件版本')
    }

    item.damage = submitted.damage
    item.salvage = submitted.salvage
    item.liability = submitted.liability
    item.evidenceVersion = Math.max(item.evidenceVersion, ...item.attachments.map((file) => file.version))
    item.batchNo = newBatchNo

    const changed = fields.length > 0
    if (changed) {
      item.revision += 1
      changedItemIds.push(item.id)
    }

    if (changedQuote || addedAttachmentIds.length || fields.includes('损失事实') || fields.includes('残值') || fields.includes('责任比例')) {
      // 变更已逐项落账；保留判断分支使报价、证据和科目字段都进入同一次批次提交。
    }
  }

  const reserveAfter = calculateReserve(claim)
  claim.reserve = reserveAfter
  claim.baselineReserve = reserveBefore
  claim.batchNo = newBatchNo
  claim.batchVersion += 1

  let invalidatedFromRole: string | undefined
  const reserveChanged = reserveBefore !== reserveAfter
  if (changedItemIds.length || reserveChanged) {
    const reason = `批次 ${newBatchNo} 修改了损失科目、报价、准备金或附件版本，旧会签结论停止放行`
    const invalidIndex = invalidateApprovals(claim.approvals, reserveBefore, reserveAfter, newBatchNo, reason)
    invalidatedFromRole = claim.approvals[invalidIndex]?.role
    if (invalidatedFromRole) claim.status = '待复核'
  }

  const auditId = `A-${newBatchNo}`
  const changedNames = body.items
    .filter((item) => changedItemIds.includes(item.itemId))
    .map((item) => `${item.itemId}(${item.damage.slice(0, 12) || item.itemId})`)
    .join('、')
  claim.audit.push({
    id: auditId,
    at: nowText(),
    operator: '当前用户',
    action: '基线定损批次提交',
    detail:
      `${newBatchNo} 一次性提交损失科目、准备金、附件版本和会签状态；` +
      `准备金 ${reserveBefore.toLocaleString('zh-CN')} → ${reserveAfter.toLocaleString('zh-CN')}；` +
      `变更科目：${changedNames || '无'}；新增附件 ${addedAttachmentIds.length} 个；` +
      (invalidatedFromRole ? `从「${invalidatedFromRole}」档位重新会签。` : '未影响已完成会签。'),
    batchNo: newBatchNo,
    requestId: body.requestId,
    source: 'batch',
  })

  addHistory(claim, {
    batchNo: newBatchNo,
    requestId: body.requestId,
    createdAt: batch.createdAt,
    committedAt: nowText(),
    operator: batch.operator,
    previousBatchNo,
    baselineReserve: reserveBefore,
    reserveBefore,
    reserveAfter,
    itemCount: body.items.length,
    changedItemIds,
    invalidatedFromRole,
    attachmentIds: claim.lossItems.flatMap((item) => item.attachments.map((file) => file.id)),
    auditId,
  }, before)

  batch.status = 'submitted'
  if (activeBatchNoByClaim[claim.id] === newBatchNo) delete activeBatchNoByClaim[claim.id]

  return {
    claim: cloneClaim(claim),
    batchNo: newBatchNo,
    requestId: body.requestId,
    accepted: true,
    changedItemIds,
    invalidatedFromRole,
    attachmentIds: addedAttachmentIds,
    reserveBefore,
    reserveAfter,
  }
}

function firstActionableIndex(claim: ClaimCase) {
  for (let index = 0; index < claim.approvals.length; index += 1) {
    const priorBlocked = claim.approvals.slice(0, index).some((step) => step.status === '待处理' || step.status === '已退回' || step.status === '已失效')
    if (priorBlocked) return -1
    const status = claim.approvals[index].status
    if (status === '待处理' || status === '已失效') return index
  }
  return -1
}

export const mockApiInterceptor: HttpInterceptorFn = (request, next) => {
  if (!request.url.startsWith('/api/')) return next(request)

  const batchListMatch = request.url.match(/^\/api\/claims\/([^/]+)\/baseline-batches$/)
  const batchItemMatch = request.url.match(/^\/api\/claims\/([^/]+)\/baseline-batches\/([^/]+)(?:\/commit)?$/)

  if (request.method === 'GET' && request.url === '/api/claims') {
    const query = request.params.get('query')?.toLowerCase() ?? ''
    const status = request.params.get('status') ?? ''
    const risk = request.params.get('risk') ?? ''
    const page = Number(request.params.get('page') ?? 1)
    const pageSize = Number(request.params.get('pageSize') ?? 10)
    const filtered = claims.filter(
      (item) =>
        (!query || `${item.id}${item.insured}${item.policyNo}`.toLowerCase().includes(query)) &&
        (!status || item.status === status) &&
        (!risk || item.riskLevel === risk),
    )
    const start = (page - 1) * pageSize
    return json({ items: filtered.slice(start, start + pageSize), total: filtered.length, page, pageSize }, 200, 120)
  }

  if (request.method === 'POST' && batchListMatch) {
    const claim = findClaim(batchListMatch[1])
    if (!claim) return error(404, 'CLAIM_NOT_FOUND', '案件不存在')
    const batch = makeBaselineBatch(claim)
    batchesByNo.set(batch.batchNo, batch)
    activeBatchNoByClaim[claim.id] = batch.batchNo
    return json({ batch, claim: cloneClaim(claim) }, 201, 160)
  }

  if (request.method === 'GET' && batchItemMatch && !request.url.endsWith('/commit')) {
    const claim = findClaim(batchItemMatch[1])
    const batchNo = decodeURIComponent(batchItemMatch[2])
    const entry = claim?.batchHistory.find((item) => item.batchNo === batchNo)
    const batch = batchesByNo.get(batchNo)
    if (!claim || !entry) return error(404, 'BATCH_NOT_FOUND', '批次不存在或原记录未归档')
    return json({ entry, batch: batch ?? null }, 200, 120)
  }

  if (request.method === 'POST' && batchItemMatch && request.url.endsWith('/commit')) {
    const claim = findClaim(batchItemMatch[1])
    const batchNo = decodeURIComponent(batchItemMatch[2])
    const body = request.body as BatchSaveRequest
    if (!claim) return error(404, 'CLAIM_NOT_FOUND', '案件不存在')

    const cached = commitResultsByRequest.get(body.requestId)
    if (cached) return json({ ...cached, retried: true, duplicate: true }, 200, 120)

    const batch = batchesByNo.get(batchNo)
    if (!batch || batch.claimId !== claim.id || batch.status !== 'editing') {
      return error(409, 'BATCH_NOT_EDITABLE', '批次已提交或不存在，请先取新的基线批次号')
    }

    const blockedItems: BatchConflictItem[] = []
    for (const submitted of body.items) {
      const item = claim.lossItems.find((candidate) => candidate.id === submitted.itemId)
      const base = batch.items.find((candidate) => candidate.itemId === submitted.itemId)
      if (!item || !base) continue
      if (item.revision !== submitted.baseRevision || item.revision !== base.baseRevision) {
        blockedItems.push({
          itemId: item.id,
          category: item.category,
          description: item.description,
          changedBy: '另一理赔会话',
          changedAt: nowText(),
          changedFields: changedFields(base, submitted, item),
          baseRevision: base.baseRevision,
          latestRevision: item.revision,
          rejectedDraft: structuredClone(submitted),
        })
      }
    }

    if (blockedItems.length) {
      const conflict: BatchConflict = {
        code: 'REVISION_CONFLICT',
        message: '同一损失科目已有先到批次放行，当前草稿已保留',
        requestId: body.requestId,
        batchNo,
        blockedItems,
        draftRetained: true,
      }
      batch.conflict = conflict
      return error(409, conflict.code, conflict.message, { conflict })
    }

    const result = commitBatch(claim, batch, body)
    commitResultsByRequest.set(body.requestId, result)

    // 模拟服务端已落账但首个响应丢失：重试按 requestId 读取同一份结果，不再追加任何记录。
    if (body.simulateLostWrite) {
      return error(500, 'WRITE_RESULT_UNKNOWN', '批次写入结果未知，正在按请求编号安全重试', { requestId: body.requestId })
    }
    return json(result, 200, 220)
  }

  if (request.method === 'POST' && request.url.endsWith('/external-quotes')) {
    const claimId = request.url.split('/').at(-2)
    const body = request.body as { itemId: string }
    const claim = findClaim(claimId)
    const item = claim?.lossItems.find((candidate) => candidate.id === body.itemId)
    if (!claim || !item) return error(404, 'LOSS_ITEM_NOT_FOUND', '损失科目不存在')

    const before = cloneClaim(claim)
    const previousBatchNo = claim.batchNo
    const reserveBefore = claim.reserve
    const externalBatchNo = nextBatchNo('CON')
    const latest = item.repairQuotes.at(-1)
    const version = item.repairQuotes.length + 1
    const amount = Math.round((latest?.amount ?? 0) * 1.05 / 1000) * 1000
    item.repairQuotes.push({
      id: `Q-${claim.id}-${version}`,
      version,
      amount,
      reason: '另一查勘端先保存了修复报价补充项',
      operator: '同事 / 并发会话',
      createdAt: nowText(),
      batchNo: externalBatchNo,
    })
    item.revision += 1
    item.batchNo = externalBatchNo
    item.latestQuoteVersion = version
    item.evidenceVersion = Math.max(item.evidenceVersion, ...item.attachments.map((file) => file.version))

    const reserveAfter = calculateReserve(claim)
    claim.reserve = reserveAfter
    claim.baselineReserve = reserveBefore
    claim.batchNo = externalBatchNo
    claim.batchVersion += 1
    const invalidIndex = invalidateApprovals(
      claim.approvals,
      reserveBefore,
      reserveAfter,
      externalBatchNo,
      `并发批次 ${externalBatchNo} 已先修改 ${item.category}，旧会签立即失效`,
    )
    const invalidatedFromRole = claim.approvals[invalidIndex]?.role
    if (invalidatedFromRole) claim.status = '待复核'
    const auditId = `A-${externalBatchNo}`
    claim.audit.push({
      id: auditId,
      at: nowText(),
      operator: '同事 / 并发会话',
      action: '并发报价先提交',
      detail: `${item.category}（${item.id}）已先形成 V${version} 报价 ${amount.toLocaleString('zh-CN')} 元；准备金 ${reserveBefore.toLocaleString('zh-CN')} → ${reserveAfter.toLocaleString('zh-CN')}；从「${invalidatedFromRole}」重签。`,
      batchNo: externalBatchNo,
      source: 'batch',
    })
    addHistory(claim, {
      batchNo: externalBatchNo,
      requestId: `REQ-EXTERNAL-${claim.id}-${item.id}-${Date.now()}`,
      createdAt: nowText(),
      committedAt: nowText(),
      operator: '同事 / 并发会话',
      previousBatchNo,
      baselineReserve: reserveBefore,
      reserveBefore,
      reserveAfter,
      itemCount: claim.lossItems.length,
      changedItemIds: [item.id],
      invalidatedFromRole,
      attachmentIds: claim.lossItems.flatMap((current) => current.attachments.map((file) => file.id)),
      auditId,
    }, before)

    return json({ claim: cloneClaim(claim), batchNo: externalBatchNo }, 200, 260)
  }

  if (request.method === 'GET' && request.url.match(/^\/api\/claims\/[^/]+$/)) {
    const id = request.url.split('/').pop()
    const item = findClaim(id)
    return item ? json(item, 200, 100) : error(404, 'CLAIM_NOT_FOUND', '案件不存在')
  }

  if (request.method === 'POST' && request.url.endsWith('/quotes')) {
    return error(409, 'BATCH_REQUIRED', '调整报价前必须先取基线定损批次号')
  }

  if (request.method === 'POST' && request.url.endsWith('/approvals')) {
    const id = request.url.split('/').at(-2)
    const body = request.body as { role: string; result: string; comment: string }
    const claim = findClaim(id)
    if (!claim) return error(404, 'CLAIM_NOT_FOUND', '案件不存在')
    const targetIndex = claim.approvals.findIndex((approval) => approval.role === body.role)
    const actionableIndex = firstActionableIndex(claim)
    if (targetIndex < 0 || actionableIndex < 0 || targetIndex !== actionableIndex) {
      return error(409, 'STALE_APPROVAL', '存在失效或未处理的前置档位，请从首个受影响档位重签')
    }

    const step = claim.approvals[targetIndex]
    const passed = body.result === '已通过'
    step.status = passed ? '已通过' : '已退回'
    step.operator = '当前用户'
    step.comment = body.comment
    step.completedAt = nowText()
    step.invalidatedAt = undefined
    step.invalidatedReason = undefined
    step.batchNo = claim.batchNo
    claim.audit.push({
      id: `A-APR-${Date.now()}`,
      at: nowText(),
      operator: '当前用户',
      action: passed ? '失效档位重签通过' : '会签退回',
      detail: `${step.role}：${body.comment}`,
      batchNo: claim.batchNo,
      source: 'batch',
    })
    claim.status = passed ? (claim.approvals.every((item) => item.status === '已通过') ? '待支付' : '审批中') : '退回补件'
    return json(cloneClaim(claim), 200, 180)
  }

  return next(request)
}
