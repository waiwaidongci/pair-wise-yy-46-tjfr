import { createAction, createReducer, createSelector, on, props } from '@ngrx/store'
import { seedClaims } from './seed'
import { migrateClaims } from './batch'
import type { BatchConflict, ClaimCase, ClaimFilters } from './models'

export type ClaimsState = {
  items: ClaimCase[]
  filters: ClaimFilters
  total: number
  selectedId: string
  loading: boolean
  draft: string
  toast: string
  /** 后到批次的冲突清单：列出被改对象，草稿保留 */
  conflicts: BatchConflict[]
  conflictBatchNo: string
}

export type AppState = { claims: ClaimsState }

const persisted = localStorage.getItem('property-claims-draft-v1')

function initState(): ClaimsState {
  if (persisted) {
    const parsed = JSON.parse(persisted) as Partial<ClaimsState>
    return {
      items: migrateClaims(parsed.items ?? []),
      filters: parsed.filters ?? { query: '', status: '', risk: '', page: 1, pageSize: 10 },
      total: parsed.total ?? 0,
      selectedId: parsed.selectedId ?? '',
      loading: false,
      draft: parsed.draft ?? '待补充房屋檩条第三方复测依据。',
      toast: '',
      conflicts: [],
      conflictBatchNo: '',
    }
  }
  const items = migrateClaims(structuredClone(seedClaims))
  return {
    items,
    filters: { query: '', status: '', risk: '', page: 1, pageSize: 10 },
    total: items.length,
    selectedId: items[0].id,
    loading: false,
    draft: '待补充房屋檩条第三方复测依据。',
    toast: '',
    conflicts: [],
    conflictBatchNo: '',
  }
}

export const initialClaimsState: ClaimsState = initState()

export const loadClaimsSuccess = createAction('[Claims] Load Success', props<{ items: ClaimCase[]; total: number }>())
export const setFilters = createAction('[Claims] Set Filters', props<{ filters: Partial<ClaimFilters> }>())
export const selectClaim = createAction('[Claims] Select', props<{ id: string }>())
export const saveDraft = createAction('[Claims] Save Draft', props<{ draft: string }>())
export const updateClaim = createAction('[Claims] Update Claim', props<{ claim: ClaimCase }>())
export const batchCommitted = createAction(
  '[Claims] Batch Committed',
  props<{ claim: ClaimCase; batchNo: string; deduped: boolean; invalidatedApprovals: string[] }>(),
)
export const setConflicts = createAction('[Claims] Conflicts Detected', props<{ conflicts: BatchConflict[]; batchNo: string }>())
export const clearConflicts = createAction('[Claims] Clear Conflicts')
export const setToast = createAction('[Claims] Toast', props<{ message: string }>())

export const claimsReducer = createReducer(
  initialClaimsState,
  on(loadClaimsSuccess, (state, { items, total }) => ({ ...state, items: migrateClaims(items), total, loading: false })),
  on(setFilters, (state, { filters }) => ({ ...state, filters: { ...state.filters, ...filters } })),
  on(selectClaim, (state, { id }) => ({ ...state, selectedId: id })),
  on(saveDraft, (state, { draft }) => ({ ...state, draft, toast: '草稿已恢复并保存到本地' })),
  on(updateClaim, (state, { claim }) => ({
    ...state,
    items: state.items.map((item) => (item.id === claim.id ? claim : item)),
    toast: '案件版本已更新',
  })),
  on(batchCommitted, (state, { claim, batchNo, deduped, invalidatedApprovals }) => ({
    ...state,
    items: state.items.map((item) => (item.id === claim.id ? claim : item)),
    conflicts: [],
    conflictBatchNo: '',
    toast: deduped
      ? `重试沿用第一次结果：批次 ${batchNo} 未重复追加附件、审计或准备金`
      : invalidatedApprovals.length > 0
        ? `基线批次 ${batchNo} 已提交；受影响会签已失效，请从首个受影响档位重签`
        : `基线批次 ${batchNo} 已提交，损失科目、准备金、附件版本、会签状态一并保存`,
  })),
  on(setConflicts, (state, { conflicts, batchNo }) => ({
    ...state,
    conflicts,
    conflictBatchNo: batchNo,
    toast: `后到批次 ${batchNo} 未放行：${conflicts.length} 个科目已被他人修改，草稿已保留`,
  })),
  on(clearConflicts, (state) => ({ ...state, conflicts: [], conflictBatchNo: '' })),
  on(setToast, (state, { message }) => ({ ...state, toast: message })),
)

export const selectClaimsState = (state: AppState) => state.claims
export const selectAllClaims = createSelector(selectClaimsState, (state) => state.items)
export const selectFilters = createSelector(selectClaimsState, (state) => state.filters)
export const selectSelectedClaim = createSelector(selectClaimsState, (state) => state.items.find((item) => item.id === state.selectedId) ?? state.items[0])
export const selectConflicts = createSelector(selectClaimsState, (state) => state.conflicts)
export const selectConflictBatchNo = createSelector(selectClaimsState, (state) => state.conflictBatchNo)
export const selectFilteredClaims = createSelector(selectAllClaims, selectFilters, (claims, filters) =>
  claims.filter(
    (item) =>
      (!filters.query || `${item.id}${item.insured}${item.policyNo}`.toLowerCase().includes(filters.query.toLowerCase())) &&
      (!filters.status || item.status === filters.status) &&
      (!filters.risk || item.riskLevel === filters.risk),
  ),
)
