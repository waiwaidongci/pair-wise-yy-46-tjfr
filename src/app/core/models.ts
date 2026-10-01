export type ClaimStatus = '查勘中' | '待复核' | '退回补件' | '审批中' | '待支付' | '已结案'

export type ApprovalStatus = '待处理' | '已通过' | '已退回' | '已失效'

export type Attachment = {
  id: string
  name: string
  category: '现场照片' | '修复报告' | '专家意见' | '保单摘录'
  version: number
  uploadedBy: string
  uploadedAt: string
}

export type RepairQuote = {
  id?: string
  version: number
  amount: number
  reason: string
  operator: string
  createdAt: string
  batchNo?: string
  requestId?: string
}

export type LossItem = {
  id: string
  category: string
  description: string
  damage: string
  repairQuotes: RepairQuote[]
  salvage: number
  liability: number
  disputed: boolean
  attachments: Attachment[]
  expertNotes: string[]
  batchNo: string
  revision: number
  evidenceVersion: number
  latestQuoteVersion: number
}

export type ApprovalStep = {
  role: string
  threshold: number
  status: ApprovalStatus
  operator?: string
  comment?: string
  completedAt?: string
  invalidatedAt?: string
  invalidatedReason?: string
  batchNo?: string
}

export type AuditEvent = {
  id: string
  at: string
  operator: string
  action: string
  detail: string
  batchNo?: string
  requestId?: string
  source?: 'legacy' | 'batch'
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
  batchNo: string
  batchVersion: number
  baselineReserve: number
  lossItems: LossItem[]
  approvals: ApprovalStep[]
  audit: AuditEvent[]
  batchHistory: BatchHistoryEntry[]
}

export type LegacyLossItem = Omit<LossItem, 'batchNo' | 'revision' | 'evidenceVersion' | 'latestQuoteVersion'> & {
  batchNo?: string
  revision?: number
  evidenceVersion?: number
  latestQuoteVersion?: number
}

export type LegacyClaim = Omit<ClaimCase, 'batchNo' | 'batchVersion' | 'baselineReserve' | 'batchHistory' | 'lossItems'> & {
  batchNo?: string
  batchVersion?: number
  baselineReserve?: number
  batchHistory?: BatchHistoryEntry[]
  lossItems: LegacyLossItem[]
  approvals: Array<Omit<ApprovalStep, 'status'> & { status: ApprovalStatus }>
}

export type BatchItemBaseline = {
  itemId: string
  category: string
  description: string
  baseRevision: number
  damage: string
  salvage: number
  liability: number
  quoteVersion: number
  quoteAmount: number
  evidenceVersion: number
  attachmentIds: string[]
}

export type BaselineBatch = {
  batchNo: string
  claimId: string
  requestId: string
  status: 'editing' | 'submitted'
  createdAt: string
  operator: string
  baselineReserve: number
  items: BatchItemBaseline[]
  activeDraft?: BatchSubmitItem
  conflict?: BatchConflict
}

export type BatchSubmitItem = {
  itemId: string
  damage: string
  salvage: number
  liability: number
  baseRevision: number
  quoteVersion: number
  newQuote?: {
    amount: number
    reason: string
    operator: string
    createdAt: string
    batchNo?: string
    requestId?: string
  }
  attachments: Attachment[]
}

export type BatchSaveRequest = {
  requestId: string
  baselineReserve: number
  reserve: number
  items: BatchSubmitItem[]
  simulateLostWrite?: boolean
}

export type BatchConflictItem = {
  itemId: string
  category: string
  description: string
  changedBy: string
  changedAt: string
  changedFields: string[]
  baseRevision: number
  latestRevision: number
  rejectedDraft: BatchSubmitItem
}

export type BatchConflict = {
  code: 'REVISION_CONFLICT'
  message: string
  requestId: string
  batchNo: string
  blockedItems: BatchConflictItem[]
  draftRetained: true
}

export type BatchHistoryEntry = {
  batchNo: string
  requestId: string
  createdAt: string
  committedAt: string
  operator: string
  previousBatchNo: string
  baselineReserve: number
  reserveBefore: number
  reserveAfter: number
  itemCount: number
  changedItemIds: string[]
  invalidatedFromRole?: string
  attachmentIds: string[]
  auditId: string
  snapshot?: ClaimCase
  source: 'legacy' | 'batch'
}

export type BatchCommitResult = {
  claim: ClaimCase
  batchNo: string
  requestId: string
  accepted: boolean
  changedItemIds: string[]
  invalidatedFromRole?: string
  attachmentIds: string[]
  reserveBefore: number
  reserveAfter: number
  retried?: boolean
  duplicate?: boolean
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
