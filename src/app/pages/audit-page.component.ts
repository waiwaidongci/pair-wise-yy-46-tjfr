import { Component } from '@angular/core'
import { CommonModule } from '@angular/common'
import { FormsModule } from '@angular/forms'
import { MatButtonModule } from '@angular/material/button'
import { MatCardModule } from '@angular/material/card'
import { MatFormFieldModule } from '@angular/material/form-field'
import { MatIconModule } from '@angular/material/icon'
import { MatInputModule } from '@angular/material/input'
import { MatSnackBar } from '@angular/material/snack-bar'
import { Store } from '@ngrx/store'
import type { Observable } from 'rxjs'
import { ClaimsService } from '../core/claims.service'
import type { BatchHistoryEntry, ClaimCase } from '../core/models'
import { selectSelectedClaim, saveDraft, type AppState } from '../core/claims.store'
import { StatusChipComponent } from '../shared/status-chip.component'

@Component({
  selector: 'app-audit-page',
  standalone: true,
  imports: [CommonModule, FormsModule, MatButtonModule, MatCardModule, MatFormFieldModule, MatIconModule, MatInputModule, StatusChipComponent],
  template: `
    <section class="page" *ngIf="claim$ | async as claim">
      <div class="page-head">
        <div>
          <p class="eyebrow">AUDIT & EVIDENCE / 批次审计与证据</p>
          <h1>附件版本、会签批次与原始记录</h1>
          <p class="muted">旧数据补登为 INI 初始版本；每次报价、责任比例或附件变更都以批次号串联审计、准备金和会签。</p>
        </div>
        <div class="actions">
          <button mat-stroked-button (click)="restoreDraft()"><mat-icon>restore</mat-icon> 恢复未提交草稿</button>
          <button mat-flat-button color="primary" (click)="exportAudit(claim)"><mat-icon>download</mat-icon> 导出审计包</button>
        </div>
      </div>

      <div class="audit-grid">
        <section class="panel">
          <div class="panel-head"><h3>案件操作时间线</h3><span class="muted">{{ claim.audit.length }} 条只增记录</span></div>
          <div class="timeline">
            <article *ngFor="let event of claim.audit.slice().reverse(); let first = first">
              <div class="time">{{ event.at }}</div>
              <div class="rail"><i></i><b *ngIf="!first"></b></div>
              <div class="event">
                <strong>{{ event.action }}</strong>
                <p>{{ event.detail }}</p>
                <small>{{ event.operator }} · {{ event.id }} · {{ event.batchNo || claim.batchNo }}</small>
              </div>
            </article>
          </div>
        </section>

        <aside>
          <section class="panel batch-history">
            <div class="panel-head"><h3>批次归档</h3><span class="muted">{{ claim.batchHistory.length }} 个版本</span></div>
            <button class="history-item" *ngFor="let entry of claim.batchHistory.slice().reverse()" (click)="loadBatch(claim.id, entry.batchNo)">
              <span>
                <strong>{{ entry.batchNo }}</strong>
                <small>{{ entry.committedAt }} · {{ entry.operator }}</small>
              </span>
              <mat-icon>search</mat-icon>
            </button>
            <div class="batch-lookup">
              <mat-form-field appearance="outline" subscriptSizing="dynamic">
                <mat-label>按批次号查原记录</mat-label>
                <input matInput [(ngModel)]="lookupBatchNo" placeholder="例如 INI-CLM-2026-0918" />
              </mat-form-field>
              <button mat-stroked-button (click)="loadBatch(claim.id, lookupBatchNo)">查询</button>
            </div>
          </section>

          <mat-card appearance="outlined" class="snapshot-card" *ngIf="selectedEntry as entry">
            <div><mat-icon>inventory_2</mat-icon><strong>{{ entry.batchNo }}</strong></div>
            <p>{{ entry.source === 'legacy' ? '旧数据补登的初始版本，原始审计和附件仍可查。' : '批次保存前的完整快照，可核对当时科目、准备金、附件和会签。' }}</p>
            <dl>
              <div><dt>提交时间</dt><dd>{{ entry.committedAt }}</dd></div>
              <div><dt>前一批次</dt><dd>{{ entry.previousBatchNo }}</dd></div>
              <div><dt>准备金</dt><dd>{{ entry.reserveBefore }} → {{ entry.reserveAfter }}</dd></div>
              <div><dt>变更科目</dt><dd>{{ entry.changedItemIds.length ? entry.changedItemIds.join('、') : '初始版本' }}</dd></div>
              <div><dt>重签档位</dt><dd>{{ entry.invalidatedFromRole || '无' }}</dd></div>
              <div><dt>附件数量</dt><dd>{{ entry.attachmentIds.length }} 个</dd></div>
              <div><dt>请求编号</dt><dd>{{ entry.requestId }}</dd></div>
            </dl>
            <ng-container *ngIf="entry.snapshot as oldClaim">
              <h4>原记录速览</h4>
              <ul>
                <li *ngFor="let item of oldClaim.lossItems">{{ item.category }}：科目 V{{ item.revision }}，报价 V{{ item.latestQuoteVersion }}，证据 V{{ item.evidenceVersion }}</li>
              </ul>
            </ng-container>
          </mat-card>

          <section class="panel">
            <div class="panel-head"><h3>附件版本</h3><span class="muted">只增不删</span></div>
            <div class="file-list">
              <div *ngFor="let item of claim.lossItems">
                <strong>{{ item.category }} · V{{ item.evidenceVersion }}</strong>
                <article *ngFor="let file of item.attachments">
                  <mat-icon>{{ file.category === '现场照片' ? 'photo_camera' : 'description' }}</mat-icon>
                  <div><span>{{ file.name }}</span><small>V{{ file.version }} · {{ file.uploadedBy }} · {{ file.uploadedAt }}</small></div>
                  <app-status-chip [label]="file.category" />
                </article>
                <small *ngIf="item.attachments.length === 0">暂无附件</small>
              </div>
            </div>
          </section>
        </aside>
      </div>
    </section>
  `,
  styles: [`
    .audit-grid { display: grid; grid-template-columns: minmax(0,1fr) 390px; gap: 14px; align-items: start; }
    .timeline { padding: 18px 20px; }
    .timeline article { display: grid; grid-template-columns: 82px 22px minmax(0,1fr); }
    .time { padding-top: 2px; color: #66757e; font-family: monospace; font-size: 11px; text-align: right; }
    .rail { position: relative; }
    .rail i { position: absolute; z-index: 2; top: 3px; left: 7px; width: 8px; height: 8px; border: 2px solid #fff; border-radius: 50%; background: #2c7f89; box-shadow: 0 0 0 1px #2c7f89; }
    .rail b { position: absolute; top: 11px; bottom: -2px; left: 10px; width: 1px; background: #ccd8dc; }
    .event { padding: 0 0 22px 8px; }
    .event strong { font-size: 13px; }
    .event p { margin: 6px 0; color: #56656e; font-size: 12px; line-height: 1.55; }
    .event small { color: #89949b; font-size: 10px; }
    aside { display: grid; gap: 14px; }
    .history-item { display: flex; align-items: center; justify-content: space-between; width: calc(100% - 24px); margin: 8px 12px 0; padding: 10px; border: 1px solid #e2e8eb; border-radius: 7px; background: #fafcfc; text-align: left; cursor: pointer; }
    .history-item strong, .history-item small { display: block; }
    .history-item small { margin-top: 3px; color: #7d8991; font-size: 10px; }
    .batch-lookup { display: flex; gap: 8px; align-items: center; padding: 12px; }
    .batch-lookup mat-form-field { flex: 1; }
    .snapshot-card { padding: 16px; }
    .snapshot-card > div:first-child { display: flex; align-items: center; gap: 8px; }
    .snapshot-card p { margin: 9px 0 12px; color: #69767f; font-size: 12px; line-height: 1.55; }
    .snapshot-card dl { display: grid; gap: 7px; margin: 0; }
    .snapshot-card dl div { display: grid; grid-template-columns: 76px 1fr; gap: 8px; font-size: 12px; }
    .snapshot-card dt { color: #7a868e; }
    .snapshot-card dd { margin: 0; color: #244653; word-break: break-all; }
    .snapshot-card h4 { margin: 14px 0 7px; font-size: 13px; }
    .snapshot-card ul { margin: 0; padding-left: 18px; color: #5e6b73; font-size: 11px; line-height: 1.7; }
    .file-list { padding: 8px 14px 16px; }
    .file-list > div { padding: 10px 0; border-bottom: 1px solid #edf0f2; }
    .file-list article { display: grid; grid-template-columns: 28px minmax(0,1fr) auto; gap: 8px; align-items: center; padding: 8px; margin-top: 6px; background: #f5f7f7; border-radius: 6px; }
    .file-list article span, .file-list article small { display: block; }
    .file-list article span { font-size: 12px; }
    .file-list article small { margin-top: 3px; color: #7b878f; font-size: 10px; }
    @media (max-width: 1050px) { .audit-grid { grid-template-columns: 1fr; } }
  `],
})
export class AuditPageComponent {
  claim$: Observable<ClaimCase>
  lookupBatchNo = ''
  selectedEntry?: BatchHistoryEntry

  constructor(
    private readonly store: Store<AppState>,
    private readonly service: ClaimsService,
    private readonly snackBar: MatSnackBar,
  ) {
    this.claim$ = this.store.select(selectSelectedClaim)
  }

  restoreDraft() {
    const draft = localStorage.getItem('claims-assessment-draft') ?? '待补充房屋檩条第三方复测依据。'
    this.store.dispatch(saveDraft({ draft }))
    this.snackBar.open('已恢复本地未提交草稿', '关闭', { duration: 1800 })
  }

  loadBatch(claimId: string, batchNo: string) {
    const normalized = batchNo.trim()
    if (!normalized) return
    this.service.getBatch(claimId, normalized).subscribe({
      next: (result) => {
        this.selectedEntry = result.entry
        this.lookupBatchNo = normalized
      },
      error: () => this.snackBar.open('未找到该批次或原始记录', '关闭', { duration: 2000 }),
    })
  }

  exportAudit(claim: ClaimCase) {
    const rows = [
      '时间,批次,操作者,动作,说明',
      ...claim.audit.map((event) => [event.at, event.batchNo ?? claim.batchNo, event.operator, event.action, event.detail].map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(',')),
      '',
      '批次,提交时间,前批次,准备金前,准备金后,变更科目,重签档位,请求编号',
      ...claim.batchHistory.map((entry) => [entry.batchNo, entry.committedAt, entry.previousBatchNo, entry.reserveBefore, entry.reserveAfter, entry.changedItemIds.join(';'), entry.invalidatedFromRole ?? '', entry.requestId].map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(',')),
    ]
    const url = URL.createObjectURL(new Blob([`﻿${rows.join('\n')}`], { type: 'text/csv;charset=utf-8' }))
    const link = document.createElement('a')
    link.href = url
    link.download = `${claim.id}-${claim.batchNo}-审计记录.csv`
    link.click()
    URL.revokeObjectURL(url)
    this.snackBar.open('审计包已导出', '关闭', { duration: 1600 })
  }
}
