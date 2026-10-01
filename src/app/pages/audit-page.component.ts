import { Component } from '@angular/core'
import { CommonModule } from '@angular/common'
import { MatButtonModule } from '@angular/material/button'
import { MatCardModule } from '@angular/material/card'
import { MatIconModule } from '@angular/material/icon'
import { MatSnackBar } from '@angular/material/snack-bar'
import { Store } from '@ngrx/store'
import type { Observable } from 'rxjs'
import type { ClaimCase } from '../core/models'
import { selectSelectedClaim, saveDraft, type AppState } from '../core/claims.store'
import { StatusChipComponent } from '../shared/status-chip.component'

@Component({
  selector: 'app-audit-page',
  standalone: true,
  imports: [CommonModule, MatButtonModule, MatCardModule, MatIconModule, StatusChipComponent],
  template: `
    <section class="page" *ngIf="claim$ | async as claim">
      <div class="page-head">
        <div>
          <p class="eyebrow">AUDIT & EVIDENCE / 审计与证据</p>
          <h1>附件版本与操作时间线</h1>
          <p class="muted">报价调整、专家意见和审批动作全部保留在不可覆盖的审计记录中。</p>
        </div>
        <div class="actions">
          <button mat-stroked-button (click)="restoreDraft()"><mat-icon>restore</mat-icon> 恢复未提交草稿</button>
          <button mat-flat-button color="primary" (click)="exportAudit(claim)"><mat-icon>download</mat-icon> 导出审计包</button>
        </div>
      </div>

      <div class="audit-grid">
        <section class="panel">
          <div class="panel-head"><h3>案件操作时间线</h3><span class="muted">{{ claim.audit.length }} 条记录</span></div>
          <div class="timeline">
            <article *ngFor="let event of claim.audit.slice().reverse(); let first = first">
              <div class="time">{{ event.at }}</div>
              <div class="rail"><i></i><b *ngIf="!first"></b></div>
              <div class="event">
                <strong>{{ event.action }}</strong>
                <p>{{ event.detail }}</p>
                <small>{{ event.operator }} · 记录编号 {{ event.id }}</small>
              </div>
            </article>
          </div>
        </section>

        <aside>
          <section class="panel">
            <div class="panel-head"><h3>基线批次</h3><span class="muted">提交时连科目/准备金/附件/会签一起</span></div>
            <div class="batch-list">
              <article *ngFor="let batch of (claim.batches ?? []).slice().reverse()">
                <div class="batch-head">
                  <mat-icon>inventory_2</mat-icon>
                  <strong>{{ batch.batchNo }}</strong>
                  <app-status-chip [label]="batch.status" [tone]="batch.status === '已提交' ? 'good' : 'default'" />
                  <small>V{{ batch.version }} · {{ batch.createdBy }} · {{ batch.createdAt }}</small>
                </div>
                <ul class="batch-changes" *ngIf="batch.changes.length">
                  <li *ngFor="let change of batch.changes">{{ change }}</li>
                </ul>
                <p class="batch-empty" *ngIf="batch.changes.length === 0">初始基线版本，原记录保留可查。</p>
                <p class="batch-invalidated" *ngIf="batch.invalidatedApprovals.length">
                  <mat-icon>warning</mat-icon> 失效会签档位：{{ batch.invalidatedApprovals.join('、') }}（从首个受影响档位重签）
                </p>
              </article>
              <p class="batch-empty" *ngIf="(claim.batches ?? []).length === 0">旧数据无批次号，保存时补初始版本。</p>
            </div>
          </section>

          <section class="panel">
            <div class="panel-head"><h3>附件版本</h3><span class="muted">只增不删</span></div>
            <div class="file-list">
              <div *ngFor="let item of claim.lossItems">
                <strong>{{ item.category }}</strong>
                <article *ngFor="let file of item.attachments">
                  <mat-icon>{{ file.category === '现场照片' ? 'photo_camera' : 'description' }}</mat-icon>
                  <div><span>{{ file.name }}</span><small>V{{ file.version }} · {{ file.uploadedBy }} · {{ file.uploadedAt }}</small></div>
                  <app-status-chip [label]="file.category" />
                </article>
                <small *ngIf="item.attachments.length === 0">暂无附件</small>
              </div>
            </div>
          </section>

          <mat-card appearance="outlined" class="draft-card">
            <div><mat-icon>cloud_sync</mat-icon><strong>未提交编辑可恢复</strong></div>
            <p>草稿写入口会同时保存到浏览器本地，不覆盖案件正式版本。</p>
            <button mat-stroked-button (click)="saveNewDraft()">模拟保存新草稿</button>
          </mat-card>
        </aside>
      </div>
    </section>
  `,
  styles: [`
    .audit-grid { display: grid; grid-template-columns: minmax(0,1fr) 380px; gap: 14px; align-items: start; }
    .timeline { padding: 18px 20px; }
    .timeline article { display: grid; grid-template-columns: 72px 22px minmax(0,1fr); }
    .time { padding-top: 2px; color: #66757e; font-family: monospace; font-size: 11px; text-align: right; }
    .rail { position: relative; }
    .rail i { position: absolute; z-index: 2; top: 3px; left: 7px; width: 8px; height: 8px; border: 2px solid #fff; border-radius: 50%; background: #2c7f89; box-shadow: 0 0 0 1px #2c7f89; }
    .rail b { position: absolute; top: 11px; bottom: -2px; left: 10px; width: 1px; background: #ccd8dc; }
    .event { padding: 0 0 22px 8px; }
    .event strong { font-size: 13px; }
    .event p { margin: 6px 0; color: #56656e; font-size: 12px; line-height: 1.55; }
    .event small { color: #89949b; font-size: 10px; }
    aside { display: grid; gap: 14px; }
    .file-list { padding: 8px 14px 16px; }
    .file-list > div { padding: 10px 0; border-bottom: 1px solid #edf0f2; }
    .file-list article { display: grid; grid-template-columns: 28px minmax(0,1fr) auto; gap: 8px; align-items: center; padding: 8px; margin-top: 6px; background: #f5f7f7; border-radius: 6px; }
    .file-list article span, .file-list article small { display: block; }
    .file-list article span { font-size: 12px; }
    .file-list article small { margin-top: 3px; color: #7b878f; font-size: 10px; }
    .draft-card { padding: 16px; }
    .draft-card > div { display: flex; align-items: center; gap: 8px; }
    .draft-card p { margin: 9px 0 12px; color: #69767f; font-size: 12px; line-height: 1.55; }
    .batch-list { display: grid; gap: 10px; padding: 12px 14px 16px; }
    .batch-list article { padding: 10px 12px; background: #f5f7f7; border: 1px solid #e3ebed; border-radius: 7px; }
    .batch-head { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
    .batch-head mat-icon { font-size: 16px; width: 16px; height: 16px; color: #2c7f89; }
    .batch-head strong { font-size: 13px; }
    .batch-head small { color: #8b969d; font-size: 10px; }
    .batch-changes { margin: 8px 0 0; padding: 0; list-style: none; }
    .batch-changes li { position: relative; padding: 3px 0 3px 12px; color: #56656e; font-size: 11px; line-height: 1.5; }
    .batch-changes li::before { content: ''; position: absolute; left: 0; top: 9px; width: 4px; height: 4px; border-radius: 50%; background: #2c7f89; }
    .batch-invalidated { display: flex; gap: 5px; align-items: flex-start; margin: 8px 0 0; color: #984313; font-size: 11px; }
    .batch-invalidated mat-icon { font-size: 14px; width: 14px; height: 14px; }
    .batch-empty { margin: 6px 0 0; color: #8b969d; font-size: 11px; }
    @media (max-width: 1050px) { .audit-grid { grid-template-columns: 1fr; } }
  `],
})
export class AuditPageComponent {
  claim$: Observable<ClaimCase>

  constructor(
    private readonly store: Store<AppState>,
    private readonly snackBar: MatSnackBar,
  ) {
    this.claim$ = this.store.select(selectSelectedClaim)
  }

  restoreDraft() {
    const draft = localStorage.getItem('claims-assessment-draft') ?? '待补充房屋檩条第三方复测依据。'
    this.store.dispatch(saveDraft({ draft }))
    this.snackBar.open('已恢复本地未提交草稿', '关闭', { duration: 1800 })
  }

  saveNewDraft() {
    this.store.dispatch(saveDraft({ draft: `草稿更新于 ${new Date().toLocaleString('zh-CN')}` }))
  }

  exportAudit(claim: any) {
    const lines = ['时间,操作者,动作,说明', ...claim.audit.map((event: any) => [event.at, event.operator, event.action, event.detail].map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(','))]
    const url = URL.createObjectURL(new Blob([`\uFEFF${lines.join('\n')}`], { type: 'text/csv;charset=utf-8' }))
    const link = document.createElement('a')
    link.href = url
    link.download = `${claim.id}-审计记录.csv`
    link.click()
    URL.revokeObjectURL(url)
    this.snackBar.open('审计包已导出', '关闭', { duration: 1600 })
  }
}
