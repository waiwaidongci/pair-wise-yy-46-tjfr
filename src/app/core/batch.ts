import type { ClaimCase, LossBatch, BatchConflict } from './models'

/** 旧数据补建的初始基线批次号 */
export const INIT_BATCH_NO = 'BATCH-INIT-0001'

export function newRequestId(): string {
  return `REQ-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`
}

export function nowText(): string {
  return new Date().toLocaleString('zh-CN')
}

/** 准备金试算：各科目（最新报价 - 残值）* 责任比例，扣免赔后取非负 */
export function computeReserve(claim: ClaimCase): number {
  const net = claim.lossItems.reduce((sum, item) => {
    const quote = item.repairQuotes.at(-1)?.amount ?? 0
    return sum + Math.max(0, (quote - item.salvage) * item.liability)
  }, 0)
  return Math.max(0, net - claim.deductible)
}

export function buildSnapshot(claim: ClaimCase): LossBatch['snapshot'] {
  return {
    reserve: claim.reserve,
    deductible: claim.deductible,
    lossItems: claim.lossItems.map((item) => ({
      itemId: item.id,
      category: item.category,
      latestQuoteVersion: item.repairQuotes.length,
      latestQuoteAmount: item.repairQuotes.at(-1)?.amount ?? 0,
      salvage: item.salvage,
      liability: item.liability,
      attachmentVersions: item.attachments.map((attachment) => ({ attachmentId: attachment.id, version: attachment.version })),
    })),
    approvals: claim.approvals.map((step) => ({ role: step.role, status: step.status, signedBatchNo: step.signedBatchNo })),
  }
}

/**
 * 旧数据迁移：没有批次号的案件补成初始基线批次。
 * 幂等：已有 baselineBatchNo 的案件直接返回，原记录（科目、附件、会签、审计）全部保留可查。
 */
export function migrateClaim(claim: ClaimCase): ClaimCase {
  if (claim.baselineBatchNo) return claim
  const batch: LossBatch = {
    batchNo: INIT_BATCH_NO,
    claimId: claim.id,
    version: 1,
    status: '已提交',
    createdAt: claim.reportedAt,
    createdBy: '系统补建',
    changes: ['旧数据无批次号，补建为初始基线版本'],
    invalidatedApprovals: [],
    snapshot: buildSnapshot(claim),
  }
  return {
    ...claim,
    baselineBatchNo: INIT_BATCH_NO,
    batches: [batch],
    lossItems: claim.lossItems.map((item) => ({ ...item, baselineBatchNo: INIT_BATCH_NO })),
    approvals: claim.approvals.map((step) => ({
      ...step,
      signedBatchNo: step.status === '已通过' ? INIT_BATCH_NO : undefined,
      invalidated: false,
    })),
    audit: [
      ...claim.audit,
      {
        id: `A-MIG-${claim.id}`,
        at: '补建',
        operator: '系统',
        action: '基线批次补建',
        detail: `旧数据无批次号，已补为初始版本 ${INIT_BATCH_NO}；原损失科目、附件、会签与审计记录保留可查。`,
      },
    ],
  }
}

export function migrateClaims(claims: ClaimCase[]): ClaimCase[] {
  return claims.map(migrateClaim)
}

/** 取批次号：按案件批次流水号发号 */
export function nextBatchNo(claim: ClaimCase): { batchNo: string; version: number } {
  const version = (claim.batches?.length ?? 0) + 1
  const year = new Date().getFullYear()
  return { batchNo: `BATCH-${year}-${String(version).padStart(4, '0')}`, version }
}

/** 首个已完成会签档位：批次变更后从该档位起失效重签 */
export function firstSignedApprovalIndex(claim: ClaimCase): number {
  return claim.approvals.findIndex((step) => step.status === '已通过')
}

/** 组装冲突展示文案 */
export function describeConflict(conflict: BatchConflict): string {
  return `被改对象 ${conflict.category}（${conflict.itemId}）已被批次 ${conflict.batchNo} 抢先修改（${conflict.modifiedBy} · ${conflict.modifiedAt}）`
}
