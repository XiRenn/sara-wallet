/**
 * Supabase database types.
 *
 * Hand-written to match `supabase/migrations/0001_init.sql` in the same shape
 * the Supabase CLI generates, so you can later replace this file with the
 * output of `supabase gen types typescript --linked` without touching a single
 * import elsewhere in the monorepo.
 *
 * Money columns are `numeric(18,2)` in PostgreSQL. PostgREST serialises them
 * as JSON numbers, so they arrive here as `number`. The service layer still
 * runs every value through `toNumber()` as a belt-and-braces measure, because
 * a handful of PostgREST/Supabase versions have shipped numerics as strings.
 */

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

/** Mirrors the `public.transaction_type` PostgreSQL enum. */
export type TransactionType = 'INCOME' | 'EXPENSE';

/** Mirrors the `public.debt_direction` PostgreSQL enum. */
export type DebtDirection = 'RECEIVABLE' | 'PAYABLE';

export interface Database {
  public: {
    Tables: {
      wallets: {
        Row: {
          id: string;
          user_id: string;
          name: string;
          currency: string;
          balance: number;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          name: string;
          currency?: string;
          balance?: number;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string;
          name?: string;
          currency?: string;
          balance?: number;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'wallets_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: false;
            referencedRelation: 'users';
            referencedColumns: ['id'];
          },
        ];
      };
      transactions: {
        Row: {
          id: string;
          wallet_id: string;
          user_id: string;
          type: TransactionType;
          amount: number;
          category: string;
          note: string | null;
          date: string;
          created_at: string;
          /** Non-null when this row is one leg of a wallet transfer. */
          transfer_group_id: string | null;
          /**
           * Non-null when this row settles a debt. A settlement is real money
           * and moves the wallet balance like any other row; the obligation it
           * discharges is tracked separately. `on delete set null`, so removing
           * a debt never erases the money it moved.
           */
          debt_id: string | null;
        };
        Insert: {
          id?: string;
          wallet_id: string;
          user_id: string;
          type: TransactionType;
          amount: number;
          category?: string;
          note?: string | null;
          date?: string;
          created_at?: string;
          transfer_group_id?: string | null;
          debt_id?: string | null;
        };
        Update: {
          id?: string;
          wallet_id?: string;
          user_id?: string;
          type?: TransactionType;
          amount?: number;
          category?: string;
          note?: string | null;
          date?: string;
          created_at?: string;
          transfer_group_id?: string | null;
          debt_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'transactions_wallet_id_fkey';
            columns: ['wallet_id'];
            isOneToOne: false;
            referencedRelation: 'wallets';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'transactions_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: false;
            referencedRelation: 'users';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'transactions_debt_id_fkey';
            columns: ['debt_id'];
            isOneToOne: false;
            referencedRelation: 'debts';
            referencedColumns: ['id'];
          },
        ];
      };
      debts: {
        Row: {
          id: string;
          user_id: string;
          direction: DebtDirection;
          /** Free text: a person, a shop, an institution. */
          counterparty: string;
          currency: string;
          principal: number;
          note: string | null;
          issued_on: string;
          /** Null means no agreed due date — never "overdue". */
          due_on: string | null;
          /** Set when the obligation is discharged or written off. */
          closed_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          direction: DebtDirection;
          counterparty: string;
          currency?: string;
          principal: number;
          note?: string | null;
          issued_on?: string;
          due_on?: string | null;
          closed_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string;
          direction?: DebtDirection;
          counterparty?: string;
          currency?: string;
          principal?: number;
          note?: string | null;
          issued_on?: string;
          due_on?: string | null;
          closed_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'debts_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: false;
            referencedRelation: 'users';
            referencedColumns: ['id'];
          },
        ];
      };
    };
    Views: {
      /**
       * `debts` plus its derived money. `Insert` / `Update` / `Relationships`
       * are present because supabase-js's `GenericView` requires all four keys —
       * omit one and the whole `Database` type stops satisfying `GenericSchema`,
       * which degrades every `from()` call in the codebase to `never` with an
       * error pointing at an unrelated file. The view is read-only in practice:
       * write to `debts`.
       */
      debt_balances: {
        Row: {
          id: string;
          user_id: string;
          direction: DebtDirection;
          counterparty: string;
          currency: string;
          principal: number;
          note: string | null;
          issued_on: string;
          due_on: string | null;
          closed_at: string | null;
          created_at: string;
          updated_at: string;
          /** Sum of every settlement posted against this debt. */
          settled: number;
          /** `principal - settled`. Derived, never stored. */
          outstanding: number;
        };
        Insert: {
          id?: string;
          user_id?: string;
          direction?: DebtDirection;
          counterparty?: string;
          currency?: string;
          principal?: number;
          note?: string | null;
          issued_on?: string;
          due_on?: string | null;
          closed_at?: string | null;
          created_at?: string;
          updated_at?: string;
          settled?: number;
          outstanding?: number;
        };
        Update: {
          id?: string;
          user_id?: string;
          direction?: DebtDirection;
          counterparty?: string;
          currency?: string;
          principal?: number;
          note?: string | null;
          issued_on?: string;
          due_on?: string | null;
          closed_at?: string | null;
          created_at?: string;
          updated_at?: string;
          settled?: number;
          outstanding?: number;
        };
        Relationships: [];
      };
    };
    Functions: {
      get_monthly_summary: {
        Args: {
          p_wallet_id?: string | null;
          p_month?: string | null;
        };
        Returns: {
          income: number;
          expense: number;
          net: number;
          transaction_count: number;
          /** Money moved out by transfer. Excluded from income/expense. */
          transfer_volume: number;
        }[];
      };
      /**
       * Writes both legs of a transfer atomically and returns the shared
       * `transfer_group_id`.
       */
      transfer_between_wallets: {
        Args: {
          p_from_wallet_id: string;
          p_to_wallet_id: string;
          p_amount: number;
          p_note?: string | null;
          p_date?: string | null;
        };
        Returns: string;
      };
      /**
       * Per-currency AP/AR totals. One row per currency that has at least one
       * open, partly-unsettled debt — a fully settled currency is absent, not
       * present as a zero row.
       */
      get_debt_totals: {
        Args: Record<string, never>;
        Returns: {
          currency: string;
          receivable_outstanding: number;
          payable_outstanding: number;
          receivable_overdue: number;
          payable_overdue: number;
          open_count: number;
        }[];
      };
    };
    Enums: {
      transaction_type: TransactionType;
      debt_direction: DebtDirection;
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
}

/* -------------------------------------------------------------------------- */
/* Convenience helpers — identical to the ones the Supabase CLI emits.         */
/* -------------------------------------------------------------------------- */

export type Tables<T extends keyof Database['public']['Tables']> =
  Database['public']['Tables'][T]['Row'];

export type TablesInsert<T extends keyof Database['public']['Tables']> =
  Database['public']['Tables'][T]['Insert'];

export type TablesUpdate<T extends keyof Database['public']['Tables']> =
  Database['public']['Tables'][T]['Update'];

export type Views<T extends keyof Database['public']['Views']> =
  Database['public']['Views'][T]['Row'];

export type Enums<T extends keyof Database['public']['Enums']> =
  Database['public']['Enums'][T];

/** Row shapes of the tables, aliased for readability. */
export type WalletRow = Tables<'wallets'>;
export type TransactionRow = Tables<'transactions'>;
export type DebtRow = Tables<'debts'>;

export type WalletInsert = TablesInsert<'wallets'>;
export type TransactionInsert = TablesInsert<'transactions'>;
export type DebtInsert = TablesInsert<'debts'>;

export type WalletUpdate = TablesUpdate<'wallets'>;
export type TransactionUpdate = TablesUpdate<'transactions'>;
export type DebtUpdate = TablesUpdate<'debts'>;

/** Row shape of the derived `debt_balances` view. */
export type DebtBalanceRow = Views<'debt_balances'>;
