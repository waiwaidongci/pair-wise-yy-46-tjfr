import { Component } from '@angular/core'
import { CommonModule, CurrencyPipe } from '@angular/common'
import { FormsModule } from '@angular/forms'
import { MatButtonModule } from '@angular/material/button'
import { MatCardModule } from '@angular/material/card'
import { MatExpansionModule } from '@angular/material/expansion'
import { MatFormFieldModule } from '@angular/material/form-field'
import { MatIconModule } from '@angular/material/icon'
import { MatInputModule } from '@angular/material/input'
import { MatSelectModule } from '@angular/material/select'
import { MatSnackBar } from '@angular/material/snack-bar'
import { MatTableModule } from '@angular/material/table'
import { Store } from '@ngrx/store'
import { forkJoin, map, take } from 'rxjs'
import type { Observable } from 'rxjs'
import { ClaimsService } from '../core/claims.service'
import { INIT_BATCH_NO, newRequestId } from '../core/batch'
import type { Attachment, BatchCommitBody, BatchItemChange, ClaimCase, LossItem } from '../core/models'
import {
  batchCommitted,
  clearConflicts,
  selectConflictBatchNo,
  selectConflicts,
  selectSelectedClaim,
  setConflicts,
  updateClaim,
  type AppState,
} from '../core/claims.store'
import { StatusChipComponent } from '../shared/status-chip.component'

type ItemBase = {
  baseBatchNo: string
  baseQuoteVersion: number
  salvage: number
  liability: number
  attachmentVersions: Record<string, number>
}

@Component({
  selector: 'app-assessment-page',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    CurrencyPipe,
    MatButtonModule,
    MatCardModule,
    MatExpansionModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatSelectModule,
    MatTableModule,
    StatusChipComponent,
  ],
  template: `
    <section class="page" *ngIf="claim$ | async as claim">
      <div class="page-head">
        <div>
          <p class="eyebrow">ASSESSMENT / 查勘定损</p>
          <h1>{{ claim.id }} · {{ claim.insured }}</h1>
          <p class="muted">{{ claim.lossAddress }} · 事故日 {{ claim.accidentDate }} · 查勘员 {{ claim.adjuster }}</p>
          <p class="batch-line">
            <mat-icon>inventory_2</mat-icon>
            基线批次号 <strong>{{ claim.baselineBatchNo || '—' }}</strong>
            <ng-container *ngIf="batchNo">
              · 草稿批次 <strong>{{ batchNo }}</strong>（V{{ batchVersion }}）· 请求编号 <code>{{ requestId }}</code>
            </ng-container>
            <ng-container *ngIf="!batchNo"> · 调整报价或责任比例前请先取批次号</ng-container>
          </p>
        </div>
        <div class="actions">
          <button mat-stroked-button (click)="takeBatch(claim)"><mat-icon>playlist_add</mat-icon> 取批次号</button>
          <button mat-flat-button color="primary" (click)="saveBatch(claim)"><mat-icon>save</mat-icon> 保存批次</button>
          <button mat-stroked-button [disabled]="!lastBody" (click)="retry(claim)"><mat-icon>refresh</mat-icon> 按请求编号重试</button>
        </div>
      </div>

      <mat-card class="conflict-banner" *ngIf="conflicts$ | async as conflicts">
        <ng-container *ngIf="conflicts.length">
        <div class="conflict-head">
          <mat-icon>warning</mat-icon>
          <strong>后到批次未放行（先到先得）</strong>
          <span>批次 {{ conflictBatchNo$ | async }} 与他人修改冲突，以下科目已被抢先提交；本笔未写入，草稿已保留。</span>
        </div>
        <ul>
          <li *ngFor="let c of conflicts">
            <mat-icon>block</mat-icon>
            <div>
              <strong>被改对象：{{ c.category }}（{{ c.itemId }}）</strong>
              已被批次 <code>{{ c.batchNo }}</code> 抢先修改 · {{ c.modifiedBy }} · {{ c.modifiedAt }}
            </div>
          </li>
        </ul>
        <div class="conflict-actions">
          <button mat-flat-button color="primary" (click)="rebaseAndTakeBatch(claim)"><mat-icon>published_with_changes</mat-icon> 重新取批次号（保留草稿）</button>
          <button mat-stroked-button (click)="dismissConflicts()"><mat-icon>edit_note</mat-icon> 保留草稿，稍后处理</button>
        </div>
        </ng-container>
      </mat-card>

      <div class="summary-grid">
        <mat-card appearance="outlined"><span>损失科目</span><strong>{{ claim.lossItems.length }}</strong><small>{{ disputedCount(claim) }} 项存在争议</small></mat-card>
        <mat-card appearance="outlined"><span>修复报价合计</span><strong>{{ quoteTotal(claim) | currency:'CNY':'symbol':'1.0-0' }}</strong><small>取各科目最新报价</small></mat-card>
        <mat-card appearance="outlined"><span>残值合计</span><strong>{{ salvageTotal(claim) | currency:'CNY':'symbol':'1.0-0' }}</strong><small>待扣减</small></mat-card>
        <mat-card appearance="outlined"><span>建议准备金</span><strong>{{ suggestedReserve(claim) | currency:'CNY':'symbol':'1.0-0' }}</strong><small>责任比例后计入免赔</small></mat-card>
      </div>

      <div class="assessment-grid">
        <section class="panel">
          <div class="panel-head"><h3>损失科目与报价版本</h3><span class="muted">每次调整必须保留理由，并随批次提交</span></div>
          <mat-accordion multi>
            <mat-expansion-panel *ngFor="let item of claim.lossItems; let itemIndex = index" [expanded]="itemIndex === activeIndex" (opened)="activeIndex = itemIndex">
              <mat-expansion-panel-header>
                <mat-panel-title>
                  <strong>{{ item.category }}</strong>
                  <span>{{ item.description }}</span>
                </mat-panel-title>
                <mat-panel-description>
                  <app-status-chip [label]="item.disputed ? '争议项' : '已确认'" [tone]="item.disputed ? 'warn' : 'good'" />
                  <span class="quote">{{ latestQuote(item) | currency:'CNY':'symbol':'1.0-0' }}</span>
                </mat-panel-description>
              </mat-expansion-panel-header>
              <div class="loss-body">
                <p class="baseline-tag"><mat-icon>inventory_2</mat-icon> 基线批次 <code>{{ item.baselineBatchNo || '—' }}</code></p>
                <div class="facts">
                  <label>损失事实</label>
                  <textarea [(ngModel)]="item.damage" rows="3"></textarea>
                  <div class="inline-fields">
                    <mat-form-field appearance="outline" subscriptSizing="dynamic"><mat-label>残值</mat-label><input matInput type="number" [(ngModel)]="item.salvage" /></mat-form-field>
                    <mat-form-field appearance="outline" subscriptSizing="dynamic"><mat-label>责任比例</mat-label><input matInput type="number" step="0.05" [(ngModel)]="item.liability" /></mat-form-field>
                  </div>
                </div>
                <div class="quote-history">
                  <h4>报价版本</h4>
                  <table mat-table [dataSource]="item.repairQuotes">
                    <ng-container matColumnDef="version"><th mat-header-cell *matHeaderCellDef>版本</th><td mat-cell *matCellDef="let quote">V{{ quote.version }}</td></ng-container>
                    <ng-container matColumnDef="amount"><th mat-header-cell *matHeaderCellDef>金额</th><td mat-cell *matCellDef="let quote">{{ quote.amount | currency:'CNY':'symbol':'1.0-0' }}</td></ng-container>
                    <ng-container matColumnDef="reason"><th mat-header-cell *matHeaderCellDef>调整理由</th><td mat-cell *matCellDef="let quote">{{ quote.reason }}<small>{{ quote.operator }} · {{ quote.createdAt }}</small></td></ng-container>
                    <tr mat-header-row *matHeaderRowDef="quoteColumns"></tr>
                    <tr mat-row *matRowDef="let row; columns: quoteColumns"></tr>
                  </table>
                </div>
                <div class="attachment-row">
                  <strong>关联材料</strong>
                  <span *ngFor="let file of item.attachments"><mat-icon>attach_file</mat-icon>{{ file.name }} · V{{ file.version }}
                    <button mat-button color="primary" (click)="bumpAttachment(claim, item, file)"><mat-icon>upgrade</mat-icon>新版本</button>
                  </span>
                  <button mat-stroked-button color="primary"><mat-icon>upload_file</mat-icon>上传附件</button>
                </div>
                <button mat-stroked-button color="primary" (click)="startQuote(claim, item)"><mat-icon>edit_road</mat-icon> 调整最新报价</button>
                <div class="quote-form" *ngIf="quotingItemId === item.id">
                  <p class="batch-hint" *ngIf="batchNo">将随草稿批次 <code>{{ batchNo }}</code> 提交</p>
                  <mat-form-field appearance="outline" subscriptSizing="dynamic"><mat-label>新报价</mat-label><input matInput type="number" [(ngModel)]="quoteAmount" /></mat-form-field>
                  <mat-form-field appearance="outline" subscriptSizing="dynamic" class="reason-field"><mat-label>调整理由（必填）</mat-label><input matInput [(ngModel)]="quoteReason" /></mat-form-field>
                  <button mat-flat-button color="primary" [disabled]="!quoteReason.trim() || !quoteAmount" (click)="submitQuote(claim)">提交报价并入批次</button>
                </div>
              </div>
            </mat-expansion-panel>
          </mat-accordion>
        </section>

        <aside>
          <section class="panel">
            <div class="panel-head"><h3>专家记录</h3><span class="muted">不可覆盖</span></div>
            <div class="expert-list">
              <div *ngFor="let item of claim.lossItems">
                <strong>{{ item.category }}</strong>
                <p *ngFor="let note of item.expertNotes">{{ note }}</p>
                <small *ngIf="item.expertNotes.length === 0">暂无专家补充说明</small>
              </div>
            </div>
          </section>
          <section class="panel draft-panel">
            <div class="panel-head"><h3>查勘草稿</h3><mat-icon>cloud_done</mat-icon></div>
            <textarea rows="7" [(ngModel)]="draft" (blur)="saveDraft(claim)"></textarea>
            <small>离开页面后仍可恢复到本地草稿；批次冲突时草稿同样保留。</small>
          </section>
        </aside>
      </div>
    </section>
  `,
  styles: [`
    .summary-grid { display: grid; grid-template-columns: repeat(4,minmax(0,1fr)); gap: 12px; margin-bottom: 14px; }
    .summary-grid mat-card { padding: 15px; border-color: #dce3e6; }
    .summary-grid span, .summary-grid small { display: block; color: #6e7a83; font-size: 12px; }
    .summary-grid strong { display: block; margin: 6px 0; color: #153747; font-size: 24px; }
    .assessment-grid { display: grid; grid-template-columns: minmax(0,1fr) 330px; gap: 14px; align-items: start; }
    mat-panel-title { display: flex; flex-direction: column; gap: 4px; }
    mat-panel-title span { color: #7a858c; font-size: 11px; }
    mat-panel-description { justify-content: flex-end; gap: 12px; }
    .quote { color: #1d6670; font-weight: 800; }
    .loss-body { display: grid; gap: 16px; padding-top: 10px; }
    .baseline-tag { display: flex; align-items: center; gap: 5px; margin: 0; color: #4a6b74; font-size: 12px; }
    .baseline-tag mat-icon { font-size: 15px; width: 15px; height: 15px; }
    .baseline-tag code, .batch-line code, .batch-hint code { padding: 1px 6px; background: #eaf2f4; border-radius: 4px; color: #175866; }
    .facts > label { display: block; margin-bottom: 6px; color: #53636d; font-size: 12px; font-weight: 700; }
    textarea { width: 100%; padding: 10px; border: 1px solid #cbd5da; border-radius: 8px; resize: vertical; font: inherit; }
    .inline-fields, .quote-form { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
    .inline-fields mat-form-field { width: 150px; }
    .quote-history h4 { margin: 0 0 8px; font-size: 13px; }
    table { width: 100%; }
    td small { display: block; margin-top: 4px; color: #7a858c; }
    .attachment-row { display: flex; flex-wrap: wrap; align-items: center; gap: 7px; }
    .attachment-row > span { display: inline-flex; align-items: center; gap: 3px; padding: 5px 7px; color: #4f626d; background: #f0f4f5; border-radius: 5px; font-size: 11px; }
    .attachment-row mat-icon { font-size: 14px; width: 14px; height: 14px; }
    .attachment-row button { line-height: 20px; }
    .quote-form { padding: 12px; background: #f4f7f8; border-left: 3px solid #277b89; }
    .batch-hint { flex-basis: 100%; margin: 0; color: #4a6b74; font-size: 12px; }
    .reason-field { flex: 1; min-width: 220px; }
    aside { display: grid; gap: 14px; }
    .expert-list { padding: 8px 16px 16px; }
    .expert-list div { padding: 10px 0; border-bottom: 1px solid #edf0f2; }
    .expert-list p { margin: 6px 0 0; color: #65737c; font-size: 11px; line-height: 1.5; }
    .expert-list small { color: #8b969d; font-size: 11px; }
    .draft-panel { padding-bottom: 14px; }
    .draft-panel textarea { width: calc(100% - 28px); margin: 14px; }
    .draft-panel small { display: block; margin: -6px 14px 0; color: #7d8991; }
    .batch-line { display: flex; align-items: center; gap: 6px; margin: 6px 0 0; color: #4a6b74; font-size: 13px; }
    .batch-line mat-icon { font-size: 16px; width: 16px; height: 16px; }
    .conflict-banner { margin-bottom: 14px; padding: 14px 16px; border-color: #ce743e; background: #fff7f1; }
    .conflict-head { display: flex; align-items: center; gap: 8px; color: #984313; }
    .conflict-head mat-icon { color: #ce743e; }
    .conflict-head span { color: #7a5a48; font-size: 12px; }
    .conflict-banner ul { margin: 10px 0; padding: 0; list-style: none; }
    .conflict-banner li { display: flex; gap: 8px; align-items: flex-start; padding: 8px 10px; background: #fff; border: 1px solid #f0d9c8; border-radius: 6px; }
    .conflict-banner li mat-icon { color: #ce743e; font-size: 18px; width: 18px; height: 18px; }
    .conflict-banner li div { color: #5f4a3e; font-size: 12px; }
    .conflict-banner code { padding: 1px 6px; background: #fbeee4; border-radius: 4px; color: #984313; }
    .conflict-actions { display: flex; gap: 8px; }
    @media (max-width: 1050px) { .assessment-grid { grid-template-columns: 1fr; } .summary-grid { grid-template-columns: repeat(2,1fr); } }
    @media (max-width: 620px) { .summary-grid { grid-template-columns: 1fr 1fr; } }
  `],
})
export class AssessmentPageComponent {
  claim$: Observable<ClaimCase>
  conflicts$: Observable<ReturnType<typeof selectConflicts>>
  conflictBatchNo$: Observable<string>
  quoteColumns = ['version', 'amount', 'reason']
  activeIndex = 0
  quotingItemId = ''
  quoteAmount = 0
  quoteReason = ''
  draft = localStorage.getItem('claims-assessment-draft') ?? '待补充房屋檩条第三方复测依据，并核对存货库龄核减。'

  /** 当前草稿批次 */
  batchNo = ''
  batchVersion = 0
  requestId = ''
  /** 取批次号时各科目的基线快照，用于冲突校验与变更识别 */
  bases: Record<string, ItemBase> = {}
  /** 最近一次提交请求体，供按请求编号重试 */
  lastBody: BatchCommitBody | null = null

  constructor(
    private readonly store: Store<AppState>,
    private readonly service: ClaimsService,
    private readonly snackBar: MatSnackBar,
  ) {
    this.claim$ = this.store.select(selectSelectedClaim)
    this.conflicts$ = this.store.select(selectConflicts)
    this.conflictBatchNo$ = this.store.select(selectConflictBatchNo)
    this.store.select((state) => state.claims.draft).subscribe((draft) => (this.draft = draft))
  }

  latestQuote(item: { repairQuotes: Array<{ amount: number }> }) {
    return item.repairQuotes.at(-1)?.amount ?? 0
  }

  quoteTotal(claim: ClaimCase) {
    return claim.lossItems.reduce((sum, item) => sum + this.latestQuote(item), 0)
  }

  salvageTotal(claim: ClaimCase) {
    return claim.lossItems.reduce((sum, item) => sum + item.salvage, 0)
  }

  suggestedReserve(claim: ClaimCase) {
    const net = claim.lossItems.reduce((sum, item) => sum + Math.max(0, (this.latestQuote(item) - item.salvage) * item.liability), 0)
    return Math.max(0, net - claim.deductible)
  }

  disputedCount(claim: ClaimCase) {
    return claim.lossItems.filter((item) => item.disputed).length
  }

  /** 取批次号：调整报价或责任比例前先取号；基线快照以服务端最新数据为准 */
  takeBatch(claim: ClaimCase) {
    this.openBatchWithFreshBases(claim.id).subscribe((res) => {
      this.batchNo = res.batchNo
      this.batchVersion = res.version
      this.requestId = newRequestId()
      this.lastBody = null
      this.store.dispatch(clearConflicts())
      this.snackBar.open(`已取批次号 ${res.batchNo}（V${res.version}），保存时损失科目、准备金、附件版本、会签状态一起提交`, '关闭', { duration: 2600 })
    })
  }

  /** 冲突后按服务端最新基线重新取号，并把未提交草稿覆盖回最新基线 */
  rebaseAndTakeBatch(claim: ClaimCase) {
    this.openBatchWithFreshBases(claim.id).subscribe((res) => {
      this.batchNo = res.batchNo
      this.batchVersion = res.version
      this.requestId = newRequestId()
      this.lastBody = null
      const merged = this.mergeDraft(res.fresh, claim)
      this.store.dispatch(updateClaim({ claim: merged }))
      this.store.dispatch(clearConflicts())
      this.snackBar.open(`已按最新基线重新取批次号 ${res.batchNo}，未提交草稿已保留`, '关闭', { duration: 2400 })
    })
  }

  /** 取批次号并以服务端最新数据建立基线快照 */
  private openBatchWithFreshBases(claimId: string) {
    return forkJoin({ fresh: this.service.get(claimId), batch: this.service.openBatch(claimId) }).pipe(
      take(1),
      map(({ fresh, batch }) => {
        this.captureBases(fresh)
        return { fresh, batchNo: batch.batchNo, version: batch.version }
      }),
    )
  }

  dismissConflicts() {
    this.store.dispatch(clearConflicts())
  }

  /** 把客户端未提交的残值/责任比例/附件版本编辑覆盖到服务端最新基线之上 */
  private mergeDraft(fresh: ClaimCase, draft: ClaimCase): ClaimCase {
    for (const freshItem of fresh.lossItems) {
      const draftItem = draft.lossItems.find((item) => item.id === freshItem.id)
      if (!draftItem) continue
      freshItem.salvage = draftItem.salvage
      freshItem.liability = draftItem.liability
      for (const freshAttachment of freshItem.attachments) {
        const draftAttachment = draftItem.attachments.find((a) => a.id === freshAttachment.id)
        if (draftAttachment && draftAttachment.version > freshAttachment.version) {
          freshAttachment.version = draftAttachment.version
        }
      }
    }
    return fresh
  }

  private captureBases(claim: ClaimCase) {
    this.bases = {}
    for (const item of claim.lossItems) {
      this.bases[item.id] = {
        baseBatchNo: item.baselineBatchNo ?? INIT_BATCH_NO,
        baseQuoteVersion: item.repairQuotes.length,
        salvage: item.salvage,
        liability: item.liability,
        attachmentVersions: Object.fromEntries(item.attachments.map((a) => [a.id, a.version])),
      }
    }
  }

  startQuote(claim: ClaimCase, item: LossItem) {
    if (!this.batchNo) {
      this.takeBatch(claim)
    }
    this.quotingItemId = item.id
    this.quoteAmount = this.latestQuote(item)
    this.quoteReason = ''
  }

  /** 附件新版本：随批次提交，只增不减 */
  bumpAttachment(claim: ClaimCase, item: LossItem, file: Attachment) {
    const bump = () => {
      file.version += 1
      this.snackBar.open(`附件 ${file.name} 已排为新版本，随批次 ${this.batchNo} 提交`, '关闭', { duration: 1600 })
    }
    if (this.batchNo) {
      bump()
      return
    }
    this.openBatchWithFreshBases(claim.id).pipe(take(1)).subscribe((res) => {
      this.batchNo = res.batchNo
      this.batchVersion = res.version
      this.requestId = newRequestId()
      this.lastBody = null
      this.store.dispatch(clearConflicts())
      bump()
    })
  }

  submitQuote(claim: ClaimCase) {
    if (!this.quoteReason.trim() || !this.quoteAmount) return
    this.commit(claim)
  }

  saveBatch(claim: ClaimCase) {
    if (!this.batchNo) {
      this.openBatchWithFreshBases(claim.id).subscribe((res) => {
        this.batchNo = res.batchNo
        this.batchVersion = res.version
        this.requestId = newRequestId()
        this.commit(claim)
      })
      return
    }
    this.commit(claim)
  }

  /** 批次写入失败后按请求编号重试，沿用第一次结果 */
  retry(claim: ClaimCase) {
    if (!this.lastBody) return
    this.service.commitBatch(claim.id, this.lastBody).subscribe({
      next: (res) => {
        if (res.ok && res.claim) {
          this.store.dispatch(
            batchCommitted({
              claim: res.claim,
              batchNo: res.batchNo,
              deduped: res.deduped ?? false,
              invalidatedApprovals: res.invalidatedApprovals ?? [],
            }),
          )
          this.afterCommitted(res.claim)
        }
      },
      error: (err) => this.handleError(err),
    })
  }

  private commit(claim: ClaimCase) {
    if (!this.batchNo) {
      this.openBatchWithFreshBases(claim.id).subscribe((res) => {
        this.batchNo = res.batchNo
        this.batchVersion = res.version
        this.requestId = newRequestId()
        this.commit(claim)
      })
      return
    }
    const body = this.buildBody(claim)
    this.lastBody = body
    this.service.commitBatch(claim.id, body).subscribe({
      next: (res) => {
        if (res.ok && res.claim) {
          this.store.dispatch(
            batchCommitted({
              claim: res.claim,
              batchNo: res.batchNo,
              deduped: res.deduped ?? false,
              invalidatedApprovals: res.invalidatedApprovals ?? [],
            }),
          )
          this.afterCommitted(res.claim)
        }
      },
      error: (err) => this.handleError(err),
    })
  }

  private handleError(err: any) {
    if (err.status === 409 && err.error?.conflicts) {
      const conflicts = err.error.conflicts as never[]
      this.store.dispatch(setConflicts({ conflicts, batchNo: this.batchNo }))
      this.snackBar.open(`后到批次 ${this.batchNo} 未放行：被改对象已列出，草稿已保留`, '关闭', { duration: 2600 })
    }
  }

  private afterCommitted(claim: ClaimCase) {
    this.quotingItemId = ''
    this.quoteReason = ''
    this.batchNo = ''
    this.batchVersion = 0
    this.requestId = ''
    this.captureBases(claim)
  }

  private buildBody(claim: ClaimCase): BatchCommitBody {
    const items: BatchItemChange[] = claim.lossItems.map((item) => {
      const base = this.bases[item.id]
      const attachmentVersions = item.attachments.map((a) => ({ attachmentId: a.id, version: a.version }))
      const baseAttachmentVersions = base?.attachmentVersions ?? {}
      const attachmentsChanged = attachmentVersions.some((av) => av.version !== (baseAttachmentVersions[av.attachmentId] ?? av.version))
      const liabilityChanged = base !== undefined && item.liability !== base.liability
      const salvageChanged = base !== undefined && item.salvage !== base.salvage
      const quoteChanged = this.quotingItemId === item.id && !!this.quoteReason.trim() && !!this.quoteAmount
      const changed = quoteChanged || attachmentsChanged || liabilityChanged || salvageChanged

      const change: BatchItemChange = {
        itemId: item.id,
        baseBatchNo: base?.baseBatchNo ?? item.baselineBatchNo ?? INIT_BATCH_NO,
        baseQuoteVersion: base?.baseQuoteVersion ?? item.repairQuotes.length,
        latestQuoteAmount: this.latestQuote(item),
        salvage: item.salvage,
        liability: item.liability,
        attachmentVersions,
        changed,
      }
      if (quoteChanged) {
        change.newQuote = { amount: Number(this.quoteAmount), reason: this.quoteReason.trim() }
      }
      return change
    })

    return {
      requestId: this.requestId,
      batchNo: this.batchNo,
      operator: '当前用户',
      reserve: this.suggestedReserve(claim),
      items,
    }
  }

  saveDraft(claim: ClaimCase) {
    localStorage.setItem('claims-assessment-draft', this.draft)
    this.store.dispatch(updateClaim({ claim: structuredClone(claim) }))
  }
}
