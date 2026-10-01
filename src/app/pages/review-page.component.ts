import { Component } from '@angular/core'
import { CommonModule, CurrencyPipe } from '@angular/common'
import { FormsModule } from '@angular/forms'
import { MatButtonModule } from '@angular/material/button'
import { MatCardModule } from '@angular/material/card'
import { MatFormFieldModule } from '@angular/material/form-field'
import { MatIconModule } from '@angular/material/icon'
import { MatInputModule } from '@angular/material/input'
import { MatSnackBar } from '@angular/material/snack-bar'
import { MatStepperModule } from '@angular/material/stepper'
import { Store } from '@ngrx/store'
import type { Observable } from 'rxjs'
import { ClaimsService } from '../core/claims.service'
import type { ClaimCase } from '../core/models'
import { selectSelectedClaim, updateClaim, type AppState } from '../core/claims.store'
import { StatusChipComponent } from '../shared/status-chip.component'

@Component({
  selector: 'app-review-page',
  standalone: true,
  imports: [CommonModule, CurrencyPipe, FormsModule, MatButtonModule, MatCardModule, MatFormFieldModule, MatIconModule, MatInputModule, MatStepperModule, StatusChipComponent],
  template: `
    <section class="page" *ngIf="claim$ | async as claim">
      <div class="page-head">
        <div>
          <p class="eyebrow">RESERVE APPROVAL / 准备金会签</p>
          <h1>基线版本绑定的多级会签</h1>
          <p class="muted">证据批次 {{ claim.batchNo }} / V{{ claim.batchVersion }}；旧结论失效后主管不能直接放行，必须从首个受影响档位重签。</p>
        </div>
        <span class="reserve">申请准备金 {{ claim.reserve | currency:'CNY':'symbol':'1.0-0' }}</span>
      </div>

      <div class="review-grid">
        <section class="panel">
          <div class="panel-head">
            <h3>会签流程</h3>
            <app-status-chip [label]="claim.status" [tone]="claim.status === '退回补件' || hasInvalid(claim) ? 'warn' : 'good'" />
          </div>
          <div class="invalidation-note" *ngIf="hasInvalid(claim)">
            <mat-icon>history_toggle_off</mat-icon>
            <div>
              <strong>已完成会签因新批次失效</strong>
              <p>{{ firstInvalidReason(claim) }}</p>
            </div>
          </div>
          <mat-stepper orientation="vertical" [linear]="false" class="approval-stepper">
            <mat-step *ngFor="let step of claim.approvals; let index = index" [completed]="step.status === '已通过'">
              <ng-template matStepLabel>
                <strong>{{ step.role }}</strong>
                <span class="threshold">触发阈值 {{ step.threshold | currency:'CNY':'symbol':'1.0-0' }}</span>
              </ng-template>
              <div class="step-body">
                <div class="step-status">
                  <app-status-chip [label]="step.status" [tone]="step.status === '已退回' || step.status === '已失效' ? 'warn' : step.status === '已通过' ? 'good' : 'default'" />
                  <small *ngIf="step.batchNo">绑定批次 {{ step.batchNo }}</small>
                </div>
                <p>{{ step.invalidatedReason || step.comment || (step.status === '待处理' ? '等待当前审核人处理。' : step.status + '。') }}</p>
                <small *ngIf="step.operator">{{ step.operator }} · {{ step.completedAt }}</small>
                <small *ngIf="step.invalidatedAt">失效时间 {{ step.invalidatedAt }}</small>
                <div class="step-actions" *ngIf="canDecide(claim, index)">
                  <mat-form-field appearance="outline" subscriptSizing="dynamic"><mat-label>重签/审批意见</mat-label><input matInput [(ngModel)]="comments[index]" /></mat-form-field>
                  <button mat-flat-button color="primary" [disabled]="!comments[index]?.trim()" (click)="decide(claim.id, step.role, '已通过', index)">通过</button>
                  <button mat-stroked-button color="warn" [disabled]="!comments[index]?.trim()" (click)="decide(claim.id, step.role, '退回补件', index)">退回补件</button>
                </div>
                <p class="locked" *ngIf="!canDecide(claim, index) && step.status !== '已通过'">等待首个受影响或前置档位处理。</p>
              </div>
            </mat-step>
          </mat-stepper>
        </section>

        <aside>
          <section class="panel">
            <div class="panel-head"><h3>赔付方案对比</h3><span class="muted">当前批次自动试算</span></div>
            <div class="plans">
              <mat-card appearance="outlined">
                <span>方案 A · 现状评估</span>
                <strong>{{ planA(claim) | currency:'CNY':'symbol':'1.0-0' }}</strong>
                <p>采用当前正式报价，所有结论与 {{ claim.batchNo }} 的附件版本绑定。</p>
              </mat-card>
              <mat-card appearance="outlined" class="recommended">
                <span>方案 B · 核减待证部分</span>
                <strong>{{ planB(claim) | currency:'CNY':'symbol':'1.0-0' }}</strong>
                <p>暂扣第三方复测与库龄核减争议金额；变更后同样生成新批次并重签。</p>
              </mat-card>
            </div>
          </section>

          <section class="panel">
            <div class="panel-head"><h3>争议项定位</h3><span class="muted">{{ disputedCount(claim) }} 项</span></div>
            <div class="disputes">
              <div *ngFor="let item of claim.lossItems" [class.disputed]="item.disputed">
                <mat-icon>{{ item.disputed ? 'report_problem' : 'check_circle' }}</mat-icon>
                <div><strong>{{ item.category }} · {{ item.description }}</strong><p>科目 V{{ item.revision }} · 报价 V{{ item.latestQuoteVersion }} · 证据 V{{ item.evidenceVersion }}</p></div>
              </div>
            </div>
          </section>
        </aside>
      </div>
    </section>
  `,
  styles: [`
    .reserve { padding: 10px 14px; border-left: 3px solid #2f8191; background: #eaf4f5; color: #175866; font-weight: 800; }
    .invalidation-note { display: flex; gap: 10px; margin: 14px 16px 0; padding: 12px; border: 1px solid #d57a43; border-left-width: 4px; border-radius: 8px; color: #904018; background: #fff4ec; }
    .invalidation-note p { margin: 4px 0 0; color: #775340; font-size: 12px; line-height: 1.5; }
    .review-grid { display: grid; grid-template-columns: minmax(0,1fr) 360px; gap: 14px; align-items: start; }
    .approval-stepper { padding: 18px 22px 22px 8px; background: transparent; }
    mat-step strong, mat-step .threshold { display: block; }
    .threshold { margin-top: 3px; color: #78858d; font-size: 10px; }
    .step-body { padding: 4px 0 16px; }
    .step-body p { margin: 0 0 6px; color: #58666f; }
    .step-body small { display: block; color: #869198; }
    .step-status { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 8px; }
    .step-actions { display: flex; align-items: center; gap: 8px; margin-top: 12px; flex-wrap: wrap; }
    .step-actions mat-form-field { flex: 1; min-width: 240px; }
    .locked { color: #98a1a8 !important; font-size: 11px; }
    aside { display: grid; gap: 14px; }
    .plans { display: grid; gap: 10px; padding: 14px; }
    .plans mat-card { padding: 14px; }
    .plans .recommended { border-color: #39828b; background: #f0f8f8; }
    .plans span, .plans p { display: block; color: #69767e; font-size: 12px; }
    .plans strong { display: block; margin: 7px 0; color: #184855; font-size: 22px; }
    .disputes { padding: 6px 14px 14px; }
    .disputes > div { display: flex; gap: 9px; padding: 10px 0; border-bottom: 1px solid #edf0f2; color: #437360; }
    .disputes > div.disputed { color: #b55a2e; }
    .disputes strong { font-size: 12px; }
    .disputes p { margin: 5px 0 0; color: #6d7981; font-size: 11px; line-height: 1.5; }
    @media (max-width: 1050px) { .review-grid { grid-template-columns: 1fr; } }
  `],
})
export class ReviewPageComponent {
  claim$: Observable<ClaimCase>
  comments: Record<number, string> = {}

  constructor(
    private readonly store: Store<AppState>,
    private readonly service: ClaimsService,
    private readonly snackBar: MatSnackBar,
  ) {
    this.claim$ = this.store.select(selectSelectedClaim)
  }

  planA(claim: ClaimCase) {
    return claim.lossItems.reduce((sum, item) => sum + Math.max(0, (item.repairQuotes.at(-1)?.amount ?? 0) - item.salvage) * item.liability, 0) - claim.deductible
  }

  planB(claim: ClaimCase) {
    return this.planA(claim) - claim.lossItems.filter((item) => item.disputed).length * 72000
  }

  disputedCount(claim: ClaimCase) {
    return claim.lossItems.filter((item) => item.disputed).length
  }

  hasInvalid(claim: ClaimCase) {
    return claim.approvals.some((step) => step.status === '已失效')
  }

  firstInvalidReason(claim: ClaimCase) {
    return claim.approvals.find((step) => step.status === '已失效')?.invalidatedReason ?? '损失科目、报价或附件版本已变化，请重签。'
  }

  canDecide(claim: ClaimCase, index: number) {
    const priorBlocked = claim.approvals.slice(0, index).some((step) => step.status === '待处理' || step.status === '已退回' || step.status === '已失效')
    return !priorBlocked && (claim.approvals[index].status === '待处理' || claim.approvals[index].status === '已失效')
  }

  decide(claimId: string, role: string, result: string, index: number) {
    const comment = this.comments[index]?.trim()
    if (!comment) return
    this.service.approve(claimId, { role, result, comment }).subscribe({
      next: (claim) => {
        this.store.dispatch(updateClaim({ claim }))
        this.snackBar.open(result === '已通过' ? '当前档位已重签通过' : '案件已退回补件，原始记录未修改', '关闭', { duration: 2200 })
        this.comments[index] = ''
      },
      error: (response) => this.snackBar.open(response?.error?.message ?? '会签失败', '关闭', { duration: 2200 }),
    })
  }
}
