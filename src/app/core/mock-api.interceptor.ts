import { HttpErrorResponse, HttpInterceptorFn, HttpResponse } from '@angular/common/http'
import { delay, of, throwError } from 'rxjs'
import { seedClaims } from './seed'
import { migrateClaim } from './batch'
import { engineApprove, engineCommit, engineGet, engineList, engineOpenBatch, type EngineResult, type RequestLog } from './batch-engine'
import type { BatchCommitBody, ClaimCase } from './models'

let claims: ClaimCase[] = structuredClone(seedClaims).map(migrateClaim)
const requestLog: RequestLog = new Map()

function respond(result: EngineResult, ms: number) {
  if (result.status === 404) return throwError(() => new HttpErrorResponse({ status: 404 }))
  return of(new HttpResponse({ status: result.status, body: result.body })).pipe(delay(ms))
}

export const mockApiInterceptor: HttpInterceptorFn = (request, next) => {
  if (!request.url.startsWith('/api/')) return next(request)

  if (request.method === 'GET' && request.url === '/api/claims') {
    return respond(
      engineList(claims, {
        query: request.params.get('query') ?? '',
        status: request.params.get('status') ?? '',
        risk: request.params.get('risk') ?? '',
        page: Number(request.params.get('page') ?? 1),
        pageSize: Number(request.params.get('pageSize') ?? 10),
      }),
      220,
    )
  }

  if (request.method === 'GET' && request.url.startsWith('/api/claims/')) {
    const id = request.url.split('/').pop()!
    const result = engineGet(claims, id)
    return result ? respond(result, 120) : throwError(() => new HttpErrorResponse({ status: 404 }))
  }

  // 取批次号：调整报价或责任比例前先取号
  if (request.method === 'POST' && /^\/api\/claims\/[^/]+\/batches$/.test(request.url)) {
    const id = request.url.split('/').at(-2)!
    return respond(engineOpenBatch(claims, id), 120)
  }

  // 批次提交：损失科目、准备金、附件版本、会签状态一起提交；按请求编号幂等
  if (request.method === 'POST' && /^\/api\/claims\/[^/]+\/batches\/[^/]+\/commit$/.test(request.url)) {
    const parts = request.url.split('/')
    const id = parts.at(-4)!
    const batchNo = parts.at(-2)!
    return respond(engineCommit(claims, id, batchNo, request.body as BatchCommitBody, requestLog), 180)
  }

  // 会签：按批次顺序从首个受影响档位重签，通过时记录所依据的批次号
  if (request.method === 'POST' && request.url.endsWith('/approvals')) {
    const id = request.url.split('/').at(-2)!
    return respond(engineApprove(claims, id, request.body as { role: string; result: string; comment: string; batchNo: string }), 180)
  }

  return next(request)
}
