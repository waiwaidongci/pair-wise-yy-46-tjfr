import { Component, ElementRef, ViewChild } from '@angular/core'
import { CommonModule, CurrencyPipe } from '@angular/common'
import { FormsModule } from '@angular/forms'
import { MatButtonModule } from '@angular/material/button'
import { MatCardModule } from '@angular/material/card'
import { MatExpansionModule } from '@angular/material/expansion'
import { MatFormFieldModule } from '@angular/material/form-field'
import { MatIconModule } from '@angular/material/icon'
import { MatInputModule } from '@angular/material/input'
import { MatSnackBar } from '@angular/material/snack-bar'
import { MatTableModule } from '@angular/material/table'
import { Store } from '@ngrx/store'
import { Observable, tap } from 'rxjs'
import { ClaimsService } from '../core/claims.service'
import { calculateReserve, nowText } from '../core/baseline'
import type {
  Attachment,
  BaselineBatch,
  BatchConflict,
  BatchSaveRequest,
  BatchSubmitItem,
  ClaimCase,
  LossItem,
} from '../core/models'
import { selectSelectedClaim, updateClaim, type AppState } from '../core/claims.store'
import { StatusChipComponent } from '../shared/status-chip.component'

type QuoteForm = { open: boolean; amount: number; reason: string }

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
    MatTableModule,
    StatusChipComponent,
  ],
  template: `
    <section class="page" *ngIf="claim$ | async as claim">
      <div class="page-head">
        <div>
          <p class="eyebrow">ASSESSMENT / 基线定损批次</p>
          <h1>{{ claim.id }} · {{ claim.insured }}</h1>
          <p class="muted">{{ claim.lossAddress }} · 当前正式版本 {{ claim.batchNo }} / V{{ claim.batchVersion }}</p>
        </div>
        <div class="actions">
          <button mat-stroked-button [disabled]="starting || !!batch" (click)="startBaseline(claim)">
            <mat-icon>lock_clock</mat-icon> {{ batch ? '批次已锁定基线' : '调整前先取批次号' }}
          </button>
          <button mat-flat-button color="primary" [disabled]="!batch || saving" (click)="saveBatch(claim)">
            <mat-icon>{{ saving ? 'sync' : 'send' }}</mat-icon> {{ saving ? '提交或安全重试中' : '保存本次定损批次' }}
          </button>
        </div>
      </div>

      <section class="panel batch-banner" [class.active]="!!batch" [class.conflict]="!!conflict">
        <div>
          <span class="batch-label">编辑批次</span>
          <strong>{{ batch?.batchNo ?? '尚未取号' }}</strong>
          <small *ngIf="batch">请求编号 {{ batch.requestId }} · 取号时间 {{ batch.createdAt }} · 基线准备金 {{ batch.baselineReserve | currency:'CNY':'symbol':'1.0-0' }}</small>
          <small *ngIf="!batch">报价、责任比例或附件变更前先取批次号；保存时原子提交科目、准备金、附件和会签状态。</small>
        </div>
        <label class="lost-switch" *ngIf="batch">
          <input type="checkbox" [(ngModel)]="simulateLostWrite" />
          <span>模拟首次写入响应丢失</span>
        </label>
      </section>

      <div class="conflict-panel" *ngIf="conflict">
        <div class="conflict-title"><mat-icon>gpp_bad</mat-icon><strong>后到批次未放行，草稿已保留</strong></div>
        <p>{{ conflict.message }} · 请求编号 {{ conflict.requestId }}</p>
        <div class="conflict-list" *ngFor="let blocked of conflict.blockedItems">
          <strong>{{ blocked.category }} · {{ blocked.description }}（{{ blocked.itemId }}）</strong>
          <span>被改对象：{{ blocked.changedBy }} · {{ blocked.changedAt }}</span>
          <span>变更字段：{{ blocked.changedFields.join('、') || '版本已变化' }}</span>
          <span>版本：V{{ blocked.baseRevision }} → V{{ blocked.latestRevision }}</span>
        </div>
        <button mat-flat-button color="primary" (click)="rebaseDraft(claim)"><mat-icon>rule_folder</mat-icon> 保留草稿并基于最新版本重建</button>
      </div>

      <div class="summary-grid">
        <mat-card appearance="outlined"><span>损失科目</span><strong>{{ claim.lossItems.length }}</strong><small>{{ disputedCount(claim) }} 项存在争议</small></mat-card>
        <mat-card appearance="outlined"><span>正式准备金</span><strong>{{ claim.reserve | currency:'CNY':'symbol':'1.0-0' }}</strong><small>{{ claim.batchNo }}</small></mat-card>
        <mat-card appearance="outlined"><span>批次试算准备金</span><strong>{{ draftReserve(claim) | currency:'CNY':'symbol':'1.0-0' }}</strong><small>随草稿即时重算</small></mat-card>
        <mat-card appearance="outlined"><span>会签状态</span><strong class="approval-state">{{ approvalSummary(claim) }}</strong><small>关键证据变化后从受影响档位重签</small></mat-card>
      </div>

      <div class="assessment-grid">
        <section class="panel">
          <div class="panel-head">
            <h3>损失科目与报价版本</h3>
            <span class="muted" *ngIf="batch">正在编辑 {{ batch.batchNo }}，先到先得</span>
            <span class="muted warn-text" *ngIf="!batch">当前只读：先取批次号</span>
          </div>
          <mat-accordion multi>
            <mat-expansion-panel *ngFor="let item of claim.lossItems; let itemIndex = index">
              <mat-expansion-panel-header>
                <mat-panel-title>
                  <strong>{{ item.category }}</strong>
                  <span>{{ item.description }}</span>
                </mat-panel-title>
                <mat-panel-description>
                  <app-status-chip [label]="revisionLabel(item, itemIndex)" [tone]="isStale(item, itemIndex) ? 'warn' : 'default'" />
                  <app-status-chip [label]="item.disputed ? '争议项' : '已确认'" [tone]="item.disputed ? 'warn' : 'good'" />
                  <span class="quote">{{ draftQuoteAmount(item, itemIndex) | currency:'CNY':'symbol':'1.0-0' }}</span>
                </mat-panel-description>
              </mat-expansion-panel-header>
              <div class="loss-body" *ngIf="workingItems[itemIndex] as draft">
                <div class="stale-warning" *ngIf="isStale(item, itemIndex)">
                  <mat-icon>priority_high</mat-icon>
                  <span>{{ item.category }} 已被 {{ item.revision }} 版先保存；你的 V{{ draft.baseRevision }} 草稿不会被覆盖。</span>
                </div>
                <div class="facts">
                  <label>损失事实</label>
                  <textarea rows="3" [(ngModel)]="draft.damage" [disabled]="!batch"></textarea>
                  <div class="inline-fields">
                    <mat-form-field appearance="outline" subscriptSizing="dynamic"><mat-label>残值</mat-label><input matInput type="number" [(ngModel)]="draft.salvage" [disabled]="!batch" /></mat-form-field>
                    <mat-form-field appearance="outline" subscriptSizing="dynamic"><mat-label>责任比例</mat-label><input matInput type="number" step="0.05" [(ngModel)]="draft.liability" [disabled]="!batch" /></mat-form-field>
                  </div>
                </div>
                <div class="quote-history">
                  <div class="section-line">
                    <h4>正式报价版本</h4>
                    <button mat-stroked-button color="primary" [disabled]="!batch" (click)="openQuoteForm(item, itemIndex)"><mat-icon>edit_road</mat-icon> 调整最新报价</button>
                  </div>
                  <table mat-table [dataSource]="item.repairQuotes">
                    <ng-container matColumnDef="version"><th mat-header-cell *matHeaderCellDef>版本</th><td mat-cell *matCellDef="let quote">V{{ quote.version }}</td></ng-container>
                    <ng-container matColumnDef="batch"><th mat-header-cell *matHeaderCellDef>批次</th><td mat-cell *matCellDef="let quote">{{ quote.batchNo || 'INI' }}</td></ng-container>
                    <ng-container matColumnDef="amount"><th mat-header-cell *matHeaderCellDef>金额</th><td mat-cell *matCellDef="let quote">{{ quote.amount | currency:'CNY':'symbol':'1.0-0' }}</td></ng-container>
                    <ng-container matColumnDef="reason"><th mat-header-cell *matHeaderCellDef>调整理由</th><td mat-cell *matCellDef="let quote">{{ quote.reason }}<small>{{ quote.operator }} · {{ quote.createdAt }}</small></td></ng-container>
                    <tr mat-header-row *matHeaderRowDef="quoteColumns"></tr>
                    <tr mat-row *matHeaderRowDef="quoteColumns"></tr>
                  </table>
                </div>

                <div class="quote-form" *ngIf="quoteForms[item.id]?.open && batch">
                  <mat-form-field appearance="outline" subscriptSizing="dynamic"><mat-label>新报价</mat-label><input matInput type="number" [(ngModel)]="quoteForms[item.id]!.amount" /></mat-form-field>
                  <mat-form-field appearance="outline" subscriptSizing="dynamic" class="reason-field"><mat-label>调整理由（必填）</mat-label><input matInput [(ngModel)]="quoteForms[item.id]!.reason" /></mat-form-field>
                  <button mat-flat-button color="primary" [disabled]="!quoteReady(item.id)" (click)="applyQuote(item, itemIndex)">放入批次</button>
                  <button mat-button (click)="cancelQuote(item.id)">取消</button>
                </div>
                <div class="pending-quote" *ngIf="draft.newQuote">
                  <mat-icon>pending_actions</mat-icon>
                  <span>待提交 V{{ draft.quoteVersion + 1 }}：{{ draft.newQuote.amount | currency:'CNY':'symbol':'1.0-0' }}；{{ draft.newQuote.reason }}</span>
                </div>

                <div class="attachment-head">
                  <strong>关联材料 · 证据版本 V{{ item.evidenceVersion }}</strong>
                  <button mat-stroked-button [disabled]="!batch" (click)="prepareUpload(item.id)"><mat-icon>upload_file</mat-icon> 上传新版附件</button>
                </div>
                <div class="attachment-row">
                  <span *ngFor="let file of item.attachments"><mat-icon>attach_file</mat-icon>{{ file.name }} · V{{ file.version }}</span>
                </div>
                <div class="attachment-row pending" *ngIf="pendingAttachments(itemIndex).length">
                  <em>本批次新增：</em>
                  <span *ngFor="let file of pendingAttachments(itemIndex)"><mat-icon>note_add</mat-icon>{{ file.name }} · V{{ file.version }}</span>
                </div>

                <button mat-stroked-button color="warn" [disabled]="externalBusyId === item.id" (click)="simulateExternal(claim, item)">
                  <mat-icon>groups</mat-icon> 模拟同事先保存此科目
                </button>
              </div>
            </mat-expansion-panel>
          </mat-accordion>
        </section>

        <aside>
          <section class="panel">
            <div class="panel-head"><h3>批次快照</h3><mat-icon>fact_check</mat-icon></div>
            <div class="snapshot-list">
              <div *ngFor="let base of batch?.items ?? []">
                <strong>{{ base.category }}</strong>
                <small>科目 V{{ base.baseRevision }} · 报价 V{{ base.quoteVersion }} · 证据 V{{ base.evidenceVersion }}</small>
              </div>
              <p *ngIf="!batch">取号后固化每个科目的修订号、报价版本和附件版本。</p>
            </div>
          </section>
          <section class="panel draft-panel">
            <div class="panel-head"><h3>提交边界</h3><mat-icon>verified</mat-icon></div>
            <ul class="rules">
              <li>保存时一起提交损失科目、准备金、附件版本、会签状态。</li>
              <li>同科目并发只放行先到一笔，后到一笔列出对象并保留草稿。</li>
              <li>请求编号不变的重试只返回第一次结果。</li>
              <li>旧数据已补 INI 初始批次，原审计仍可查询。</li>
            </ul>
          </section>
        </aside>
      </div>
      <input #fileInput class="hidden-file" type="file" (change)="onFileSelected($event)" />
    </section>
  `,
  styles: [`
    .batch-banner { display: flex; align-items: center; justify-content: space-between; gap: 14px; margin-bottom: 14px; padding: 14px 16px; border-color: #cbd6db; background: #f7f9fa; }
    .batch-banner.active { border-color: #3f8b94; background: #eef8f8; }
    .batch-banner.conflict { border-color: #d27945; background: #fff4eb; }
    .batch-label, .batch-banner small { display: block; color: #74818a; font-size: 11px; }
    .batch-banner strong { display: block; margin: 3px 0; color: #173d49; font-size: 18px; }
    .lost-switch { display: flex; align-items: center; gap: 7px; white-space: nowrap; color: #6a4a2d; font-size: 12px; }
    .lost-switch input { width: 16px; height: 16px; }
    .conflict-panel { margin-bottom: 14px; padding: 14px 16px; border: 1px solid #d87943; border-left-width: 4px; border-radius: 10px; background: #fff4eb; }
    .conflict-title { display: flex; align-items: center; gap: 7px; color: #9c4318; }
    .conflict-panel p { margin: 7px 0 10px; color: #75513d; font-size: 12px; }
    .conflict-list { display: grid; gap: 3px; margin: 8px 0; padding: 10px; border-radius: 7px; background: rgb(255 255 255 / 70%); color: #5d514b; font-size: 12px; }
    .summary-grid { display: grid; grid-template-columns: repeat(4,minmax(0,1fr)); gap: 12px; margin-bottom: 14px; }
    .summary-grid mat-card { padding: 15px; border-color: #dce3e6; }
    .summary-grid span, .summary-grid small { display: block; color: #6e7a83; font-size: 12px; }
    .summary-grid strong { display: block; margin: 6px 0; color: #153747; font-size: 22px; }
    .approval-state { font-size: 17px; line-height: 1.35; }
    .assessment-grid { display: grid; grid-template-columns: minmax(0,1fr) 330px; gap: 14px; align-items: start; }
    mat-panel-title { display: flex; flex-direction: column; gap: 4px; }
    mat-panel-title span { color: #7a858c; font-size: 11px; }
    mat-panel-description { justify-content: flex-end; gap: 12px; }
    .quote { color: #1d6670; font-weight: 800; }
    .loss-body { display: grid; gap: 16px; padding-top: 10px; }
    .facts > label { display: block; margin-bottom: 6px; color: #53636d; font-size: 12px; font-weight: 700; }
    textarea { width: 100%; padding: 10px; border: 1px solid #cbd5da; border-radius: 8px; resize: vertical; font: inherit; }
    textarea:disabled, input:disabled { background: #f6f8f9; color: #7d8991; }
    .inline-fields, .quote-form { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
    .inline-fields mat-form-field { width: 150px; }
    .section-line, .attachment-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
    .quote-history h4 { margin: 0; font-size: 13px; }
    table { width: 100%; }
    td small { display: block; margin-top: 4px; color: #7a858c; }
    .stale-warning { display: flex; gap: 8px; align-items: center; padding: 9px 11px; border-radius: 7px; color: #9a4319; background: #fff0e4; font-size: 12px; }
    .quote-form { padding: 12px; background: #f4f7f8; border-left: 3px solid #277b89; }
    .reason-field { flex: 1; min-width: 220px; }
    .pending-quote { display: flex; gap: 7px; align-items: center; padding: 9px 11px; border-radius: 7px; color: #17616c; background: #eaf7f7; font-size: 12px; }
    .attachment-head strong { font-size: 13px; }
    .attachment-row { display: flex; flex-wrap: wrap; align-items: center; gap: 7px; }
    .attachment-row span { display: inline-flex; align-items: center; gap: 3px; padding: 5px 7px; color: #4f626d; background: #f0f4f5; border-radius: 5px; font-size: 11px; }
    .attachment-row.pending span { color: #1d6570; background: #e4f3f4; }
    .attachment-row mat-icon { font-size: 14px; width: 14px; height: 14px; }
    aside { display: grid; gap: 14px; }
    .snapshot-list { padding: 8px 16px 16px; }
    .snapshot-list div { padding: 10px 0; border-bottom: 1px solid #edf0f2; }
    .snapshot-list strong, .snapshot-list small { display: block; }
    .snapshot-list small { margin-top: 4px; color: #75818c; font-size: 11px; }
    .snapshot-list p, .rules { color: #65737c; font-size: 12px; line-height: 1.6; }
    .rules { padding-right: 18px; }
    .warn-text { color: #a35025; font-weight: 700; }
    .hidden-file { display: none; }
    @media (max-width: 1050px) { .assessment-grid { grid-template-columns: 1fr; } .summary-grid { grid-template-columns: repeat(2,1fr); } }
  `],
})
export class AssessmentPageComponent {
  @ViewChild('fileInput') fileInput?: ElementRef<HTMLInputElement>

  claim$: Observable<ClaimCase>
  quoteColumns = ['version', 'batch', 'amount', 'reason']
  batch?: BaselineBatch
  workingItems: BatchSubmitItem[] = []
  quoteForms: Record<string, QuoteForm> = {}
  conflict?: BatchConflict
  uploadItemId = ''
  saving = false
  starting = false
  externalBusyId = ''
  simulateLostWrite = false

  constructor(
    private readonly store: Store<AppState>,
    private readonly service: ClaimsService,
    private readonly snackBar: MatSnackBar,
  ) {
    this.claim$ = this.store.select(selectSelectedClaim).pipe(
      tap((claim) => {
        if (!this.batch || this.batch.claimId !== claim.id) this.resetWorking(claim)
      }),
    )
  }

  private buildWorking(claim: ClaimCase): BatchSubmitItem[] {
    return claim.lossItems.map((item) => ({
      itemId: item.id,
      damage: item.damage,
      salvage: item.salvage,
      liability: item.liability,
      baseRevision: item.revision,
      quoteVersion: item.latestQuoteVersion,
      attachments: structuredClone(item.attachments),
    }))
  }

  private resetWorking(claim: ClaimCase) {
    this.batch = undefined
    this.workingItems = this.buildWorking(claim)
    this.quoteForms = {}
    this.conflict = undefined
    this.simulateLostWrite = false
  }

  startBaseline(claim: ClaimCase) {
    this.starting = true
    this.service.startBatch(claim.id).subscribe({
      next: ({ batch, claim: latestClaim }) => {
        this.batch = batch
        this.workingItems = this.buildWorking(latestClaim)
        this.quoteForms = {}
        this.conflict = undefined
        this.store.dispatch(updateClaim({ claim: latestClaim }))
        this.snackBar.open(`已取基线批次号 ${batch.batchNo}，报价和责任比例尚未修改`, '关闭', { duration: 2400 })
        this.starting = false
      },
      error: () => {
        this.starting = false
        this.snackBar.open('取批次号失败，请重试', '关闭', { duration: 2000 })
      },
    })
  }

  revisionLabel(item: LossItem, index: number) {
    const draft = this.workingItems[index]
    return draft ? `科目 V${draft.baseRevision} / 正式 V${item.revision}` : `正式 V${item.revision}`
  }

  isStale(item: LossItem, index: number) {
    return !!this.batch && this.workingItems[index]?.baseRevision !== item.revision
  }

  openQuoteForm(item: LossItem, index: number) {
    if (!this.batch) return
    const draft = this.workingItems[index]
    const base = this.batch.items.find((candidate) => candidate.itemId === item.id)
    this.quoteForms[item.id] = {
      open: true,
      amount: draft.newQuote?.amount ?? base?.quoteAmount ?? this.latestOfficialQuote(item),
      reason: draft.newQuote?.reason ?? '',
    }
  }

  cancelQuote(itemId: string) {
    const form = this.quoteForms[itemId]
    if (form) form.open = false
  }

  quoteReady(itemId: string) {
    const form = this.quoteForms[itemId]
    return !!form && form.open && !!form.reason.trim() && !!form.amount
  }

  applyQuote(item: LossItem, index: number) {
    const form = this.quoteForms[item.id]
    const draft = this.workingItems[index]
    if (!this.batch || !form || !draft || !form.reason.trim() || !form.amount) return
    draft.newQuote = {
      amount: Number(form.amount),
      reason: form.reason.trim(),
      operator: '当前用户',
      createdAt: nowText(),
      batchNo: this.batch.batchNo,
      requestId: this.batch.requestId,
    }
    form.open = false
  }

  latestOfficialQuote(item: LossItem) {
    return item.repairQuotes.at(-1)?.amount ?? 0
  }

  draftQuoteAmount(item: LossItem, index: number) {
    return this.workingItems[index]?.newQuote?.amount ?? this.latestOfficialQuote(item)
  }

  pendingAttachments(index: number) {
    return this.workingItems[index]?.attachments.filter((file) => file.id.startsWith('DRAFT-')) ?? []
  }

  prepareUpload(itemId: string) {
    if (!this.batch) return
    this.uploadItemId = itemId
    this.fileInput?.nativeElement.click()
  }

  onFileSelected(event: Event) {
    const input = event.target as HTMLInputElement
    const file = input.files?.[0]
    input.value = ''
    if (!file || !this.uploadItemId) return
    const index = this.workingItems.findIndex((item) => item.itemId === this.uploadItemId)
    const draft = this.workingItems[index]
    if (!draft) return
    const nextVersion = draft.attachments.reduce((max, item) => Math.max(max, item.version), 0) + 1
    const category: Attachment['category'] = file.name.includes('意见') ? '专家意见' : file.name.match(/jpg|png|jpeg/i) ? '现场照片' : '修复报告'
    draft.attachments.push({
      id: `DRAFT-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      name: file.name,
      category,
      version: nextVersion,
      uploadedBy: '当前用户',
      uploadedAt: nowText(),
    })
    this.snackBar.open('新附件仅保留在批次草稿，保存后才追加到正式证据', '关闭', { duration: 2200 })
  }

  draftReserve(claim: ClaimCase) {
    const draftClaim = {
      ...claim,
      lossItems: claim.lossItems.map((item, index) => {
        const draft = this.workingItems[index]
        const repairQuotes = draft?.newQuote
          ? [...item.repairQuotes, { version: draft.quoteVersion + 1, amount: draft.newQuote.amount, reason: draft.newQuote.reason, operator: draft.newQuote.operator, createdAt: draft.newQuote.createdAt }]
          : item.repairQuotes
        return { ...item, salvage: draft?.salvage ?? item.salvage, liability: draft?.liability ?? item.liability, repairQuotes }
      }),
    }
    return calculateReserve(draftClaim)
  }

  approvalSummary(claim: ClaimCase) {
    const invalid = claim.approvals.filter((step) => step.status === '已失效').length
    const passed = claim.approvals.filter((step) => step.status === '已通过').length
    return invalid ? `${passed} 通过 / ${invalid} 失效` : `${passed}/${claim.approvals.length} 通过`
  }

  disputedCount(claim: ClaimCase) {
    return claim.lossItems.filter((item) => item.disputed).length
  }

  simulateExternal(claim: ClaimCase, item: LossItem) {
    this.externalBusyId = item.id
    this.service.simulateExternalQuote(claim.id, item.id).subscribe({
      next: ({ claim: latestClaim, batchNo }) => {
        this.store.dispatch(updateClaim({ claim: latestClaim }))
        this.externalBusyId = ''
        this.snackBar.open(`并发批次 ${batchNo} 已先到；当前草稿保留，保存时将被拦截`, '关闭', { duration: 2800 })
      },
      error: () => {
        this.externalBusyId = ''
        this.snackBar.open('并发模拟失败', '关闭', { duration: 1800 })
      },
    })
  }

  saveBatch(claim: ClaimCase) {
    if (!this.batch || this.saving) return
    const body: BatchSaveRequest = {
      requestId: this.batch.requestId,
      baselineReserve: this.batch.baselineReserve,
      reserve: this.draftReserve(claim),
      items: structuredClone(this.workingItems),
      simulateLostWrite: this.simulateLostWrite,
    }
    this.saving = true
    this.service.commitBatch(claim.id, this.batch.batchNo, body).subscribe({
      next: (result) => {
        this.store.dispatch(updateClaim({ claim: result.claim }))
        this.batch = undefined
        this.conflict = undefined
        this.workingItems = this.buildWorking(result.claim)
        this.quoteForms = {}
        this.simulateLostWrite = false
        this.saving = false
        const retryText = result.duplicate ? '重试命中首次结果，未重复追加。' : result.invalidatedFromRole ? `已从「${result.invalidatedFromRole}」档位失效重签。` : '批次已写入。'
        this.snackBar.open(`${result.batchNo} 保存成功。${retryText}`, '关闭', { duration: 3000 })
      },
      error: (response) => {
        this.saving = false
        if (response?.error?.code === 'REVISION_CONFLICT') {
          this.conflict = response.error.conflict as BatchConflict
          this.snackBar.open('后到修改未放行，草稿已保留', '关闭', { duration: 2600 })
        } else {
          this.snackBar.open(response?.error?.message ?? '批次保存失败', '关闭', { duration: 2400 })
        }
      },
    })
  }

  rebaseDraft(claim: ClaimCase) {
    const oldBatch = this.batch
    const oldDrafts = structuredClone(this.workingItems)
    this.starting = true
    this.service.startBatch(claim.id).subscribe({
      next: ({ batch, claim: latestClaim }) => {
        const rebuilt = this.buildWorking(latestClaim)
        if (oldBatch) {
          oldDrafts.forEach((oldDraft) => {
            const target = rebuilt.find((item) => item.itemId === oldDraft.itemId)
            const oldBase = oldBatch.items.find((item) => item.itemId === oldDraft.itemId)
            if (!target || !oldBase) return
            if (oldDraft.damage !== oldBase.damage) target.damage = oldDraft.damage
            if (oldDraft.salvage !== oldBase.salvage) target.salvage = oldDraft.salvage
            if (oldDraft.liability !== oldBase.liability) target.liability = oldDraft.liability
            if (oldDraft.newQuote) target.newQuote = structuredClone(oldDraft.newQuote)
            const draftFiles = oldDraft.attachments
              .filter((file) => file.id.startsWith('DRAFT-'))
              .map((file, index) => ({
                ...file,
                id: `DRAFT-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 6)}`,
                version: target.attachments.length + index + 1,
              }))
            target.attachments.push(...draftFiles)
          })
        }
        this.batch = batch
        this.workingItems = rebuilt
        this.conflict = undefined
        this.store.dispatch(updateClaim({ claim: latestClaim }))
        this.starting = false
        this.snackBar.open(`已按最新版取 ${batch.batchNo}，本地草稿内容已保留`, '关闭', { duration: 2800 })
      },
    })
  }
}
