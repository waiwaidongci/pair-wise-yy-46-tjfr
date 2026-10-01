import { HttpClient, HttpParams } from '@angular/common/http'
import { Injectable } from '@angular/core'
import type { BatchCommitBody, BatchCommitResult, ClaimCase, ClaimFilters, PagedClaims } from './models'

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

  /** 调整报价或责任比例前先取批次号 */
  openBatch(claimId: string) {
    return this.http.post<{ batchNo: string; version: number; claimId: string }>(`/api/claims/${claimId}/batches`, {})
  }

  /** 保存批次：损失科目、准备金、附件版本、会签状态一起提交；requestId 用于失败后按编号重试 */
  commitBatch(claimId: string, body: BatchCommitBody) {
    return this.http.post<BatchCommitResult>(`/api/claims/${claimId}/batches/${body.batchNo}/commit`, body)
  }

  approve(claimId: string, body: { role: string; result: string; comment: string; batchNo: string }) {
    return this.http.post<{ ok: boolean; claim: ClaimCase; error?: string; firstRole?: string }>(`/api/claims/${claimId}/approvals`, body)
  }
}
