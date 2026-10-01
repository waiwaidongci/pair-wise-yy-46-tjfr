import { HttpClient, HttpParams } from '@angular/common/http'
import { Injectable } from '@angular/core'
import { retry, throwError, timer } from 'rxjs'
import type {
  BaselineBatch,
  BatchCommitResult,
  BatchHistoryEntry,
  BatchSaveRequest,
  ClaimCase,
  ClaimFilters,
  PagedClaims,
} from './models'

@Injectable({ providedIn: 'root' })
export class ClaimsService {
  constructor(private readonly http: HttpClient) {}

  list(filters: ClaimFilters) {
    const params = new HttpParams()
      .set('query', filters.query)
      .set('status', filters.status)
      .set('risk', filters.risk)
      .set('page', filters.page)
      .set('pageSize', filters.pageSize)
    return this.http.get<PagedClaims>('/api/claims', { params })
  }

  get(id: string) {
    return this.http.get<ClaimCase>(`/api/claims/${id}`)
  }

  startBatch(claimId: string) {
    return this.http.post<{ batch: BaselineBatch; claim: ClaimCase }>(`/api/claims/${claimId}/baseline-batches`, {})
  }

  commitBatch(claimId: string, batchNo: string, body: BatchSaveRequest) {
    const encodedBatchNo = encodeURIComponent(batchNo)
    return this.http
      .post<BatchCommitResult>(`/api/claims/${claimId}/baseline-batches/${encodedBatchNo}/commit`, body)
      .pipe(
        retry({
          count: 1,
          delay: (error) => (error?.error?.code === 'WRITE_RESULT_UNKNOWN' ? timer(600) : throwError(() => error)),
        }),
      )
  }

  getBatch(claimId: string, batchNo: string) {
    return this.http.get<{ entry: BatchHistoryEntry; batch?: BaselineBatch }>(
      `/api/claims/${claimId}/baseline-batches/${encodeURIComponent(batchNo)}`,
    )
  }

  simulateExternalQuote(claimId: string, itemId: string) {
    return this.http.post<{ claim: ClaimCase; batchNo: string }>(`/api/claims/${claimId}/external-quotes`, { itemId })
  }

  approve(claimId: string, body: { role: string; result: string; comment: string }) {
    return this.http.post<ClaimCase>(`/api/claims/${claimId}/approvals`, body)
  }
}
