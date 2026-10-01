import type {
  ApprovalStep,
  BaselineBatch,
  BatchHistoryEntry,
  BatchItemBaseline,
  ClaimCase,
  LegacyClaim,
  LossItem,
} from './models'

let batchSequence = 1

export function nowText() {
  return new Date().toLocaleString('zh-CN', { hour12: false })
}

export function nextBatchNo(prefix = 'BAT') {
  const date = new Date()
  const ymd = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`
  return `${prefix}-${ymd}-${String(batchSequence++).padStart(4, '0')}`
}

export function calculateReserve(claim: Pick<ClaimCase, 'lossItems' | 'deductible'>) {
  const net = claim.lossItems.reduce((sum, item) => {
    const quote = item.repairQuotes.at(-1)?.amount ?? 0
    return sum + Math.max(0, quote - item.salvage) * item.liability
  }, 0)
  return Math.max(0, Math.round(net - claim.deductible))
}

export function highestAttachmentVersion(item: Pick<LossItem, 'attachments'>) {
  return item.attachments.reduce((max, file) => Math.max(max, file.version), 0)
}

export function makeItemBaseline(item: LossItem): BatchItemBaseline {
  const latest = item.repairQuotes.at(-1)
  return {
    itemId: item.id,
    category: item.category,
    description: item.description,
    baseRevision: item.revision,
    damage: item.damage,
    salvage: item.salvage,
    liability: item.liability,
    quoteVersion: latest?.version ?? 0,
    quoteAmount: latest?.amount ?? 0,
    evidenceVersion: item.evidenceVersion,
    attachmentIds: item.attachments.map((file) => file.id),
  }
}

export function makeBaselineBatch(claim: ClaimCase, operator = '当前用户'): BaselineBatch {
  return {
    batchNo: nextBatchNo(),
    claimId: claim.id,
    requestId: `REQ-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    status: 'editing',
    createdAt: nowText(),
    operator,
    baselineReserve: claim.reserve,
    items: claim.lossItems.map(makeItemBaseline),
  }
}

export function firstAffectedApprovalIndex(approvals: ApprovalStep[], before: number, after: number) {
  const low = Math.min(before, after)
  const high = Math.max(before, after)

  if (before !== after) {
    for (let index = 0; index < approvals.length; index += 1) {
      const step = approvals[index]
      if (step.status === '已通过' && step.threshold > low && step.threshold <= high) {
        return index
      }
    }
  } else {
    const firstPassed = approvals.findIndex((step) => step.status === '已通过')
    if (firstPassed >= 0) return firstPassed
  }

  return approvals.findIndex((step) => step.status === '待处理')
}

export function invalidateApprovals(
  approvals: ApprovalStep[],
  before: number,
  after: number,
  batchNo: string,
  reason: string,
) {
  const firstIndex = firstAffectedApprovalIndex(approvals, before, after)
  approvals.forEach((step, index) => {
    if (index >= firstIndex && step.status === '已通过') {
      step.status = '已失效'
      step.invalidatedAt = nowText()
      step.invalidatedReason = reason
      step.batchNo = batchNo
    }
  })
  return firstIndex
}

export function firstActionableApprovalIndex(approvals: ApprovalStep[]) {
  const firstPending = approvals.findIndex((step) => step.status === '待处理')
  if (firstPending < 0) return -1
  const passedBefore = approvals.slice(0, firstPending).every((step) => step.status === '已通过')
  return passedBefore ? firstPending : -1
}

export function normalizeClaim(rawClaim: LegacyClaim | ClaimCase): ClaimCase {
  const initialBatchNo = rawClaim.batchNo ?? `INI-${rawClaim.id}`
  const lossItems = rawClaim.lossItems.map((rawItem) => {
    const evidenceVersion = rawItem.evidenceVersion ?? highestAttachmentVersion({ attachments: rawItem.attachments })
    return {
      ...rawItem,
      batchNo: rawItem.batchNo ?? initialBatchNo,
      revision: rawItem.revision ?? 1,
      evidenceVersion,
      latestQuoteVersion: rawItem.latestQuoteVersion ?? rawItem.repairQuotes.at(-1)?.version ?? 1,
      repairQuotes: rawItem.repairQuotes.map((quote) => ({
        ...quote,
        batchNo: quote.batchNo ?? initialBatchNo,
      })),
    } satisfies LossItem
  })

  const baselineReserve = rawClaim.baselineReserve ?? rawClaim.reserve
  const initialEntry: BatchHistoryEntry = {
    batchNo: initialBatchNo,
    requestId: `LEGACY-${rawClaim.id}`,
    createdAt: rawClaim.reportedAt,
    committedAt: rawClaim.reportedAt,
    operator: rawClaim.adjuster,
    previousBatchNo: 'LEGACY-0',
    baselineReserve,
    reserveBefore: rawClaim.reserve,
    reserveAfter: rawClaim.reserve,
    itemCount: lossItems.length,
    changedItemIds: [],
    attachmentIds: lossItems.flatMap((item) => item.attachments.map((file) => file.id)),
    auditId: rawClaim.audit[0]?.id ?? `LEGACY-${rawClaim.id}`,
    source: 'legacy',
  }

  const history: BatchHistoryEntry[] = rawClaim.batchHistory?.length ? rawClaim.batchHistory : [initialEntry]
  const normalized: ClaimCase = {
    ...rawClaim,
    batchNo: initialBatchNo,
    batchVersion: rawClaim.batchVersion ?? 1,
    baselineReserve,
    lossItems,
    approvals: rawClaim.approvals.map((step) => ({ ...step })),
    audit: rawClaim.audit.map((event) => ({
      ...event,
      batchNo: event.batchNo ?? initialBatchNo,
      source: event.source ?? 'legacy',
    })),
    batchHistory: history,
  }
  if (history[0]?.batchNo === initialBatchNo) {
    history[0].snapshot = { ...structuredClone(normalized), batchHistory: [] }
  }
  return normalized
}

export function cloneClaim(claim: ClaimCase): ClaimCase {
  return structuredClone(claim)
}
