export type ClaimStatus = '查勘中' | '待复核' | '退回补件' | '审批中' | '待支付' | '已结案'

export type Attachment = {
  id: string
  name: string
  category: '现场照片' | '修复报告' | '专家意见' | '保单摘录'
  version: number
  uploadedBy: string
  uploadedAt: string
}

export type LossItem = {
  id: string
  category: string
  description: string
  damage: string
  repairQuotes: Array<{ version: number; amount: number; reason: string; operator: string; createdAt: string }>
  salvage: number
  liability: number
  disputed: boolean
  attachments: Attachment[]
  expertNotes: string[]
  /** 该科目当前基线批次号；旧数据可能为空，迁移时补初始版本 */
  baselineBatchNo?: string
  lastModifiedBy?: string
  lastModifiedAt?: string
}

export type ApprovalStep = {
  role: string
  threshold: number
  status: '待处理' | '已通过' | '已退回'
  operator?: string
  comment?: string
  completedAt?: string
  /** 会签通过时所依据的基线批次号；批次变更后清空并置 invalidated */
  signedBatchNo?: string
  /** 受批次变更影响而失效，需从首个受影响档位重签 */
  invalidated?: boolean
}

/** 批次提交的损失科目变更项 */
export type BatchItemChange = {
  itemId: string
  /** 客户端取批次号时该科目的基线批次号，用于先到先得冲突校验 */
  baseBatchNo: string
  /** 客户端取批次号时该科目的报价版本 */
  baseQuoteVersion: number
  latestQuoteAmount: number
  salvage: number
  liability: number
  attachmentVersions: Array<{ attachmentId: string; version: number }>
  /** 本科目本批次是否发生变更 */
  changed: boolean
  /** 本批次生成的新报价（仅报价调整时携带） */
  newQuote?: { amount: number; reason: string }
}

export type BatchCommitBody = {
  /** 请求编号：重试时沿用第一次结果，服务端据此幂等去重 */
  requestId: string
  batchNo: string
  operator: string
  reserve: number
  items: BatchItemChange[]
}

export type BatchConflict = {
  itemId: string
  category: string
  /** 抢先提交的批次号 */
  batchNo: string
  modifiedBy: string
  modifiedAt: string
}

export type BatchCommitResult = {
  ok: boolean
  /** 重试命中第一次结果时为 true，未重复追加任何记录 */
  deduped?: boolean
  conflict?: boolean
  batchNo: string
  version?: number
  claim?: ClaimCase
  invalidatedApprovals?: string[]
  conflicts?: BatchConflict[]
}

export type LossBatch = {
  /** 批次号：调整报价或责任比例前先取号，保存时随损失科目、准备金、附件版本、会签状态一起提交 */
  batchNo: string
  claimId: string
  version: number
  status: '草稿' | '已提交'
  createdAt: string
  createdBy: string
  /** 幂等请求编号 */
  requestId?: string
  changes: string[]
  /** 本次变更导致失效的会签档位 */
  invalidatedApprovals: string[]
  /** 提交时的完整快照：损失科目、准备金、附件版本、会签状态 */
  snapshot: {
    reserve: number
    deductible: number
    lossItems: Array<{
      itemId: string
      category: string
      latestQuoteVersion: number
      latestQuoteAmount: number
      salvage: number
      liability: number
      attachmentVersions: Array<{ attachmentId: string; version: number }>
    }>
    approvals: Array<{ role: string; status: string; signedBatchNo?: string }>
  }
}

export type ClaimCase = {
  id: string
  policyNo: string
  insured: string
  lossAddress: string
  accidentDate: string
  reportedAt: string
  adjuster: string
  status: ClaimStatus
  riskLevel: '低' | '中' | '高'
  reserve: number
  paid: number
  deductible: number
  lossItems: LossItem[]
  approvals: ApprovalStep[]
  audit: Array<{ id: string; at: string; operator: string; action: string; detail: string }>
  /** 当前基线批次号；旧数据无批次号时由迁移补为初始版本 */
  baselineBatchNo?: string
  /** 批次历史，原记录保留可查 */
  batches?: LossBatch[]
}

export type ClaimFilters = {
  query: string
  status: string
  risk: string
  page: number
  pageSize: number
}

export type PagedClaims = {
  items: ClaimCase[]
  total: number
  page: number
  pageSize: number
}
