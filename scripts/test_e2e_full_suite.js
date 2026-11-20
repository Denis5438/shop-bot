/**
 * scripts/test_e2e_full_suite.js
 *
 * Unified End-to-End Test Suite Runner for Shop Bot Audit Fixes
 * Executes all milestone test suites and regression suites:
 * 1. Financial & Payments Hardening (Tasks 1, 2, 14, 15, 16, 17, 18)
 * 2. Core Platform, Sessions, Security & RBAC (Tasks 3, 4, 5, 19, 20, 21, 23)
 * 3. Catalog, Dropshipping, Pre-orders & Crons (Tasks 6, 7, 8, 9, 10, 11, 12, 13, 22)
 * 4. Regression: Topup Bybit UID Suite
 * 5. Regression: Cart, Orders & Refunds Hardening Suite
 *
 * Verifies 100% passing results across all 23 audit tasks and regression requirements.
 */

'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

const SUITES = [
  {
    id: 'M1',
    name: 'Milestone 1: Financial & Payments Hardening',
    script: 'scripts/test_financial_hardening.js',
    tasks: [
      { id: 'Task 1', code: 'SEC-FIN-04, 05', desc: 'Platega SBP Webhook Validation & Invalidation' },
      { id: 'Task 2', code: 'SEC-FIN-08', desc: 'IEEE 754 Floating Point Rounding (roundMoney)' },
      { id: 'Task 14', code: 'SEC-FIN-11', desc: 'CAS Lock on Seller Withdrawal Requests' },
      { id: 'Task 15', code: 'SEC-FIN-12, 16', desc: 'Dispute Resolution Transaction Audit Records' },
      { id: 'Task 16', code: 'SEC-FIN-13', desc: 'Explicit topupRequestId in Manual Top-up' },
      { id: 'Task 17', code: 'SEC-FIN-14', desc: 'Graceful CAS Fallback for Transactions' },
      { id: 'Task 18', code: 'SEC-FIN-17', desc: 'Legacy Bybit UID USDT Filter & Deduplication' },
    ],
  },
  {
    id: 'M2',
    name: 'Milestone 2: Core Platform, Sessions, Security & RBAC',
    script: 'scripts/test_core_security_rbac.js',
    tasks: [
      { id: 'Task 3', code: 'SEC-CORE-02', desc: 'Persistent Telegraf Sessions (MongoDB TTL 7d)' },
      { id: 'Task 4', code: 'SEC-CORE-03', desc: 'Polymorphic User Cache Synchronization' },
      { id: 'Task 5', code: 'SEC-CORE-04', desc: 'Superadmin RBAC Hierarchy & Revocation' },
      { id: 'Task 19', code: 'SEC-CORE-05', desc: 'Split RequiredChannel into ChannelVerification' },
      { id: 'Task 20', code: 'SEC-CORE-06', desc: 'Secret Encryption with Safe Getters/Setters' },
      { id: 'Task 21', code: 'SEC-CORE-07', desc: 'Two-Step ToS Reset Confirmation Dialog' },
      { id: 'Task 23', code: 'SEC-CORE-09, CAT-08', desc: 'MongoDB Partial Unique Indexes & Sync' },
    ],
  },
  {
    id: 'M3',
    name: 'Milestone 3: Catalog, Dropshipping, Pre-orders & Crons',
    script: 'scripts/test_catalog_dropship_crons.js',
    tasks: [
      { id: 'Task 6', code: 'SEC-CAT-01', desc: 'Manual Stock Leak Prevention on Pre-Order Cancel' },
      { id: 'Task 7', code: 'SEC-CAT-04', desc: 'Anti-Sybil Referral Order Threshold ($3.00)' },
      { id: 'Task 8', code: 'SEC-DROP-03', desc: 'Exponential Backoff (5 retries) & DLQ Auto-Refund' },
      { id: 'Task 9', code: 'SEC-DROP-04', desc: 'Idempotency & External Status Check on Timeout' },
      { id: 'Task 10', code: 'SEC-CAT-05', desc: 'Keyset Pagination (100-batch) in Referral Reconcile' },
      { id: 'Task 11', code: 'SEC-CAT-06', desc: 'Zero-Division & Sanity Protection in Smart Markdown' },
      { id: 'Task 12', code: 'SEC-DROP-06', desc: 'Preserve Custom Supplier Margins on Key Update' },
      { id: 'Task 13', code: 'SEC-DROP-07', desc: 'Dropshipping Pre-orders Auto-Purchase (Jaha)' },
      { id: 'Task 22', code: 'SEC-CAT-07', desc: 'Waitlist Cleanup on Pre-Order Cancellation' },
    ],
  },
  {
    id: 'REG-BYBIT',
    name: 'Regression: Bybit UID Top-up System',
    script: 'scripts/test_topup_bybit_uid.js',
    tasks: [
      { id: 'REG-1', code: 'BYBIT-TOPUP', desc: 'Topup Bybit UID Invoicing & Polling' },
    ],
  },
  {
    id: 'REG-CART',
    name: 'Regression: Cart, Orders & Refunds Hardening',
    script: 'scripts/test_milestone_4_cart_orders_refunds.js',
    tasks: [
      { id: 'REG-2', code: 'CART-ORDERS-REFUNDS', desc: 'Multi-Key Refunds, Wholesale Floor, Seller Payout' },
    ],
  },
];

function runSuite(suite) {
  const scriptPath = path.resolve(process.cwd(), suite.script);
  console.log('\n================================================================================');
  console.log(`▶ EXECUTING: [${suite.id}] ${suite.name}`);
  console.log(`  Script: ${suite.script}`);
  console.log('================================================================================\n');

  const startTime = Date.now();
  const res = spawnSync(process.execPath, [scriptPath], {
    stdio: 'inherit',
    cwd: process.cwd(),
    env: { ...process.env, NODE_ENV: 'test' },
  });
  const duration = ((Date.now() - startTime) / 1000).toFixed(2);

  const passed = res.status === 0;
  return {
    ...suite,
    status: passed ? 'PASSED' : 'FAILED',
    exitCode: res.status,
    duration,
  };
}

function main() {
  console.log('╔══════════════════════════════════════════════════════════════════════════════╗');
  console.log('║               SHOP BOT AUDIT FIXES — UNIFIED E2E TEST RUNNER                 ║');
  console.log('║                    23 Audit Tasks + 2 Regression Suites                      ║');
  console.log('╚══════════════════════════════════════════════════════════════════════════════╝');

  const suiteResults = [];
  const overallStart = Date.now();

  for (const suite of SUITES) {
    const result = runSuite(suite);
    suiteResults.push(result);
    if (result.status !== 'PASSED') {
      console.error(`\n❌ [ABORT] Suite failed: ${suite.name} (exit code ${result.exitCode})`);
      break;
    }
  }

  const overallDuration = ((Date.now() - overallStart) / 1000).toFixed(2);

  // Print Summary Table
  console.log('\n\n================================================================================');
  console.log('                              EXECUTION SUMMARY                                 ');
  console.log('================================================================================');

  let allSuitesPassed = true;
  for (const s of suiteResults) {
    const symbol = s.status === 'PASSED' ? '✅' : '❌';
    console.log(` ${symbol} [${s.status}] ${s.id.padEnd(10)} ${s.name.padEnd(48)} (${s.duration}s)`);
    if (s.status !== 'PASSED') allSuitesPassed = false;
  }

  console.log('--------------------------------------------------------------------------------');

  // Print Task Matrix
  console.log('\n================================================================================');
  console.log('                   AUDIT ITEMS & REGRESSION COVERAGE MATRIX                     ');
  console.log('================================================================================');

  let totalTasks = 0;
  let passedTasks = 0;

  for (const s of SUITES) {
    const isSuitePassed = suiteResults.find((r) => r.id === s.id && r.status === 'PASSED');
    for (const t of s.tasks) {
      totalTasks++;
      const statusStr = isSuitePassed ? '✅ PASS' : '❌ FAIL';
      if (isSuitePassed) passedTasks++;
      console.log(` ${statusStr} | ${t.id.padEnd(10)} | ${t.code.padEnd(20)} | ${t.desc}`);
    }
  }

  console.log('================================================================================');
  console.log(`Total Suites:   ${suiteResults.length} / ${SUITES.length}`);
  console.log(`Total Tasks:    ${passedTasks} / ${totalTasks} Passed (${((passedTasks / totalTasks) * 100).toFixed(0)}%)`);
  console.log(`Total Duration: ${overallDuration}s`);
  console.log('================================================================================');

  if (allSuitesPassed && passedTasks === totalTasks) {
    console.log('\n🎉 ALL 23 AUDIT TASKS AND REGRESSION SUITES PASSED WITH 100% SUCCESS! 🚀\n');
    process.exit(0);
  } else {
    console.error('\n❌ TEST SUITE RUNNER ENCOUNTERED FAILURES.\n');
    process.exit(1);
  }
}

main();
