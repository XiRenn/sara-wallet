/**
 * `@wallet/shared` — the single source of truth for both clients.
 *
 * Everything the Expo app and the Electron app need lives behind this barrel:
 * the configured Supabase client, the typed services, the React hooks and the
 * formatting utilities.
 *
 * The package is consumed as **TypeScript source** (`main` points at
 * `index.ts`). Metro compiles it for React Native and Vite compiles it for the
 * Electron renderer, so there is no build step and no risk of a stale `dist/`
 * silently diverging from the source.
 */

/* ── Database + domain types ─────────────────────────────────────────────── */
export type {
  Database,
  DebtBalanceRow,
  DebtDirection,
  DebtInsert,
  DebtRow,
  DebtUpdate,
  Enums,
  Json,
  Tables,
  TablesInsert,
  TablesUpdate,
  TransactionInsert,
  TransactionRow,
  TransactionType,
  TransactionUpdate,
  Views,
  WalletInsert,
  WalletRow,
  WalletUpdate,
} from './src/types/database';

export {
  isTransactionType,
  normaliseWallet,
  SUPPORTED_CURRENCIES,
  toNumber,
} from './src/types/wallet';

export type {
  CreateWalletInput,
  CurrencyCode,
  ListWalletsOptions,
  SupportedCurrency,
  UpdateWalletInput,
  Wallet,
  WalletTotals,
  WalletWithActivity,
} from './src/types/wallet';

export type {
  AppUser,
  AuthEvent,
  AuthSession,
  AuthStateChangeHandler,
  AuthStatus,
  SignInInput,
  SignUpInput,
  SignUpResult,
} from './src/types/auth';

export {
  ALL_CATEGORIES,
  categoriesForType,
  DEBT_COLLECTION_CATEGORY,
  DEBT_PAYMENT_CATEGORY,
  EXPENSE_CATEGORIES,
  INCOME_CATEGORIES,
  TRANSFER_CATEGORY,
} from './src/types/category';

export type { Category, ExpenseCategory, IncomeCategory } from './src/types/category';

/* ── Accounts Payable / Receivable ───────────────────────────────────────── */
export {
  compareDebts,
  daysUntilDue,
  DEBT_DIRECTIONS,
  DUE_SOON_DAYS,
  debtProgress,
  debtStatus,
  defaultSettlementCategory,
  directionForSettlementType,
  isDebtDirection,
  isOverdue,
  normaliseDebt,
  normaliseDebts,
  settlementTypeFor,
  toDebtInsert,
  toDebtUpdate,
} from './src/types/debt';

export type {
  CreateDebtInput,
  Debt,
  DebtStatus,
  DebtTotals,
  DebtTotalsByCurrency,
  DebtWithActivity,
  ListDebtsOptions,
  SettleDebtInput,
  StoredDebt,
  UpdateDebtInput,
} from './src/types/debt';

export {
  closeDebt,
  createDebt,
  deleteDebt,
  getDebtById,
  getDebts,
  getDebtSettlements,
  getDebtTotals,
  getOpenDebts,
  reopenDebt,
  settleDebt,
  updateDebt,
} from './src/services/debt';

export { createLedgerControls, hasLedgerFilters } from './src/types/ledger';
export type { LedgerControls, LedgerScope } from './src/types/ledger';

/* ── Supabase client ─────────────────────────────────────────────────────── */
export {
  configureSupabase,
  createMemoryStorage,
  createWebStorage,
  getSupabase,
  isReactNative,
  isSupabaseConfigured,
  registerStorageAdapter,
  resetSupabaseClient,
  resolveStorageAdapter,
  supabase,
} from './src/config/supabase';

export type { StorageAdapter, SupabaseConfig } from './src/config/supabase';

/**
 * Re-exported so a consumer can annotate its own helpers without taking a
 * direct dependency on `@supabase/supabase-js`.
 */
export type { Session, SupabaseClient, User } from '@supabase/supabase-js';

/* ── Services ────────────────────────────────────────────────────────────── */
export {
  getCurrentUser,
  getCustomSession,
  mapSession,
  mapUser,
  MIN_PASSWORD_LENGTH,
  onAuthStateChange,
  requireUserId,
  sendPasswordReset,
  signIn,
  signOut,
  signUp,
  updatePassword,
  updateProfile,
} from './src/services/auth';

export {
  createWallet,
  deleteWallet,
  getWalletById,
  getWalletRow,
  getWallets,
  getWalletTotals,
  updateWallet,
} from './src/services/wallet';

export {
  addTransaction,
  buildTransactionQuery,
  deleteTransaction,
  getCategoryBreakdown,
  getMonthlySummary,
  getRecentTransactions,
  getTransactionsByWallet,
  getTransactionsInRange,
  getTransactionsPage,
  isTransferLeg,
  MAX_PAGE_SIZE,
  searchPattern,
  transferBetweenWallets,
  updateTransaction,
} from './src/services/transaction';

export type {
  AddTransactionInput,
  CategoryBreakdownEntry,
  MonthlySummary,
  Transaction,
  TransactionPage,
  TransactionQuery,
  TransactionQueryInput,
  TransactionQueryOptions,
  TransferInput,
  TransferResult,
  UpdateTransactionInput,
} from './src/services/transaction';

/* ── React hooks ─────────────────────────────────────────────────────────── */
export { useAuth } from './src/hooks/useAuth';
export type { SignUpOutcome, UseAuthResult } from './src/hooks/useAuth';

export { useWallets } from './src/hooks/useWallets';
export type { UseWalletsOptions, UseWalletsResult } from './src/hooks/useWallets';

export { useDebts } from './src/hooks/useDebts';
export type { UseDebtsOptions, UseDebtsResult } from './src/hooks/useDebts';

export { useDebouncedValue } from './src/hooks/useDebouncedValue';

export { useTransactions } from './src/hooks/useTransactions';
export {
  DEFAULT_LEDGER_PAGE_SIZE,
  mergeTransactionPages,
} from './src/hooks/useTransactions';
export type {
  UseTransactionsOptions,
  UseTransactionsResult,
} from './src/hooks/useTransactions';

/* ── Utilities ───────────────────────────────────────────────────────────── */
export {
  formatAmount,
  formatCurrency,
  formatSignedCurrency,
  parseAmount,
  toDecimalString,
} from './src/utils/currency';
export type { FormatCurrencyOptions } from './src/utils/currency';

export {
  addMonths,
  daysInMonth,
  endOfMonth,
  formatDate,
  formatRelative,
  groupByDay,
  isSameDay,
  isSameMonth,
  isValidDate,
  startOfDay,
  startOfMonth,
  toDate,
  toDateBound,
  toISODate,
  toISOString,
  toMonthKey,
  toMonthStart,
} from './src/utils/date';
export type { DateInput, DateStyle } from './src/utils/date';

export {
  AppError,
  describeError,
  ERROR_COPY,
  isAppError,
  toAppError,
  unwrap,
} from './src/utils/errors';
export type { AppErrorCode } from './src/utils/errors';

export {
  assertCurrencyCode,
  assertEmail,
  assertIsoDate,
  assertNonEmptyString,
  assertNonNegativeAmount,
  assertOptionalString,
  assertPassword,
  assertPositiveAmount,
  assertUuid,
  isUuid,
} from './src/utils/validate';
