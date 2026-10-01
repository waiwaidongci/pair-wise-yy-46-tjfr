import { createAction, createReducer, createSelector, on, props } from '@ngrx/store'
import { seedClaims } from './seed'
import { normalizeClaim } from './baseline'
import type { ClaimCase, ClaimFilters, LegacyClaim } from './models'

export type ClaimsState = {
  items: ClaimCase[]
  filters: ClaimFilters
  total: number
  selectedId: string
  loading: boolean
  draft: string
  toast: string
}

export type AppState = { claims: ClaimsState }

function loadInitialState(): ClaimsState {
  const fallbackSeed = (seedClaims as LegacyClaim[]).map(normalizeClaim)
  const stored = localStorage.getItem('property-claims-draft-v1')
  if (stored) {
    try {
      const parsed = JSON.parse(stored) as ClaimsState
      if (Array.isArray(parsed.items) && parsed.items.length) {
        return {
          ...parsed,
          items: parsed.items.map((item) => normalizeClaim(item as LegacyClaim)),
          toast: '',
        }
      }
    } catch {
      // 旧草稿结构不兼容时回落到种子数据。
    }
  }

  return {
    items: fallbackSeed,
    filters: { query: '', status: '', risk: '', page: 1, pageSize: 10 },
    total: fallbackSeed.length,
    selectedId: fallbackSeed[0].id,
    loading: false,
    draft: '待补充房屋檩条第三方复测依据。',
    toast: '',
  }
}

export const initialClaimsState: ClaimsState = loadInitialState()

export const loadClaimsSuccess = createAction('[Claims] Load Success', props<{ items: ClaimCase[]; total: number }>())
export const setFilters = createAction('[Claims] Set Filters', props<{ filters: Partial<ClaimFilters> }>())
export const selectClaim = createAction('[Claims] Select', props<{ id: string }>())
export const saveDraft = createAction('[Claims] Save Draft', props<{ draft: string }>())
export const updateClaim = createAction('[Claims] Update Claim', props<{ claim: ClaimCase }>())
export const setToast = createAction('[Claims] Toast', props<{ message: string }>())

export const claimsReducer = createReducer(
  initialClaimsState,
  on(loadClaimsSuccess, (state, { items, total }) => ({ ...state, items, total, loading: false })),
  on(setFilters, (state, { filters }) => ({ ...state, filters: { ...state.filters, ...filters } })),
  on(selectClaim, (state, { id }) => ({ ...state, selectedId: id })),
  on(saveDraft, (state, { draft }) => ({ ...state, draft, toast: '草稿已恢复并保存到本地' })),
  on(updateClaim, (state, { claim }) => ({
    ...state,
    items: state.items.map((item) => (item.id === claim.id ? claim : item)),
    toast: '案件版本已更新',
  })),
  on(setToast, (state, { message }) => ({ ...state, toast: message })),
)

export const selectClaimsState = (state: AppState) => state.claims
export const selectAllClaims = createSelector(selectClaimsState, (state) => state.items)
export const selectFilters = createSelector(selectClaimsState, (state) => state.filters)
export const selectSelectedClaim = createSelector(selectClaimsState, (state) => state.items.find((item) => item.id === state.selectedId) ?? state.items[0])
export const selectFilteredClaims = createSelector(selectAllClaims, selectFilters, (claims, filters) =>
  claims.filter(
    (item) =>
      (!filters.query || `${item.id}${item.insured}${item.policyNo}`.toLowerCase().includes(filters.query.toLowerCase())) &&
      (!filters.status || item.status === filters.status) &&
      (!filters.risk || item.riskLevel === filters.risk),
  ),
)
